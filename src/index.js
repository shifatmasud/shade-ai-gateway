const WINDOW_SECONDS = 60;
const REGISTRY_KEY = "shade-ai-gateway:providers:v1";
const MAX_REGISTRY_BYTES = 1_000_000;
const MAX_REQUEST_BYTES = 1_048_576;
const RATE_LIMIT_LUA = `local requests = redis.call('INCR', KEYS[1])
if requests == 1 then redis.call('EXPIRE', KEYS[1], ARGV[4]) end
local tokens = redis.call('INCRBY', KEYS[2], ARGV[3])
if tokens == tonumber(ARGV[3]) then redis.call('EXPIRE', KEYS[2], ARGV[4]) end
local allowed = 1
if tonumber(ARGV[1]) > 0 and requests > tonumber(ARGV[1]) then allowed = 0 end
if tonumber(ARGV[2]) > 0 and tokens > tonumber(ARGV[2]) then allowed = 0 end
local ttl = math.max(redis.call('TTL', KEYS[1]), redis.call('TTL', KEYS[2]))
return {allowed, requests, tokens, ttl}`;
const CAS_LUA = `local current = redis.call('GET', KEYS[1])
if ARGV[1] == '__SHADE_MISSING__' then
  if current then return 0 end
elseif current ~= ARGV[1] then
  return 0
end
redis.call('SET', KEYS[1], ARGV[2])
return 1`;
const ALIASES = ["default", "fast", "reasoning"];
const FORBIDDEN_HOST_SUFFIXES = [".localhost", ".local", ".localdomain", ".internal", ".lan", ".home", ".home.arpa", ".corp", ".intranet", ".private", ".arpa", ".test", ".invalid", ".example", ".onion", ".nip.io", ".sslip.io", ".xip.io", ".localtest.me"];
const ROUTE_HINTS = {
  fast: /(^|[-_/])(mini|flash|haiku|fast|instant|lite)([-_/]|$)/i,
  reasoning: /(reason|think|deepseek[-_/]?r1|(^|[-_/])o[1-9]([-_/]|$)|opus|pro)/i
};

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers }
  });
}

function publicError(message, type, status, headers = {}) {
  return json({ error: { message, type } }, status, headers);
}


async function readTextLimited(request, maxBytes) {
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

function getCorsHeaders(request, env) {
  const origin = request.headers.get("Origin");
  const allowed = String(env.ALLOWED_ORIGINS || "").split(",").map(x => x.trim()).filter(Boolean);
  const headers = {
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "Authorization, Content-Type",
    "access-control-max-age": "86400",
    "access-control-expose-headers": "x-ai-gateway-provider, x-ai-gateway-model, retry-after",
    vary: "Origin"
  };
  if (origin && (allowed.includes("*") || allowed.includes(origin))) headers["access-control-allow-origin"] = origin;
  return headers;
}

function bytesToBase64(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value) {
  const binary = atob(value);
  return Uint8Array.from(binary, char => char.charCodeAt(0));
}

async function sha256Bytes(value) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}

async function constantTimeEqual(left, right) {
  if (typeof left !== "string" || typeof right !== "string") return false;
  const [a, b] = await Promise.all([sha256Bytes(left), sha256Bytes(right)]);
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a[i] ^ b[i];
  return difference === 0 && left.length === right.length;
}

function distinctSecretsReady(env) {
  const values = [env.ADMIN_SECRET, env.GATEWAY_API_KEY, env.PROVIDER_ENCRYPTION_KEY];
  return values.every(value => typeof value === "string" && value.length >= 32) && new Set(values).size === values.length;
}

async function authorized(request, secret) {
  if (typeof secret !== "string" || secret.length < 32) return false;
  return constantTimeEqual(request.headers.get("Authorization") || "", `Bearer ${secret}`);
}

async function encryptionKey(env) {
  const secret = env.PROVIDER_ENCRYPTION_KEY;
  if (!distinctSecretsReady(env)) throw new Error("Secrets are missing or not separate");
  const raw = await sha256Bytes(secret);
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

async function encryptApiKey(apiKey, env, providerId) {
  const key = await encryptionKey(env);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const additionalData = new TextEncoder().encode(`shade-provider:${providerId}:v1`);
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData }, key, new TextEncoder().encode(apiKey));
  return `v1.${bytesToBase64(iv)}.${bytesToBase64(new Uint8Array(ciphertext))}`;
}

async function decryptApiKey(envelope, env, providerId) {
  const parts = String(envelope || "").split(".");
  if (parts.length !== 3 || parts[0] !== "v1") throw new Error("Stored provider secret is invalid");
  const key = await encryptionKey(env);
  const additionalData = new TextEncoder().encode(`shade-provider:${providerId}:v1`);
  const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv: base64ToBytes(parts[1]), additionalData }, key, base64ToBytes(parts[2]));
  return new TextDecoder().decode(plaintext);
}

async function redisCommand(env, command) {
  const url = env.UPSTASH_REDIS_REST_URL;
  const token = env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new Error("Redis is not configured");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch(String(url).replace(/\/$/, ""), {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(command),
      signal: controller.signal,
      redirect: "manual"
    });
    if (!response.ok) throw new Error("Redis request failed");
    const payload = await response.json();
    if (!payload || payload.error) throw new Error("Redis command failed");
    return payload.result;
  } finally {
    clearTimeout(timer);
  }
}

function parseRegistry(raw) {
  if (raw == null || raw === "") return [];
  let decoded;
  try { decoded = JSON.parse(raw); } catch { throw new Error("Provider registry is invalid"); }
  if (!decoded || decoded.version !== 1 || !Array.isArray(decoded.providers)) throw new Error("Provider registry is invalid");
  return decoded.providers;
}

async function registryRaw(env) {
  return await redisCommand(env, ["GET", REGISTRY_KEY]);
}

async function saveRegistry(env, prior, providers) {
  const next = JSON.stringify({ version: 1, providers });
  if (new TextEncoder().encode(next).length > MAX_REGISTRY_BYTES) throw new Error("Provider registry is too large");
  const result = await redisCommand(env, [
    "EVAL", CAS_LUA, "1", REGISTRY_KEY,
    prior == null ? "__SHADE_MISSING__" : String(prior),
    next
  ]);
  return Number(result) === 1;
}

function normalizedBaseUrl(value) {
  return String(value || "").trim().replace(/\/+$/, "");
}

function isIpLiteral(hostname) {
  const host = String(hostname || "").replace(/^\[|\]$/g, "");
  if (host.includes(":")) return true;
  if (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(host)) return true;
  if (/^(?:0x[0-9a-f]+|\d+)$/i.test(host)) return true;
  return false;
}

function validateBaseUrl(value) {
  if (typeof value !== "string" || value.length > 500) return null;
  let url;
  try { url = new URL(value.trim()); } catch { return null; }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) return null;
  if (!url.hostname || isIpLiteral(url.hostname) || (url.port && url.port !== "443")) return null;
  const hostname = url.hostname.toLowerCase();
  if (!hostname.includes(".") || hostname.endsWith(".")) return null;
  if (FORBIDDEN_HOST_SUFFIXES.some(suffix => hostname.endsWith(suffix)) || /(^|\.)(localhost|metadata|instance-data)(\.|$)/.test(hostname)) return null;
  if (/\s|[\u0000-\u001f]/.test(value)) return null;
  url.pathname = url.pathname.replace(/\/+$/, "");
  return url.toString().replace(/\/$/, "");
}

const publicDnsCache = new Map();

function isPublicIPv4(value) {
  const parts = String(value).split(".").map(Number);
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a, b, c] = parts;
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && (b === 0 || b === 168 || (b === 88 && c === 99))) return false;
  if (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  return true;
}

function ipv6Words(value) {
  let input = String(value).toLowerCase();
  if (input.includes(".")) {
    const cut = input.lastIndexOf(":");
    const ipv4 = input.slice(cut + 1).split(".").map(Number);
    if (ipv4.length !== 4 || ipv4.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return null;
    const tail = `${((ipv4[0] << 8) | ipv4[1]).toString(16)}:${((ipv4[2] << 8) | ipv4[3]).toString(16)}`;
    input = `${input.slice(0, cut + 1)}${tail}`;
  }
  const sides = input.split("::");
  if (sides.length > 2) return null;
  const left = sides[0] ? sides[0].split(":") : [];
  const right = sides.length === 2 && sides[1] ? sides[1].split(":") : [];
  const zeros = 8 - left.length - right.length;
  if ((sides.length === 1 && zeros !== 0) || (sides.length === 2 && zeros < 1)) return null;
  const words = [...left, ...Array(zeros).fill("0"), ...right].map(part => /^[0-9a-f]{1,4}$/.test(part) ? parseInt(part, 16) : NaN);
  return words.length === 8 && words.every(Number.isInteger) ? words : null;
}

function isPublicIPv6(value) {
  const words = ipv6Words(value);
  if (!words) return false;
  const first = words[0];
  if (first < 0x2000 || first > 0x3fff) return false;
  if (first === 0x2001 && (words[1] === 0x0db8 || words[1] === 0x0002 || words[1] === 0x0010)) return false;
  if (first === 0x2002 || (first === 0x3fff && words[1] <= 0x000f)) return false;
  return true;
}

async function fetchDnsAnswer(hostname, type, requestSignal) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2500);
  const onAbort = () => controller.abort();
  requestSignal?.addEventListener("abort", onAbort, { once: true });
  if (requestSignal?.aborted) controller.abort();
  const query = new URL("https://cloudflare-dns.com/dns-query");
  query.searchParams.set("name", hostname);
  query.searchParams.set("type", type);
  try {
    const response = await fetch(query.toString(), {
      headers: { accept: "application/dns-json" },
      signal: controller.signal,
      redirect: "manual"
    });
    if (!response.ok) throw new Error("DNS lookup failed");
    const payload = await response.json();
    if (payload.Status !== 0 && payload.Status !== 3) throw new Error("DNS lookup failed");
    const recordType = type === "A" ? 1 : 28;
    return (payload.Answer || []).filter(answer => Number(answer.type) === recordType).map(answer => answer.data);
  } finally {
    clearTimeout(timer);
    requestSignal?.removeEventListener("abort", onAbort);
  }
}

async function assertPublicHost(hostname, requestSignal) {
  const cached = publicDnsCache.get(hostname);
  if (cached && cached.expiresAt > Date.now()) return cached.promise;
  const promise = (async () => {
    const records = await Promise.all([fetchDnsAnswer(hostname, "A", requestSignal), fetchDnsAnswer(hostname, "AAAA", requestSignal)]);
    const addresses = records.flat();
    if (!addresses.length || addresses.some(address => address.includes(":") ? !isPublicIPv6(address) : !isPublicIPv4(address))) {
      throw new Error("Provider hostname did not resolve only to public IP addresses");
    }
    return true;
  })();
  publicDnsCache.set(hostname, { expiresAt: Date.now() + 10_000, promise });
  try {
    return await promise;
  } catch (error) {
    publicDnsCache.delete(hostname);
    if (error.message === "Provider hostname did not resolve only to public IP addresses") throw error;
    throw new Error("Public DNS safety check unavailable");
  }
}

async function assertPublicBaseUrl(baseUrl, requestSignal) {
  const url = new URL(baseUrl);
  await assertPublicHost(url.hostname, requestSignal);
}

function validateProviderInput(input, { allowEmptyKey = false } = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return { error: "Enter a provider name, base URL, and API key." };
  const permitted = new Set(["name", "baseUrl", "apiKey"]);
  if (Object.keys(input).some(key => !permitted.has(key))) return { error: "Only provider name, base URL, and API key are accepted." };
  const name = typeof input.name === "string" ? input.name.trim() : "";
  const baseUrl = validateBaseUrl(input.baseUrl);
  const apiKey = typeof input.apiKey === "string" ? input.apiKey.trim() : "";
  if (!name || name.length > 80 || /[\u0000-\u001f\u007f]/.test(name)) return { error: "Provider name must be 1–80 characters." };
  if (!baseUrl) return { error: "Use a public HTTPS base URL (no IP address, local host, credentials, query, or fragment)." };
  if (apiKey.length > 8192 || (!allowEmptyKey && !apiKey)) return { error: "Enter a provider API key (up to 8,192 characters)." };
  return { value: { name, baseUrl, apiKey } };
}

function providerSlug(name) {
  const base = name.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 32) || "provider";
  const suffix = crypto.randomUUID().replace(/-/g, "").slice(0, 8);
  return `${base}-${suffix}`;
}

function extractModelIds(payload) {
  let rows = [];
  if (Array.isArray(payload?.data)) rows = payload.data;
  else if (Array.isArray(payload?.models)) rows = payload.models;
  else if (Array.isArray(payload?.result?.models)) rows = payload.result.models;
  return [...new Set(rows.map(row => typeof row === "string" ? row : (row?.id || row?.name)).filter(id => typeof id === "string" && id.length > 0 && id.length <= 200))].slice(0, 500);
}

async function discoverModels(baseUrl, apiKey) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4500);
  try {
    const response = await fetch(`${baseUrl}/models`, {
      method: "GET",
      headers: { authorization: `Bearer ${apiKey}`, accept: "application/json" },
      signal: controller.signal,
      redirect: "manual"
    });
    if (!response.ok) return [];
    return extractModelIds(await response.json());
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

function deriveRoutes(modelIds) {
  if (!modelIds.length) return {};
  const routes = { default: modelIds[0] };
  routes.fast = modelIds.find(id => ROUTE_HINTS.fast.test(id)) || modelIds[0];
  const reasoning = modelIds.find(id => ROUTE_HINTS.reasoning.test(id));
  if (reasoning) routes.reasoning = reasoning;
  return routes;
}

function safeProviderView(provider) {
  return {
    id: provider.id,
    name: provider.name,
    baseUrl: provider.baseUrl,
    keyConfigured: Boolean(provider.encryptedKey)
  };
}

function isDuplicate(providers, name, baseUrl, exceptId = null) {
  const normalizedName = name.trim().toLocaleLowerCase();
  const normalizedUrl = normalizedBaseUrl(baseUrl).toLowerCase();
  return providers.some(provider => provider.id !== exceptId && (
    provider.name.trim().toLocaleLowerCase() === normalizedName || normalizedBaseUrl(provider.baseUrl).toLowerCase() === normalizedUrl
  ));
}

async function mutateRegistry(env, updater) {
  for (let attempt = 0; attempt < 6; attempt++) {
    const prior = await registryRaw(env);
    const providers = parseRegistry(prior);
    const nextProviders = await updater(providers);
    const saved = await saveRegistry(env, prior, nextProviders);
    if (saved) return nextProviders;
  }
  throw new Error("Registry is busy; retry the change");
}

async function handleAdmin(request, env, url) {
  const origin = request.headers.get("Origin");
  if (origin && origin !== url.origin) return publicError("Admin access is same-origin only.", "forbidden", 403);
  if (!distinctSecretsReady(env)) return publicError("Admin security is not configured.", "configuration_error", 503);
  if (!await authorized(request, env.ADMIN_SECRET)) return publicError("Admin authentication failed.", "authentication_error", 401, { "www-authenticate": "Bearer" });
  if (request.method === "GET" && url.pathname === "/admin/providers") {
    try {
      const providers = parseRegistry(await registryRaw(env));
      return json({ providers: providers.map(safeProviderView) });
    } catch {
      return publicError("Provider storage is unavailable.", "service_unavailable", 503);
    }
  }

  const isCollection = url.pathname === "/admin/providers";
  const match = url.pathname.match(/^\/admin\/providers\/([a-z0-9-]{1,80})$/i);
  if ((request.method === "POST" && isCollection) || (request.method === "PUT" && match)) {
    let input;
    const contentLength = Number(request.headers.get("Content-Length") || 0);
    if (contentLength > 16_384) return publicError("Request is too large.", "invalid_request_error", 413);
    try {
      const rawBody = await readTextLimited(request, 16_384);
      if (rawBody === null) return publicError("Request is too large.", "invalid_request_error", 413);
      input = JSON.parse(rawBody);
    } catch { return publicError("Request body must be valid JSON.", "invalid_request_error", 400); }
    const validation = validateProviderInput(input, { allowEmptyKey: request.method === "PUT" });
    if (validation.error) return publicError(validation.error, "invalid_request_error", 400);
    const clean = validation.value;
    try {
      await assertPublicBaseUrl(clean.baseUrl);
      if (request.method === "POST") {
        const id = providerSlug(clean.name);
        const encryptedKey = await encryptApiKey(clean.apiKey, env, id);
        const modelIds = await discoverModels(clean.baseUrl, clean.apiKey);
        const provider = { id, name: clean.name, baseUrl: clean.baseUrl, encryptedKey, modelIds, routes: deriveRoutes(modelIds) };
        const providers = await mutateRegistry(env, current => {
          if (isDuplicate(current, clean.name, clean.baseUrl)) throw new Error("A provider with this name or URL already exists");
          return [...current, provider];
        });
        return json({ provider: safeProviderView(providers.find(item => item.id === provider.id)) }, 201);
      }

      const id = match[1];
      let updated;
      const providers = await mutateRegistry(env, async current => {
        const old = current.find(item => item.id === id);
        if (!old) throw new Error("Provider was not found");
        if (isDuplicate(current, clean.name, clean.baseUrl, id)) throw new Error("A provider with this name or URL already exists");
        const key = clean.apiKey || await decryptApiKey(old.encryptedKey, env, old.id);
        const encryptedKey = clean.apiKey ? await encryptApiKey(clean.apiKey, env, id) : old.encryptedKey;
        const changedTarget = clean.baseUrl !== old.baseUrl || Boolean(clean.apiKey);
        const modelIds = changedTarget ? await discoverModels(clean.baseUrl, key) : old.modelIds || [];
        updated = { ...old, name: clean.name, baseUrl: clean.baseUrl, encryptedKey, modelIds, routes: deriveRoutes(modelIds) };
        return current.map(item => item.id === id ? updated : item);
      });
      const saved = providers.find(item => item.id === id);
      return json({ provider: safeProviderView(saved) });
    } catch (error) {
      if (error.message === "Provider hostname did not resolve only to public IP addresses") return publicError("Provider base URL must resolve only to public Internet addresses.", "invalid_request_error", 400);
      if (error.message === "Public DNS safety check unavailable") return publicError("Could not verify the provider host safely; retry later.", "service_unavailable", 503);
      if (error.message === "Provider was not found") return publicError("Provider was not found.", "not_found", 404);
      if (error.message === "A provider with this name or URL already exists") return publicError("A provider with this name or URL already exists.", "conflict", 409);
      if (error.message === "Registry is busy; retry the change") return publicError("Provider storage is busy; retry the change.", "conflict", 409);
      return publicError("Provider storage is unavailable.", "service_unavailable", 503);
    }
  }

  if (request.method === "DELETE" && match) {
    const id = match[1];
    try {
      let found = false;
      const providers = await mutateRegistry(env, current => {
        found = current.some(item => item.id === id);
        return current.filter(item => item.id !== id);
      });
      if (!found) return publicError("Provider was not found.", "not_found", 404);
      return json({ deleted: true, remaining: providers.length });
    } catch {
      return publicError("Provider storage is unavailable.", "service_unavailable", 503);
    }
  }
  return publicError("Not found.", "not_found", 404);
}

function estimateTokens(body) {
  const input = Math.max(1, Math.ceil(JSON.stringify(body).length / 4));
  const output = Number(body.max_tokens ?? body.max_completion_tokens ?? 1024);
  const boundedOutput = Number.isFinite(output) ? Math.max(1, Math.min(output, 200_000)) : 1024;
  return Math.min(250_000, input + boundedOutput);
}

async function checkLimit(env, scope, rpm, tpm, estimatedTokens) {
  if ((Number(rpm) || 0) <= 0 && (Number(tpm) || 0) <= 0) return { allowed: true, retryAfter: 1 };
  const minute = Math.floor(Date.now() / 60_000);
  const prefix = `shade-ai-gateway:rl:v2:${scope}:${minute}`;
  const result = await redisCommand(env, [
    "EVAL", RATE_LIMIT_LUA, "2", `${prefix}:rpm`, `${prefix}:tpm`,
    String(Math.max(0, Number(rpm) || 0)), String(Math.max(0, Number(tpm) || 0)), String(estimatedTokens), String(WINDOW_SECONDS)
  ]);
  return { allowed: Number(result[0]) === 1, retryAfter: Math.max(1, Number(result[3]) || WINDOW_SECONDS) };
}

function isRetryable(status) {
  return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
}

function retryAfterSeconds(value) {
  if (!value) return 0;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(3600, Math.ceil(seconds));
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, Math.min(3600, Math.ceil((date - Date.now()) / 1000))) : 0;
}

function selectCandidates(providers, requestedModel) {
  const normalized = requestedModel.toLowerCase();
  if (ALIASES.includes(normalized)) {
    return providers
      .filter(provider => provider.routes?.[normalized])
      .map(provider => ({ provider, routedModel: provider.routes[normalized] }));
  }
  const exact = providers.filter(provider => (provider.modelIds || []).includes(requestedModel));
  const selected = exact.length ? exact : providers;
  return selected.map(provider => ({ provider, routedModel: requestedModel }));
}

async function callProvider(provider, body, model, env, requestSignal) {
  const controller = new AbortController();
  const timeoutMs = Math.max(1000, Math.min(120_000, Number(env.PROVIDER_TIMEOUT_MS) || 45_000));
  let timer = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort();
  const cleanup = () => { clearTimeout(timer); requestSignal?.removeEventListener("abort", onAbort); };
  const refreshTimeout = () => { clearTimeout(timer); timer = setTimeout(() => controller.abort(), timeoutMs); };
  requestSignal?.addEventListener("abort", onAbort, { once: true });
  if (requestSignal?.aborted) controller.abort();
  try {
    await assertPublicBaseUrl(provider.baseUrl, requestSignal);
    const upstream = await fetch(`${provider.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${provider.apiKey}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ ...body, model }),
      signal: controller.signal,
      redirect: "manual"
    });
    if (!upstream.ok || !upstream.body) {
      if (upstream.body) await upstream.body.cancel().catch(() => {});
      cleanup();
      return new Response(null, { status: upstream.status, headers: upstream.headers });
    }
    const reader = upstream.body.getReader();
    const bodyStream = new ReadableStream({
      async pull(streamController) {
        try {
          refreshTimeout();
          const { done, value } = await reader.read();
          if (done) {
            streamController.close();
            cleanup();
          } else {
            refreshTimeout();
            streamController.enqueue(value);
          }
        } catch (error) {
          streamController.error(error);
          cleanup();
        }
      },
      async cancel(reason) {
        try { await reader.cancel(reason); } finally { controller.abort(); cleanup(); }
      }
    });
    return new Response(bodyStream, { status: upstream.status, headers: upstream.headers });
  } catch (error) {
    cleanup();
    throw error;
  }
}

function safeUpstreamResponse(upstream, provider, requestedModel) {
  const headers = new Headers();
  for (const name of ["content-type", "cache-control", "retry-after"]) {
    const value = upstream.headers.get(name);
    if (value) headers.set(name, value);
  }
  headers.set("x-ai-gateway-provider", provider.id);
  headers.set("x-ai-gateway-model", requestedModel);
  if ((upstream.headers.get("content-type") || "").includes("text/event-stream")) headers.set("x-accel-buffering", "no");
  return new Response(upstream.body, { status: upstream.status, headers });
}

async function handleChat(request, env) {
  if (!distinctSecretsReady(env)) return publicError("Gateway security is not configured.", "configuration_error", 503);
  if (!await authorized(request, env.GATEWAY_API_KEY)) return publicError("Invalid API key.", "authentication_error", 401);
  const declaredLength = Number(request.headers.get("Content-Length") || 0);
  if (declaredLength > MAX_REQUEST_BYTES) return publicError("Request body is too large.", "invalid_request_error", 413);
  let body;
  try {
    const text = await readTextLimited(request, MAX_REQUEST_BYTES);
    if (text === null) return publicError("Request body is too large.", "invalid_request_error", 413);
    body = JSON.parse(text);
  } catch {
    return publicError("Request body must be valid JSON.", "invalid_request_error", 400);
  }
  if (!body || typeof body !== "object" || Array.isArray(body) || !Array.isArray(body.messages) || typeof body.model !== "string" || !body.model.trim()) {
    return publicError("Expected a model name and a messages array.", "invalid_request_error", 400);
  }
  let providers;
  try {
    const records = parseRegistry(await registryRaw(env));
    providers = await Promise.all(records.map(async provider => ({ ...provider, apiKey: await decryptApiKey(provider.encryptedKey, env, provider.id) })));
  } catch {
    return publicError("Provider storage is unavailable.", "service_unavailable", 503);
  }
  const candidates = selectCandidates(providers, body.model);
  if (!candidates.length) return publicError("No configured provider supports this model route.", "model_not_found", 404);

  const estimatedTokens = estimateTokens(body);
  let clientId;
  try {
    const digest = await sha256Bytes(env.GATEWAY_API_KEY);
    clientId = bytesToBase64(digest).replace(/[^a-zA-Z0-9]/g, "").slice(0, 32);
    const limit = await checkLimit(env, `client:${clientId}`, Number(env.CLIENT_RPM ?? 60), Number(env.CLIENT_TPM ?? 100_000), estimatedTokens);
    if (!limit.allowed) return publicError("Gateway rate limit exceeded.", "rate_limit_error", 429, { "retry-after": String(limit.retryAfter) });
  } catch {
    return publicError("Rate-limit service is unavailable.", "service_unavailable", 503);
  }

  let attempts = 0;
  let maxRetryAfter = 0;
  for (let index = 0; index < candidates.length; index++) {
    const { provider, routedModel } = candidates[index];
    attempts++;
    try {
      const providerLimit = await checkLimit(env, `provider:${provider.id}`, Number(env.PROVIDER_RPM ?? 0), Number(env.PROVIDER_TPM ?? 0), estimatedTokens);
      if (!providerLimit.allowed) {
        maxRetryAfter = Math.max(maxRetryAfter, providerLimit.retryAfter);
        continue;
      }
      const upstream = await callProvider(provider, body, routedModel, env, request.signal);
      if (upstream.ok) return safeUpstreamResponse(upstream, provider, body.model);
      if (!isRetryable(upstream.status)) {
        return publicError("Provider rejected the request.", "upstream_error", 502, { "x-ai-gateway-provider": provider.id });
      }
      maxRetryAfter = Math.max(maxRetryAfter, retryAfterSeconds(upstream.headers.get("retry-after")));
    } catch {
      // Do not include exception messages: they may contain URLs, headers, or secrets.
    }
    if (index + 1 < candidates.length) {
      const base = Math.min(400, 80 * (2 ** Math.min(index, 3)));
      await new Promise(resolve => setTimeout(resolve, base + Math.floor(Math.random() * 60)));
    }
  }
  return json({ error: { message: "All eligible providers are unavailable or rate-limited.", type: "provider_exhausted", attempts } }, 503, { "retry-after": String(maxRetryAfter || 5) });
}

async function handleModels(request, env) {
  if (!distinctSecretsReady(env)) return publicError("Gateway security is not configured.", "configuration_error", 503);
  if (!await authorized(request, env.GATEWAY_API_KEY)) return publicError("Invalid API key.", "authentication_error", 401);
  try {
    const providers = parseRegistry(await registryRaw(env));
    const aliases = ALIASES.filter(alias => providers.some(provider => Boolean(provider.routes?.[alias])));
    const ids = [...new Set(providers.flatMap(provider => provider.modelIds || []))];
    const names = [...new Set([...aliases, ...ids])];
    return json({ object: "list", data: names.map(id => ({ id, object: "model", owned_by: "shade-gateway" })) });
  } catch {
    return publicError("Provider storage is unavailable.", "service_unavailable", 503);
  }
}

async function health(env) {
  try {
    await redisCommand(env, ["PING"]);
    const providers = parseRegistry(await registryRaw(env));
    return json({ status: "ok", redis: "ok", configuredProviders: providers.length });
  } catch {
    return json({ status: "degraded", redis: "unavailable" }, 503);
  }
}

function withHeaders(response, additionalHeaders) {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(additionalHeaders)) headers.set(name, value);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const adminPath = url.pathname === "/admin" || url.pathname.startsWith("/admin/");
    if (request.method === "OPTIONS") {
      if (adminPath) return new Response(null, { status: 204, headers: { "cache-control": "no-store", vary: "Origin" } });
      return new Response(null, { status: 204, headers: getCorsHeaders(request, env) });
    }
    if (url.pathname === "/health" && request.method === "GET") return withHeaders(await health(env), getCorsHeaders(request, env));
    if (adminPath) return withHeaders(await handleAdmin(request, env, url), { "x-content-type-options": "nosniff", "cache-control": "no-store" });
    if (url.pathname === "/v1/models" && request.method === "GET") return withHeaders(await handleModels(request, env), getCorsHeaders(request, env));
    if (url.pathname === "/v1/chat/completions" && request.method === "POST") return withHeaders(await handleChat(request, env), getCorsHeaders(request, env));
    if (url.pathname.startsWith("/v1/")) return withHeaders(publicError("Not found.", "not_found", 404), getCorsHeaders(request, env));
    if (env.ASSETS) {
      const response = await env.ASSETS.fetch(request);
      const headers = new Headers(response.headers);
      headers.set("x-content-type-options", "nosniff");
      headers.set("referrer-policy", "no-referrer");
      headers.set("content-security-policy", "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
      headers.set("permissions-policy", "camera=(), microphone=(), geolocation=()");
      headers.set("cache-control", "no-cache");
      return new Response(response.body, { status: response.status, headers });
    }
    return publicError("Dashboard assets are not configured.", "configuration_error", 503);
  }
};

export { deriveRoutes, extractModelIds, selectCandidates, validateBaseUrl, validateProviderInput };
