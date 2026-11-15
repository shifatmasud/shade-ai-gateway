key.id, Boolean(key.legacy));
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
