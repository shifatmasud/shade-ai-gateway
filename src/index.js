const WINDOW_SECONDS = 60;
const RATE_LIMIT_LUA = "local requests = redis.call('INCR', KEYS[1])\nif requests == 1 then redis.call('EXPIRE', KEYS[1], ARGV[4]) end\nlocal tokens = redis.call('INCRBY', KEYS[2], ARGV[3])\nif tokens == tonumber(ARGV[3]) then redis.call('EXPIRE', KEYS[2], ARGV[4]) end\nlocal allowed = 1\nif tonumber(ARGV[1]) > 0 and requests > tonumber(ARGV[1]) then allowed = 0 end\nif tonumber(ARGV[2]) > 0 and tokens > tonumber(ARGV[2]) then allowed = 0 end\nlocal ttl = math.max(redis.call('TTL', KEYS[1]), redis.call('TTL', KEYS[2]))\nreturn {allowed, requests, tokens, ttl}";

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", ...headers } });
}
function cors(request, env) {
  const origin = request.headers.get("Origin");
  const allowed = (env.ALLOWED_ORIGINS || "").split(",").map(x => x.trim()).filter(Boolean);
  const headers = { "access-control-allow-methods": "GET, POST, OPTIONS", "access-control-allow-headers": "Authorization, Content-Type", "access-control-max-age": "86400", vary: "Origin" };
  if (origin && (allowed.includes("*") || allowed.includes(origin))) headers["access-control-allow-origin"] = origin;
  return headers;
}
async function sha256(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join("");
}
async function redis(env, command) {
  if (!env.UPSTASH_REDIS_REST_URL || !env.UPSTASH_REDIS_REST_TOKEN) throw new Error("Redis is not configured");
  const response = await fetch(env.UPSTASH_REDIS_REST_URL.replace(/\/$/, ""), {
    method: "POST",
    headers: { authorization: "Bearer " + env.UPSTASH_REDIS_REST_TOKEN, "content-type": "application/json" },
    body: JSON.stringify(command)
  });
  if (!response.ok) throw new Error("Redis request failed: " + response.status);
  const payload = await response.json();
  if (payload.error) throw new Error(payload.error);
  return payload.result;
}
async function checkLimit(env, scope, rpm, tpm, estimatedTokens) {
  const minute = Math.floor(Date.now() / 60000);
  const prefix = "shade-gateway:rl:" + scope + ":" + minute;
  const result = await redis(env, ["EVAL", RATE_LIMIT_LUA, "2", prefix + ":rpm", prefix + ":tpm", String(rpm || 0), String(tpm || 0), String(estimatedTokens), String(WINDOW_SECONDS)]);
  return { allowed: Number(result[0]) === 1, requests: Number(result[1]), tokens: Number(result[2]), retryAfter: Math.max(1, Number(result[3]) || WINDOW_SECONDS) };
}
function estimateTokens(body) {
  return Math.max(1, Math.ceil(JSON.stringify(body).length / 4));
}
function getProviders(env) {
  let providers;
  try { providers = JSON.parse(env.PROVIDERS || "[]"); } catch { throw new Error("PROVIDERS must be valid JSON"); }
  if (!Array.isArray(providers)) throw new Error("PROVIDERS must be an array");
  return providers.filter(p => p.enabled !== false && p.baseUrl && p.apiKeyEnv && env[p.apiKeyEnv]);
}
function candidatesFor(providers, requestedModel) {
  return providers.filter(p => p.models && Object.prototype.hasOwnProperty.call(p.models, requestedModel)).sort((a, b) => (a.priority ?? 100) - (b.priority ?? 100));
}
function retryable(status) { return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500; }
async function callProvider(provider, body, env) {
  const upstreamBody = { ...body, model: provider.models[body.model] };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Number(provider.timeoutMs || env.PROVIDER_TIMEOUT_MS || 45000));
  try {
    return await fetch(provider.baseUrl.replace(/\/$/, "") + "/chat/completions", {
      method: "POST",
      headers: { authorization: "Bearer " + env[provider.apiKeyEnv], "content-type": "application/json" },
      body: JSON.stringify(upstreamBody),
      signal: controller.signal
    });
  } finally { clearTimeout(timeout); }
}
async function handleChat(request, env) {
  if (!env.GATEWAY_API_KEY) return json({ error: { message: "Gateway authentication is not configured", type: "configuration_error" } }, 503);
  if (request.headers.get("Authorization") !== "Bearer " + env.GATEWAY_API_KEY) return json({ error: { message: "Invalid API key", type: "authentication_error" } }, 401);
  let body;
  try { body = await request.json(); } catch { return json({ error: { message: "Request body must be valid JSON", type: "invalid_request_error" } }, 400); }
  if (!body || !Array.isArray(body.messages) || typeof body.model !== "string") return json({ error: { message: "Expected model and messages[]", type: "invalid_request_error" } }, 400);
  let providers;
  try { providers = getProviders(env); } catch (error) { return json({ error: { message: error.message, type: "configuration_error" } }, 500); }
  const candidates = candidatesFor(providers, body.model);
  if (!candidates.length) return json({ error: { message: "No enabled provider is configured for model alias: " + body.model, type: "model_not_found" } }, 404);
  const estimatedTokens = estimateTokens(body) + Number(body.max_tokens || body.max_completion_tokens || 1024);
  const clientId = await sha256(env.GATEWAY_API_KEY);
  try {
    const limit = await checkLimit(env, "client:" + clientId, Number(env.CLIENT_RPM || 60), Number(env.CLIENT_TPM || 100000), estimatedTokens);
    if (!limit.allowed) return json({ error: { message: "Gateway rate limit exceeded", type: "rate_limit_error", retry_after: limit.retryAfter } }, 429, { "retry-after": String(limit.retryAfter) });
  } catch {
    return json({ error: { message: "Rate-limit service unavailable", type: "service_unavailable" } }, 503);
  }
  const failures = [];
  for (const provider of candidates) {
    try {
      const limit = await checkLimit(env, "provider:" + provider.id, Number(provider.limits?.rpm || 0), Number(provider.limits?.tpm || 0), estimatedTokens);
      if (!limit.allowed) { failures.push({ provider: provider.id, reason: "local_rate_limit", retryAfter: limit.retryAfter }); continue; }
      const upstream = await callProvider(provider, body, env);
      if (upstream.ok) {
        const headers = new Headers(upstream.headers);
        headers.set("x-ai-gateway-provider", provider.id);
        headers.set("x-ai-gateway-model", body.model);
        return new Response(upstream.body, { status: upstream.status, headers });
      }
      const detail = await upstream.text();
      failures.push({ provider: provider.id, status: upstream.status });
      if (!retryable(upstream.status)) return json({ error: { message: "Provider rejected the request", type: "upstream_error", provider: provider.id, status: upstream.status, details: detail.slice(0, 1200) } }, upstream.status);
    } catch (error) {
      failures.push({ provider: provider.id, reason: error.name === "AbortError" ? "timeout" : "network_error" });
    }
  }
  return json({ error: { message: "All configured providers are unavailable or rate-limited", type: "provider_exhausted", attempts: failures } }, 503, { "retry-after": "10" });
}
export default {
  async fetch(request, env) {
    const headers = cors(request, env);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });
    const url = new URL(request.url);
    if (url.pathname === "/health" && request.method === "GET") {
      let redisStatus = "unconfigured";
      try { await redis(env, ["PING"]); redisStatus = "ok"; } catch { redisStatus = "error"; }
      let providerCount = 0;
      try { providerCount = getProviders(env).length; } catch {}
      return json({ status: redisStatus === "ok" ? "ok" : "degraded", redis: redisStatus, configuredProviders: providerCount }, redisStatus === "ok" ? 200 : 503, headers);
    }
    if (url.pathname === "/v1/models" && request.method === "GET") {
      if (!env.GATEWAY_API_KEY || request.headers.get("Authorization") !== "Bearer " + env.GATEWAY_API_KEY) return json({ error: { message: "Invalid API key", type: "authentication_error" } }, 401, headers);
      let providers = [];
      try { providers = getProviders(env); } catch {}
      const aliases = [...new Set(providers.flatMap(p => Object.keys(p.models || {})))];
      return json({ object: "list", data: aliases.map(id => ({ id, object: "model", owned_by: "shade-gateway" })) }, 200, headers);
    }
    if (url.pathname === "/v1/chat/completions" && request.method === "POST") {
      const response = await handleChat(request, env);
      const merged = new Headers(response.headers);
      for (const [key, value] of Object.entries(headers)) merged.set(key, value);
      return new Response(response.body, { status: response.status, headers: merged });
    }
    return json({ error: { message: "Not found", type: "not_found" } }, 404, headers);
  }
};
