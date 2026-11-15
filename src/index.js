import { REGISTRY_KEY, json, error, readLimited, digest, redis, parseRegistry, assertPublicHost, decryptSecret, adminRoutes, setCooldown, validateBaseUrl } from "./storage.js";
import { handleChat } from "./chat.js";

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
