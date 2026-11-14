const REGISTRY_KEY = "shade-ai-gateway:providers:v1";

const CAS_LUA = `local current = redis.call('GET', KEYS[1])
if ARGV[1] == '__SHADE_MISSING__' then
  if current then return 0 end
elseif current ~= ARGV[1] then
  return 0
end
redis.call('SET', KEYS[1], ARGV[2])
return 1`;

const DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/openai";

function json(data, status = 200, headers = {}) {
    return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers } });
}

function error(message, type, status, headers = {}) { return json({ error: { message, type } }, status, headers); }

async function readLimited(request, max) {
    const reader = request.body?.getReader();
    if (!reader)
        return "";
    const chunks = [];
    let size = 0;
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done)
                break;
            size += value.byteLength;
            if (size > max) {
                await reader.cancel().catch(() => { });
                return null;
            }
            chunks.push(value);
        }
    }
    finally {
        reader.releaseLock();
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return new TextDecoder().decode(bytes);
}

function bytesToBase64(bytes) { let binary = ""; for (const b of bytes)
    binary += String.fromCharCode(b); return btoa(binary); }

function base64ToBytes(value) { return Uint8Array.from(atob(value), c => c.charCodeAt(0)); }

async function digest(value) { return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))); }

async function encryptionKey(env) {
    if (!env.PROVIDER_ENCRYPTION_KEY || env.PROVIDER_ENCRYPTION_KEY.length < 32)
        throw new Error("Encryption is not configured");
    return crypto.subtle.importKey("raw", await digest(env.PROVIDER_ENCRYPTION_KEY), { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

async function encryptSecret(value, env, id) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const data = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: new TextEncoder().encode(`shade-google-key:${id}:v1`) }, await encryptionKey(env), new TextEncoder().encode(value));
    return `v1.${bytesToBase64(iv)}.${bytesToBase64(new Uint8Array(data))}`;
}

async function decryptSecret(value, env, id, legacy = false) {
    const [version, iv, data] = String(value || "").split(".");
    if (version !== "v1" || !iv || !data)
        throw new Error("Invalid encrypted key");
    const aad = legacy ? `shade-provider:${id}:v1` : `shade-google-key:${id}:v1`;
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: base64ToBytes(iv), additionalData: new TextEncoder().encode(aad) }, await encryptionKey(env), base64ToBytes(data));
    return new TextDecoder().decode(plain);
}

async function redis(env, command) {
    if (!env.UPSTASH_REDIS_REST_URL || !env.UPSTASH_REDIS_REST_TOKEN)
        throw new Error("Redis is not configured");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    try {
        const response = await fetch(env.UPSTASH_REDIS_REST_URL.replace(/\/$/, ""), { method: "POST", headers: { authorization: `Bearer ${env.UPSTASH_REDIS_REST_TOKEN}`, "content-type": "application/json" }, body: JSON.stringify(command), signal: controller.signal, redirect: "manual" });
        if (!response.ok)
            throw new Error("Redis unavailable");
        const payload = await response.json();
        if (payload.error)
            throw new Error("Redis unavailable");
        return payload.result;
    }
    finally {
        clearTimeout(timer);
    }
}

function parseRegistry(raw) {
    if (!raw)
        return { version: 1, baseUrl: DEFAULT_BASE_URL, keys: [], legacyProviders: [] };
    const data = JSON.parse(raw);
    if (data?.version !== 1)
        throw new Error("Invalid key registry");
    if (Array.isArray(data.keys) && typeof data.baseUrl === "string")
        return data;
    if (Array.isArray(data.providers)) {
        const google = data.providers.filter(item => {
            try {
                return new URL(item.baseUrl).hostname === "generativelanguage.googleapis.com" && item.encryptedKey;
            }
            catch {
                return false;
            }
        });
        const chosenBase = google[0]?.baseUrl || DEFAULT_BASE_URL;
        const migrated = google.filter(item => item.baseUrl === chosenBase).map(item => ({ id: item.id, encryptedKey: item.encryptedKey, models: item.modelIds || [], cooldownUntil: 0, legacy: true }));
        const preserved = data.providers.filter(item => !migrated.some(key => key.id === item.id));
        return { version: 1, baseUrl: chosenBase, keys: migrated, legacyProviders: preserved };
    }
    throw new Error("Invalid key registry");
}

async function getRegistry(env) { return { raw: await redis(env, ["GET", REGISTRY_KEY]) }; }

async function updateRegistry(env, updater) {
    for (let i = 0; i < 8; i++) {
        const raw = await redis(env, ["GET", REGISTRY_KEY]);
        const current = parseRegistry(raw);
        const next = await updater(structuredClone(current));
        const serialized = JSON.stringify(next);
        if (new TextEncoder().encode(serialized).length > 900000)
            throw new Error("Key pool is too large");
        const saved = await redis(env, ["EVAL", CAS_LUA, "1", REGISTRY_KEY, raw == null ? "__SHADE_MISSING__" : String(raw), serialized]);
        if (Number(saved) === 1)
            return next;
    }
    throw new Error("Key pool is busy; retry");
}

function isPublicIPv4(value) {
    const p = String(value).split(".").map(Number);
    if (p.length !== 4 || p.some(n => !Number.isInteger(n) || n < 0 || n > 255))
        return false;
    const [a, b, c] = p;
    if (a === 0 || a === 10 || a === 127 || a >= 224)
        return false;
    if (a === 100 && b >= 64 && b <= 127)
        return false;
    if (a === 169 && b === 254)
        return false;
    if (a === 172 && b >= 16 && b <= 31)
        return false;
    if (a === 192 && (b === 0 || b === 168 || (b === 88 && c === 99)))
        return false;
    if (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100)))
        return false;
    if (a === 203 && b === 0 && c === 113)
        return false;
    return true;
}

function isPublicIPv6(value) {
    const host = String(value).toLowerCase();
    if (!/^[0-9a-f:]+$/.test(host) || host.includes("::ffff:"))
        return false;
    const first = parseInt(host.split(":")[0] || "0", 16);
    return first >= 0x2000 && first <= 0x3fff && !host.startsWith("2001:db8:") && !host.startsWith("2002:") && !host.startsWith("3fff:");
}

async function assertPublicHost(hostname) {
    const lookups = await Promise.all(["A", "AAAA"].map(async (type) => {
        const query = new URL("https://cloudflare-dns.com/dns-query");
        query.searchParams.set("name", hostname);
        query.searchParams.set("type", type);
        const response = await fetch(query.toString(), { headers: { accept: "application/dns-json" }, redirect: "manual", signal: AbortSignal.timeout(3000) });
        if (!response.ok)
            throw new Error("DNS safety check unavailable");
        const payload = await response.json();
        if (payload.Status !== 0 && payload.Status !== 3)
            throw new Error("DNS safety check unavailable");
        const recordType = type === "A" ? 1 : 28;
        return (payload.Answer || []).filter(item => Number(item.type) === recordType).map(item => item.data);
    }));
    const addresses = lookups.flat();
    if (!addresses.length || addresses.some(address => address.includes(":") ? !isPublicIPv6(address) : !isPublicIPv4(address)))
        throw new Error("Provider hostname must resolve only to public IP addresses");
}

function validateBaseUrl(value) {
    if (typeof value !== "string" || value.length > 500)
        return null;
    try {
        const url = new URL(value.trim());
        if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || !url.hostname.includes(".") || url.hostname.endsWith("."))
            return null;
        if (url.port && url.port !== "443")
            return null;
        const host = url.hostname.toLowerCase();
        if (/(^|\.)(localhost|local|internal|lan|metadata|instance-data|test|invalid|example)(\.|$)/.test(host))
            return null;
        if (/^(\d{1,3}\.){3}\d{1,3}$/.test(host) || host.includes(":"))
            return null;
        url.pathname = url.pathname.replace(/\/+$/, "");
        return url.toString().replace(/\/$/, "");
    }
    catch {
        return null;
    }
}

function safeKey(key, index) { return { id: key.id, label: `Key ${index + 1}`, configured: Boolean(key.encryptedKey), cooldownUntil: key.cooldownUntil || 0, status: (key.cooldownUntil || 0) > Date.now() ? "cooldown" : "ready" }; }

async function isAdmin(request, env, url) {
    if (request.headers.get("Origin") && request.headers.get("Origin") !== url.origin)
        return false;
    const secret = env.ADMIN_SECRET;
    if (typeof secret !== "string" || secret.length < 32 || secret === env.PROVIDER_ENCRYPTION_KEY)
        return false;
    const received = request.headers.get("Authorization") || "";
    const [a, b] = await Promise.all([digest(received), digest(`Bearer ${secret}`)]);
    let diff = 0;
    for (let i = 0; i < a.length; i++)
        diff |= a[i] ^ b[i];
    return diff === 0 && received.length === `Bearer ${secret}`.length;
}

async function discoverModels(baseUrl, apiKey) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    try {
        const response = await fetch(`${baseUrl}/models`, { headers: { authorization: `Bearer ${apiKey}`, accept: "application/json" }, signal: controller.signal, redirect: "manual" });
        if (!response.ok)
            return [];
        const payload = await response.json();
        const rows = Array.isArray(payload.data) ? payload.data : Array.isArray(payload.models) ? payload.models : [];
        return [...new Set(rows.map(row => String(row.id || row.name || "").replace(/^models\//, "")).filter(Boolean))].slice(0, 500);
    }
    catch {
        return [];
    }
    finally {
        clearTimeout(timer);
    }
}

async function adminRoutes(request, env, url) {
    if (!await isAdmin(request, env, url))
        return error("Private manager link is invalid.", "authentication_error", 401);
    if (request.method === "GET" && url.pathname === "/admin/settings") {
        try {
            const reg = parseRegistry(await redis(env, ["GET", REGISTRY_KEY]));
            return json({ baseUrl: reg.baseUrl, keys: reg.keys.map(safeKey) });
        }
        catch {
            return error("Key storage is unavailable.", "service_unavailable", 503);
        }
    }
    if (request.method === "PUT" && url.pathname === "/admin/settings") {
        let body;
        try {
            body = JSON.parse(await readLimited(request, 16384));
        }
        catch {
            return error("Invalid JSON.", "invalid_request_error", 400);
        }
        const baseUrl = validateBaseUrl(body?.baseUrl);
        if (!baseUrl)
            return error("Enter a public HTTPS base URL.", "invalid_request_error", 400);
        try {
            await assertPublicHost(new URL(baseUrl).hostname);
            await updateRegistry(env, reg => ({ ...reg, baseUrl }));
            return json({ saved: true, baseUrl });
        }
        catch {
            return error("Could not save the base URL.", "service_unavailable", 503);
        }
    }
    if (request.method === "POST" && url.pathname === "/admin/keys") {
        let body;
        try {
            body = JSON.parse(await readLimited(request, 16384));
        }
        catch {
            return error("Invalid JSON.", "invalid_request_error", 400);
        }
        const apiKey = typeof body?.apiKey === "string" ? body.apiKey.trim() : "";
        if (!apiKey || apiKey.length > 8192)
            return error("Enter a valid Google AI Studio API key.", "invalid_request_error", 400);
        try {
            const reg = parseRegistry(await redis(env, ["GET", REGISTRY_KEY]));
            const id = crypto.randomUUID();
            const encryptedKey = await encryptSecret(apiKey, env, id);
            await assertPublicHost(new URL(reg.baseUrl).hostname);
            const models = await discoverModels(reg.baseUrl, apiKey);
            const next = await updateRegistry(env, current => ({ ...current, keys: [...current.keys, { id, encryptedKey, models, cooldownUntil: 0 }] }));
            return json({ key: safeKey(next.keys[next.keys.length - 1], next.keys.length - 1), discoveredModels: models.length }, 201);
        }
        catch {
            return error("Could not securely save this key.", "service_unavailable", 503);
        }
    }
    const keyMatch = url.pathname.match(/^\/admin\/keys\/([a-z0-9-]{1,80})$/i);
    if (request.method === "DELETE" && keyMatch) {
        try {
            let removed = false;
            const next = await updateRegistry(env, reg => { const keys = reg.keys.filter(key => key.id !== keyMatch[1]); removed = keys.length !== reg.keys.length; return { ...reg, keys }; });
            if (!removed)
                return error("Key not found.", "not_found", 404);
            return json({ deleted: true, remaining: next.keys.length });
        }
        catch {
            return error("Could not remove this key.", "service_unavailable", 503);
        }
    }
    return error("Not found.", "not_found", 404);
}

async function setCooldown(env, id, seconds) {
    const until = Date.now() + Math.max(60, Math.min(3600, seconds)) * 1000;
    await updateRegistry(env, reg => ({ ...reg, keys: reg.keys.map(key => key.id === id ? { ...key, cooldownUntil: Math.max(key.cooldownUntil || 0, until) } : key) }));
}

export { REGISTRY_KEY, json, error, readLimited, bytesToBase64, digest, redis, parseRegistry, updateRegistry, assertPublicHost, decryptSecret, adminRoutes, setCooldown, validateBaseUrl };
