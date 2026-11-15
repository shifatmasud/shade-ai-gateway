import { REGISTRY_KEY, json, error, readLimited, redis, parseRegistry, assertPublicHost, decryptSecret, setCooldown } from "./storage.js";
import { toGeminiRequest, fromGeminiResponse, geminiStreamAsOpenAI } from "./gemini.js";
const ROTATION_KEY = "shade-ai-gateway:key-rotation:v1";
const MAX_BODY_BYTES = 1048576;
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
            const nativeUrl = new URL(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(body.model)}:${body.stream ? "streamGenerateContent?alt=sse" : "generateContent"}`); response = await fetch(nativeUrl.toString(), { method: "POST", headers: { "content-type": "application/json", "x-goog-api-key": apiKey, accept: body.stream ? "text/event-stream" : "application/json" }, body: JSON.stringify(toGeminiRequest(body)), signal: controller.signal, redirect: "manual" });
        }
        catch (cause) {
            clearTimeout(timer);
            console.error(JSON.stringify({ event: "upstream_fetch_failed", provider: "google", model: body.model, requestId: request.headers.get("cf-ray") || crypto.randomUUID(), errorName: cause?.name || "Error", message: String(cause?.message || cause).replace(/[A-Za-z0-9_-]{32,}/g, "[redacted]").slice(0, 200) }));
            return error("Upstream connection failed; request was not retried to avoid duplicate usage.", "upstream_error", 502);
        }
        if (response.ok && response.body) {
            if (body.stream) { const translated = geminiStreamAsOpenAI(response, body.model, () => clearTimeout(timer)); return new Response(translated.body, { status: 200, headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", "x-ai-gateway-model": body.model } }); }
            clearTimeout(timer);
            const payload = await response.json();
            return json(fromGeminiResponse(payload, body.model), 200, { "x-ai-gateway-model": body.model, "cache-control": "no-store" });
        }
        clearTimeout(timer);
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

export { handleChat };
