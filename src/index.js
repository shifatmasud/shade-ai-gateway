import { REGISTRY_KEY, json, error, readLimited, bytesToBase64, digest, redis, parseRegistry, assertPublicHost, decryptSecret, adminRoutes, setCooldown, validateBaseUrl } from "./storage.js";

const ROTATION_KEY = "shade-ai-gateway:key-rotation:v1";

const RATE_LIMIT_LUA = `local requests = redis.call('INCR', KEYS[1])
if requests == 1 then redis.call('EXPIRE', KEYS[1], ARGV[3]) end
local tokens = redis.call('INCRBY', KEYS[2], ARGV[2])
if tokens == tonumber(ARGV[2]) then redis.call('EXPIRE', KEYS[2], ARGV[3]) end
local allowed = 1
if tonumber(ARGV[1]) > 0 and requests > tonumber(ARGV[1]) then allowed = 0 end
if tonumber(ARGV[4]) > 0 and tokens > tonumber(ARGV[4]) then allowed = 0 end
local ttl = math.max(redis.call('TTL', KEYS[1]), redis.call('TTL', KEYS[2]))
return {allowed, requests, tokens, ttl}`;

const MAX_BODY_BYTES = 1048576;

function cors(request, env) {
    const origin = request.headers.get("Origin");
    const allowed = String(env.ALLOWED_ORIGINS || "").split(",").map(v => v.trim()).filter(Boolean);
    const headers = { "access-control-allow-methods": "GET, POST, PUT, DELETE, OPTIONS", "access-control-allow-headers": "Authorization, Content-Type", "access-control-expose-headers": "x-ai-gateway-model, retry-after", "access-control-max-age": "86400", vary: "Origin" };
    if (origin && (allowed.includes("*") || allowed.includes(origin)))
        headers["access-control-allow-origin"] = origin;
    return headers;
}

function estimateTokens(body) { return Math.min(250000, Math.max(1, Math.ceil(JSON.stringify(body).length / 4)) + Math.max(1, Number(body.max_tokens ?? body.max_completion_tokens ?? 1024) || 1024)); }

async function enforceClientLimit(env, request, body) {
    const ip = request.headers.get("CF-Connecting-IP") || "unknown-client";
    const scope = bytesToBase64(await digest(ip)).replace(/[^a-zA-Z0-9]/g, "").slice(0, 32);
    const minute = Math.floor(Date.now() / 60000);
    const prefix = `shade-ai-gateway:client:${scope}:${minute}`;
    const result = await redis(env, ["EVAL", RATE_LIMIT_LUA, "2", `${prefix}:rpm`, `${prefix}:tpm`, String(Math.max(1, Number(env.CLIENT_RPM) || 20)), String(estimateTokens(body)), "60", String(Math.max(1000, Number(env.CLIENT_TPM) || 40000))]);
    return { allowed: Number(result[0]) === 1, retryAfter: Math.max(1, Number(result[3]) || 60) };
}

function retryAfterSeconds(value) {
    if (!value)
        return 60;
    const n = Number(value);
    if (Number.isFinite(n) && n >= 0)
        return Math.max(1, Math.min(3600, Math.ceil(n)));
    const date = Date.parse(value);
    return Number.isFinite(date) ? Math.max(1, Math.min(3600, Math.ceil((date - Date.now()) / 1000))) : 60;
}

function isQuotaFailure(status, text) {
    if (status === 429)
        return true;
    if (status !== 403)
        return false;
    return /(quota|resource_exhausted|rate.?limit|billing|exceeded.*(limit|quota)|limit.*exceeded)/i.test(text || "");
}

async function handleModels(request, env) {
    try {
        const reg = parseRegistry(await redis(env, ["GET", REGISTRY_KEY]));
        const models = [...new Set(reg.keys.flatMap(key => key.models || []))];
        return json({ object: "list", data: models.map(id => ({ id, object: "model", owned_by: "shade-google-pool" })) });
    }
    catch {
        return error("Model registry unavailable.", "service_unavailable", 503);
    }
}

async function handleChat(request, env) {
    if (Number(request.headers.get("content-length") || 0) > MAX_BODY_BYTES)
        return error("Request body too large.", "invalid_request_error", 413);
    let body;
    try {
        const raw = await readLimited(request, MAX_BODY_BYTES);
        if (raw === null)
            return error("Request body too large.", "invalid_request_error", 413);
        body = JSON.parse(raw);
    }
    catch {
        return error("Request body must be valid JSON.", "invalid_request_error", 400);
    }
    if (!body || !Array.isArray(body.messages) || typeof body.model !== "string" || !body.model.trim())
        return error("Expected a model name and messages array.", "invalid_request_error", 400);
    let reg;
    try {
        reg = parseRegistry(await redis(env, ["GET", REGISTRY_KEY]));
    }
    catch {
        return error("Key storage unavailable.", "service_unavailable", 503);
    }
    if (!reg.keys.length)
        return error("No Google AI Studio keys are configured.", "provider_not_configured", 503);
    try {
        const limit = await enforceClientLimit(env, request, body);
        if (!limit.allowed)
            return error("Gateway rate limit exceeded for this client IP.", "rate_limit_error", 429, { "retry-after": String(limit.retryAfter) });
    }
    catch {
        return error("Rate-limit service unavailable.", "service_unavailable", 503);
    }
    const now = Date.now();
    const ready = reg.keys.filter(key => (key.cooldownUntil || 0) <= now);
    if (!ready.length) {
        const next = Math.min(...reg.keys.map(key => key.cooldownUntil || now + 60000));
        return error("All Google AI Studio keys are cooling down. Retry later.", "provider_exhausted", 503, { "retry-after": String(Math.max(1, Math.ceil((next - now) / 1000))) });
    }
    let start = 0;
    try {
        start = Number(await redis(env, ["INCR", ROTATION_KEY])) % ready.length;
    }
    catch {
        start = Math.floor(Math.random() * ready.length);
    }
    const ordered = [...ready.slice(start), ...ready.slice(0, start)];
    for (const key of ordered) {
        let apiKey;
        try {
            apiKey = await decryptSecret(key.encryptedKey, env, key.id, Boolean(key.legacy));
        }
        catch {
            continue;
        }
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), Math.max(1000, Math.min(120000, Number(env.PROVIDER_TIMEOUT_MS) || 45000)));
        let response;
        try {
            await assertPublicHost(new URL(reg.baseUrl).hostname);
            response = await fetch(`${reg.baseUrl}/chat/completions`, { method: "POST", headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify(body), signal: controller.signal, redirect: "manual" });
        }
        catch {
            clearTimeout(timer);
            return error("Upstream connection failed; request was not retried to avoid duplicate usage.", "upstream_error", 502);
        }
        clearTimeout(timer);
        if (response.ok && response.body) {
            const headers = new Headers();
            for (const name of ["content-type", "cache-control"]) {
                const value = response.headers.get(name);
                if (value)
                    headers.set(name, value);
            }
            headers.set("x-ai-gateway-model", body.model);
            headers.set("cache-control", "no-store");
            return new Response(response.body, { status: response.status, headers });
        }
        let detail = "";
        try {
            detail = await response.clone().text();
        }
        catch { }
        if (isQuotaFailure(response.status, detail)) {
            const cooldown = response.status === 429 ? retryAfterSeconds(response.headers.get("retry-after")) : 900;
            try {
                await setCooldown(env, key.id, cooldown);
            }
            catch {
                return error("Key rotation state unavailable.", "service_unavailable", 503);
            }
            continue;
        }
        return error("Google AI Studio rejected the request. Check the model name, API access, or request format.", "upstream_error", 502);
    }
    const latest = parseRegistry(await redis(env, ["GET", REGISTRY_KEY]));
    const future = latest.keys.map(key => key.cooldownUntil || 0).filter(value => value > Date.now());
    const retry = future.length ? Math.max(1, Math.ceil((Math.min(...future) - Date.now()) / 1000)) : 60;
    return error("Every available Google AI Studio key is rate-limited or out of quota.", "provider_exhausted", 503, { "retry-after": String(retry) });
}

async function health(env) {
    try {
        await redis(env, ["PING"]);
        const reg = parseRegistry(await redis(env, ["GET", REGISTRY_KEY]));
        return json({ status: "ok", redis: "ok", configuredKeys: reg.keys.length });
    }
    catch {
        return json({ status: "degraded", redis: "unavailable" }, 503);
    }
}

export default {
    async fetch(request, env) {
        const url = new URL(request.url);
        if (request.method === "OPTIONS") {
            if (url.pathname.startsWith("/admin"))
                return new Response(null, { status: 204, headers: { "cache-control": "no-store", vary: "Origin" } });
            return new Response(null, { status: 204, headers: cors(request, env) });
        }
        if (url.pathname === "/health" && request.method === "GET")
            return health(env);
        if (url.pathname.startsWith("/admin/"))
            return adminRoutes(request, env, url);
        if (url.pathname === "/v1/models" && request.method === "GET") {
            const response = await handleModels(request, env);
            const headers = new Headers(response.headers);
            for (const [key, value] of Object.entries(cors(request, env)))
                headers.set(key, value);
            return new Response(response.body, { status: response.status, headers });
        }
        if (url.pathname === "/v1/chat/completions" && request.method === "POST") {
            const response = await handleChat(request, env);
            const headers = new Headers(response.headers);
            for (const [k, v] of Object.entries(cors(request, env)))
                headers.set(k, v);
            headers.set("x-content-type-options", "nosniff");
            return new Response(response.body, { status: response.status, headers });
        }
        if (url.pathname.startsWith("/v1/"))
            return error("Not found.", "not_found", 404, cors(request, env));
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
        return error("Dashboard assets are not configured.", "configuration_error", 503);
    }
};

export { validateBaseUrl, parseRegistry, isQuotaFailure, retryAfterSeconds };
