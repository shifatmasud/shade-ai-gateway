import { REGISTRY_KEY, error, readLimited, redis, parseRegistry, assertPublicHost, decryptSecret, setCooldown } from "./storage.js";
const ROTATION_KEY = "shade-ai-gateway:key-rotation:v1";
const MAX_BODY_BYTES = 1048576;
function retryAfterSeconds(value) {
 if (!value) return 60;
 const n = Number(value);
 if (Number.isFinite(n) && n >= 0) return Math.max(1, Math.min(3600, Math.ceil(n)));
 const date = Date.parse(value);
 return Number.isFinite(date) ? Math.max(1, Math.min(3600, Math.ceil((date - Date.now()) / 1000))) : 60;
}
function isQuotaFailure(status, text) {
 if (status === 429) return true;
 if (status !== 403) return false;
 return /(quota|resource_exhausted|rate.?limit|billing|exceeded.*(limit|quota)|limit.*exceeded)/i.test(text || "");
}
function responseWithCleanup(response, model, timer) {
 const headers = new Headers(response.headers);
 for (const name of ["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade", "content-length", "set-cookie"]) headers.delete(name);
 headers.set("cache-control", "no-store");
 headers.set("x-ai-gateway-model", model);
 headers.set("x-upstream-status", String(response.status));
 if (!response.body) { clearTimeout(timer); return new Response(null, { status: response.status, statusText: response.statusText, headers }); }
 const reader = response.body.getReader();
 let closed = false;
 const cleanup = () => { if (!closed) { closed = true; clearTimeout(timer); } };
 const stream = new ReadableStream({
  async pull(controller) { try { const result = await reader.read(); if (result.done) { cleanup(); controller.close(); } else controller.enqueue(result.value); } catch (cause) { cleanup(); controller.error(cause); } },
  async cancel(reason) { try { await reader.cancel(reason); } finally { cleanup(); } }
 });
 return new Response(stream, { status: response.status, statusText: response.statusText, headers });
}
async function handleChat(request, env) {
 if (Number(request.headers.get("content-length") || 0) > MAX_BODY_BYTES) return error("Request body too large.", "invalid_request_error", 413);
 let raw, body;
 try { raw = await readLimited(request, MAX_BODY_BYTES); if (raw === null) return error("Request body too large.", "invalid_request_error", 413); body = JSON.parse(raw); }
 catch { return error("Request body must be valid JSON.", "invalid_request_error", 400); }
 if (!body || !Array.isArray(body.messages) || typeof body.model !== "string" || !body.model.trim()) return error("Expected a model name and messages array.", "invalid_request_error", 400);
 const strippedFields = [];
 let upstreamBody = raw;
 if (Object.prototype.hasOwnProperty.call(body, "prompt_cache_key")) {
  const forwarded = { ...body };
  delete forwarded.prompt_cache_key;
  upstreamBody = JSON.stringify(forwarded);
  strippedFields.push("prompt_cache_key");
 }
 let reg;
 try { reg = parseRegistry(await redis(env, ["GET", REGISTRY_KEY])); } catch { return error("Key storage unavailable.", "service_unavailable", 503); }
 if (!reg.keys.length) return error("No Google AI Studio keys are configured.", "provider_not_configured", 503);
 const now = Date.now(), ready = reg.keys.filter(key => (key.cooldownUntil || 0) <= now);
 if (!ready.length) { const next = Math.min(...reg.keys.map(key => key.cooldownUntil || now + 60000)); return error("All Google AI Studio keys are cooling down. Retry later.", "provider_exhausted", 503, { "retry-after": String(Math.max(1, Math.ceil((next - now) / 1000))) }); }
 let start = 0;
 try { start = Number(await redis(env, ["INCR", ROTATION_KEY])) % ready.length; } catch { start = Math.floor(Math.random() * ready.length); }
 const ordered = [...ready.slice(start), ...ready.slice(0, start)];
 let upstreamUrl;
 try { const base = new URL(reg.baseUrl); await assertPublicHost(base.hostname); base.pathname = base.pathname.replace(/\/+$/, "") + "/chat/completions"; upstreamUrl = base.toString(); }
 catch (cause) { console.error(JSON.stringify({ event: "provider_url_invalid", provider: "google", message: String(cause?.message || cause).slice(0, 160) })); return error("Configured provider URL is invalid or unavailable.", "configuration_error", 503); }
 for (const key of ordered) {
  let apiKey;
  try { apiKey = await decryptSecret(key.encryptedKey, env, key.id, Boolean(key.legacy)); }
  catch (cause) { console.error(JSON.stringify({ event: "provider_key_decrypt_failed", provider: "google", keyId: key.id, message: String(cause?.message || cause).slice(0, 160) })); continue; }
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), Math.max(1000, Math.min(120000, Number(env.PROVIDER_TIMEOUT_MS) || 45000)));
  let response;
  try {
   response = await fetch(upstreamUrl, { method: "POST", headers: { "content-type": request.headers.get("content-type") || "application/json", authorization: `Bearer ${apiKey}`, accept: request.headers.get("accept") || (body.stream ? "text/event-stream" : "application/json") }, body: upstreamBody, signal: controller.signal, redirect: "manual" });
  } catch (cause) {
   clearTimeout(timer);
   console.error(JSON.stringify({ event: "upstream_fetch_failed", provider: "google", model: body.model, requestId: request.headers.get("cf-ray") || crypto.randomUUID(), errorName: cause?.name || "Error", message: String(cause?.message || cause).replace(/[A-Za-z0-9_-]{32,}/g, "[redacted]").slice(0, 200) }));
   return error("Upstream connection failed; request was not retried to avoid duplicate usage.", "upstream_error", 502);
  }
  if (response.ok) {
   console.warn(JSON.stringify({ event: "upstream_response_received", provider: "google", model: body.model, status: response.status, contentType: response.headers.get("content-type") || "", streaming: body.stream === true, hasBody: Boolean(response.body), upstreamRequestId: response.headers.get("x-request-id") || response.headers.get("x-goog-request-id") || "" }));
   return responseWithCleanup(response, body.model, timer);
  }
  let detail = "";
  try { detail = await response.clone().text(); } catch {}
  let providerError = {};
  try {
   const payload = JSON.parse(detail);
   const root = Array.isArray(payload) ? payload[0] : payload;
   const upstreamError = root?.error || root;
   const providerMessage = typeof upstreamError?.message === "string" ? upstreamError.message : typeof root?.message === "string" ? root.message : "";
   providerError = {
    bodyFormat: "json",
    payloadType: Array.isArray(payload) ? "array" : typeof payload,
    payloadLength: Array.isArray(payload) ? payload.length : undefined,
    payloadKeys: payload && typeof payload === "object" ? Object.keys(payload).slice(0, 12) : [],
    rootKeys: root && typeof root === "object" ? Object.keys(root).slice(0, 12) : [],
    errorKeys: upstreamError && typeof upstreamError === "object" ? Object.keys(upstreamError).slice(0, 12) : [],
    errorFieldType: typeof root?.error,
    messagePresent: Boolean(providerMessage),
    upstreamCode: ["number", "string"].includes(typeof upstreamError?.code) ? String(upstreamError.code).slice(0, 64) : undefined,
    upstreamStatus: ["number", "string"].includes(typeof upstreamError?.status) ? String(upstreamError.status).slice(0, 64) : undefined,
    upstreamType: typeof upstreamError?.type === "string" ? upstreamError.type.slice(0, 64) : undefined,
    unknownField: providerMessage.match(/Unknown name\s+['"]([^'"]+)['"]/i)?.[1]?.slice(0, 64),
    errorClass: /tool|function|schema/i.test(providerMessage) ? "tool_schema" : /model/i.test(providerMessage) ? "model" : /reasoning|thinking/i.test(providerMessage) ? "reasoning" : /key|auth|permission/i.test(providerMessage) ? "auth" : /invalid|unsupported|not supported|unrecognized|unknown field|missing|required/i.test(providerMessage) ? "request_validation" : undefined,
    errorMessage: providerMessage && /(invalid|unsupported|not supported|unrecognized|unknown field|missing|required|permission|api key|quota|rate.?limit|model|tool|function|schema|reasoning|thinking)/i.test(providerMessage) ? providerMessage.replace(/["'][^"']{1,80}["']/g, "[value]").replace(/[A-Za-z0-9_-]{32,}/g, "[redacted]").slice(0, 180) : undefined,
    reasons: Array.isArray(upstreamError?.details) ? upstreamError.details.map(item => item?.reason).filter(value => typeof value === "string").slice(0, 5) : undefined
   };
  } catch {
   providerError = { bodyFormat: "text", bodyLength: detail.length, bodyClass: /bad request/i.test(detail) ? "bad_request" : /invalid/i.test(detail) ? "invalid_request" : "unclassified" };
  }
  console.error(JSON.stringify({
   event: "upstream_http_error", provider: "google", model: body.model, status: response.status, statusText: response.statusText,
   requestId: request.headers.get("cf-ray") || crypto.randomUUID(), upstreamRequestId: response.headers.get("x-request-id") || response.headers.get("x-goog-request-id") || "",
   contentType: response.headers.get("content-type") || "", retryAfter: response.headers.get("retry-after") || "",
   stream: body.stream === true, messageCount: body.messages.length,
   messageRoles: body.messages.map(message => message?.role).filter(value => typeof value === "string").slice(0, 24),
   toolCount: Array.isArray(body.tools) ? body.tools.length : 0,
   toolNames: Array.isArray(body.tools) ? body.tools.map(tool => tool?.function?.name).filter(value => typeof value === "string").slice(0, 24) : [],
   requestKeys: Object.keys(body).sort().slice(0, 48), strippedFields,
   firstToolKeys: body.tools?.[0] && typeof body.tools[0] === "object" ? Object.keys(body.tools[0]).slice(0, 24) : [],
   firstToolFunctionKeys: body.tools?.[0]?.function && typeof body.tools[0].function === "object" ? Object.keys(body.tools[0].function).slice(0, 24) : [],
   firstToolSchemaKeys: body.tools?.[0]?.function?.parameters && typeof body.tools[0].function.parameters === "object" ? Object.keys(body.tools[0].function.parameters).slice(0, 24) : [],
   responseFormatKeys: body.response_format && typeof body.response_format === "object" ? Object.keys(body.response_format).slice(0, 24) : [],
   streamOptionsKeys: body.stream_options && typeof body.stream_options === "object" ? Object.keys(body.stream_options).slice(0, 24) : [],
   toolChoiceType: typeof body.tool_choice,
   ...providerError
  }));
  if (isQuotaFailure(response.status, detail)) {
   clearTimeout(timer);
   const cooldown = response.status === 429 ? retryAfterSeconds(response.headers.get("retry-after")) : 900;
   try { await setCooldown(env, key.id, cooldown); } catch { return error("Key rotation state unavailable.", "service_unavailable", 503); }
   continue;
  }
  return responseWithCleanup(response, body.model, timer);
 }
 const latest = parseRegistry(await redis(env, ["GET", REGISTRY_KEY]));
 const future = latest.keys.map(key => key.cooldownUntil || 0).filter(value => value > Date.now());
 const retry = future.length ? Math.max(1, Math.ceil((Math.min(...future) - Date.now()) / 1000)) : 60;
 return error("Every available Google AI Studio key is rate-limited or out of quota.", "provider_exhausted", 503, { "retry-after": String(retry) });
}
export { handleChat, isQuotaFailure, retryAfterSeconds };
