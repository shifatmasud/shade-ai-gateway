import { REGISTRY_KEY, json, error, readLimited, digest, redis, parseRegistry, assertPublicHost, decryptSecret, adminRoutes, setCooldown, validateBaseUrl } from "./storage.js";

const ROTATION_KEY = "shade-ai-gateway:key-rotation:v1";

const MAX_BODY_BYTES = 1048576;

function cors(request, env) {
    const origin = request.headers.get("Origin");
    const allowed = String(env.ALLOWED_ORIGINS || "").split(",").map(v => v.trim()).filter(Boolean);
    const headers = { "access-control-allow-methods": "GET, POST, PUT, DELETE, OPTIONS", "access-control-allow-headers": "Authorization, Content-Type", "access-control-expose-headers": "x-ai-gateway-model, retry-after, x-upstream-status", "access-control-max-age": "86400", vary: "Origin" };
    if (origin && (allowed.includes("*") || allowed.includes(origin)))
        headers["access-control-allow-origin"] = origin;
    return headers;
}

async function isClientAuthorized(request, env) {
    const secret = env.GATEWAY_API_KEY;
    if (typeof secret !== "string" || secret.length < 32 || secret === env.ADMIN_SECRET || secret === env.PROVIDER_ENCRYPTION_KEY)
        return null;
    const received = request.headers.get("Authorization") || "";
    const expected = `Bearer ${secret}`;
    const [a, b] = await Promise.all([digest(received), digest(expected)]);
    let diff = 0;
    for (let i = 0; i < a.length; i++)
        diff |= a[i] ^ b[i];
    return diff === 0 && received.length === expected.length;
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
        const models = new Map();
        for (const key of reg.keys) {
            for (const entry of Array.isArray(key.models) ? key.models : []) {
                const model = typeof entry === "string"
                    ? { id: entry.replace(/^models\//, ""), object: "model", owned_by: "google" }
                    : entry && typeof entry === "object" && typeof entry.id === "string" ? entry : null;
                if (!model?.id) continue;
                const previous = models.get(model.id) || {};
                models.set(model.id, { ...previous, ...model });
            }
        }
        return json({ object: "list", data: [...models.values()] });
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
    body.model = body.model.replace(/^models\//, "");
    let reg;
    try {
        reg = parseRegistry(await redis(env, ["GET", REGISTRY_KEY]));
    }
    catch {
        return error("Key storage unavailable.", "service_unavailable", 503);
    }
    if (!reg.keys.length)
        return error("No Google AI Studio keys are configured.", "provider_not_configured", 503);
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
        catch (cause) {
            console.error(JSON.stringify({ event: "provider_key_decrypt_failed", provider: "google", keyId: key.id, message: String(cause?.message || cause).slice(0, 160) }));
            continue;
        }
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), Math.max(1000, Math.min(120000, Number(env.PROVIDER_TIMEOUT_MS) || 45000)));
        let response;
        try {
            await assertPublicHost(new URL(reg.baseUrl).hostname);
            response = await fetch(`${reg.baseUrl}/chat/completions`, { method: "POST", headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify(body), signal: controller.signal, redirect: "manual" });
        }
        catch (cause) {
            clearTimeout(timer);
            console.error(JSON.stringify({ event: "upstream_fetch_failed", provider: "google", model: body.model, requestId: request.headers.get("cf-ray") || crypto.randomUUID(), errorName: cause?.name || "Error", message: String(cause?.message || cause).replace(/[A-Za-z0-9_-]{32,}/g, "[redacted]").slice(0, 200) }));
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
        const safeDetail = String(detail).replace(/[A-Za-z0-9_-]{32,}/g, "[redacted]").replace(/\s+/g, " ").slice(0, 300);
        console.error(JSON.stringify({ event: "upstream_http_error", provider: "google", model: body.model, status: response.status, statusText: response.statusText, requestId: request.headers.get("cf-ray") || crypto.randomUUID(), contentType: response.headers.get("content-type") || "", retryAfter: response.headers.get("retry-after") || "", detail: safeDetail }));
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
        let upstreamMessage = "";
        try {
            const payload = JSON.parse(detail);
            upstreamMessage = payload?.error?.message || payload?.error?.status || payload?.message || "";
        }
        catch {
            upstreamMessage = detail;
        }
        upstreamMessage = String(upstreamMessage).replace(/[A-Za-z0-9_-]{32,}/g, "[redacted]").replace(/\s+/g, " ").slice(0, 240);
        return error(`Google AI Studio returned HTTP ${response.status}${upstreamMessage ? `: ${upstreamMessage}` : "."}`, "upstream_error", 502, { "x-upstream-status": String(response.status) });
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
        if (url.pathname.startsWith("/v1/")) {
            const authorized = await isClientAuthorized(request, env);
            if (authorized === null)
                return error("Client API key is not configured correctly.", "configuration_error", 503, cors(request, env));
            if (!authorized)
                return error("A valid API key is required.", "authentication_error", 401, { ...cors(request, env), "www-authenticate": "Bearer" });
        }
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
            headers.set("content-security-policy", "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
            headers.set("permissions-policy", "camera=(), microphone=(), geolocation=()");
            headers.set("cache-control", "no-cache");
            return new Response(response.body, { status: response.status, headers });
        }
        return error("Dashboard assets are not configured.", "configuration_error", 503);
    }
};

export { validateBaseUrl, parseRegistry, isQuotaFailure, retryAfterSeconds };
