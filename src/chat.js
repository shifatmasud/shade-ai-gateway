import { REGISTRY_KEY, error, readLimited, redis, parseRegistry, assertPublicHost, decryptSecret, setCooldown, digest } from "./storage.js";
const ROTATION_KEY = "shade-ai-gateway:key-rotation:v1";
const MAX_BODY_BYTES = 1048576;
const THOUGHT_SIGNATURE_PREFIX = "shade-ai-gateway:thought-signature:v1:";
const THOUGHT_SIGNATURE_TTL_SECONDS = 1800;

async function thoughtSignatureCacheKey(model, toolCallId) {
 const hash = await digest(`${model}\n${toolCallId}`);
 return THOUGHT_SIGNATURE_PREFIX + Array.from(hash, byte => byte.toString(16).padStart(2, "0")).join("");
}
async function cacheThoughtSignature(env, model, toolCallId, signature) {
 if (typeof toolCallId !== "string" || !toolCallId || toolCallId.length > 256 || typeof signature !== "string" || !signature || signature.length > 16384) return false;
 try {
  await redis(env, ["SET", await thoughtSignatureCacheKey(model, toolCallId), signature, "EX", String(THOUGHT_SIGNATURE_TTL_SECONDS)]);
  return true;
 } catch (cause) {
  console.error(JSON.stringify({ event: "thought_signature_cache_failed", errorName: cause?.name || "Error" }));
  return false;
 }
}
async function readThoughtSignature(env, model, toolCallId) {
 if (typeof toolCallId !== "string" || !toolCallId || toolCallId.length > 256) return null;
 try {
  const value = await redis(env, ["GET", await thoughtSignatureCacheKey(model, toolCallId)]);
  return typeof value === "string" && value.length <= 16384 ? value : null;
 } catch (cause) {
  console.error(JSON.stringify({ event: "thought_signature_lookup_failed", errorName: cause?.name || "Error" }));
  return null;
 }
}
async function captureThoughtSignatures(payload, env, fallbackModel) {
 let captured = 0;
 for (const choice of Array.isArray(payload?.choices) ? payload.choices : []) {
  const calls = [...(Array.isArray(choice?.delta?.tool_calls) ? choice.delta.tool_calls : []), ...(Array.isArray(choice?.message?.tool_calls) ? choice.message.tool_calls : [])];
  for (const call of calls) {
   const signature = call?.extra_content?.google?.thought_signature;
   if (typeof signature === "string" && await cacheThoughtSignature(env, payload?.model || fallbackModel || "", call.id, signature)) captured++;
  }
 }
 return captured;
}
async function restoreThoughtSignatures(body, env) {
 const missing = [];
 for (const message of body.messages) {
  if (message?.role !== "assistant" || !Array.isArray(message.tool_calls)) continue;
  for (const call of message.tool_calls) {
   if (call?.id && !call?.extra_content?.google?.thought_signature) missing.push(call.id);
  }
 }
 if (!missing.length) return { body, restored: 0, missing: 0 };
 const signatures = new Map();
 for (const id of new Set(missing)) {
  const signature = await readThoughtSignature(env, body.model, id);
  if (signature) signatures.set(id, signature);
 }
 if (!signatures.size) return { body, restored: 0, missing: missing.length };
 let restored = 0;
 const messages = body.messages.map(message => {
  if (message?.role !== "assistant" || !Array.isArray(message.tool_calls)) return message;
  let changed = false;
  const tool_calls = message.tool_calls.map(call => {
   const signature = signatures.get(call?.id);
   if (!signature || call?.extra_content?.google?.thought_signature) return call;
   const extra = call.extra_content && typeof call.extra_content === "object" ? call.extra_content : {};
   const google = extra.google && typeof extra.google === "object" ? extra.google : {};
   changed = true; restored++;
   return { ...call, extra_content: { ...extra, google: { ...google, thought_signature: signature } } };
  });
  return changed ? { ...message, tool_calls } : message;
 });
 return { body: { ...body, messages }, restored, missing: missing.length - restored };
}
async function captureNonStreamingThoughtSignatures(response, env, model) {
 try { await captureThoughtSignatures(await response.clone().json(), env, model); } catch {}
}
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
function normalizeToolCallStream(response, env, model) {
 const contentType = response.headers.get("content-type") || "";
 if (!response.body || !/text\/event-stream/i.test(contentType)) return response;
 const reader = response.body.getReader(), decoder = new TextDecoder(), encoder = new TextEncoder();
 let buffer = "", hasToolCalls = false, ended = false;
 async function transformEvent(event) {
  const lines = event.split(/\r?\n/);
  const dataLines = [];
  for (const line of lines) if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
  if (!dataLines.length) return event;
  const raw = dataLines.join("\n");
  if (!raw || raw === "[DONE]") return event;
  let payload;
  try { payload = JSON.parse(raw); } catch { return event; }
  const cachedThoughtSignatures = await captureThoughtSignatures(payload, env, model);
  if (cachedThoughtSignatures) console.warn(JSON.stringify({ event: "thought_signatures_cached", model, count: cachedThoughtSignatures }));
  const choices = Array.isArray(payload.choices) ? payload.choices : [];
  for (const choice of choices) {
   if (Array.isArray(choice?.delta?.tool_calls) && choice.delta.tool_calls.length) hasToolCalls = true;
  }
  if (hasToolCalls) {
   let changed = false;
   for (const choice of choices) {
    if (choice?.finish_reason === "stop") { choice.finish_reason = "tool_calls"; changed = true; }
   }
   if (changed) {
    const serialized = JSON.stringify(payload);
    let replaced = false;
    return lines.map(line => {
     if (!replaced && line.startsWith("data:")) { replaced = true; return "data: " + serialized; }
     return line;
    }).join("\n");
   }
  }
  return event;
 }
 const stream = new ReadableStream({
  async pull(controller) {
   if (ended) return;
   try {
    while (true) {
     const match = /\r?\n\r?\n/.exec(buffer);
     if (match) {
      const end = match.index + match[0].length;
      const event = buffer.slice(0, end);
      buffer = buffer.slice(end);
      controller.enqueue(encoder.encode(await transformEvent(event)));
      return;
     }
     const { value, done } = await reader.read();
     if (done) {
      buffer += decoder.decode();
      if (buffer) controller.enqueue(encoder.encode(await transformEvent(buffer)));
      ended = true; controller.close(); return;
     }
     buffer += decoder.decode(value, { stream: true });
    }
   } catch (cause) { ended = true; controller.error(cause); }
  },
  async cancel(reason) { ended = true; await reader.cancel(reason); }
 });
 return new Response(stream, { status: response.status, statusText: response.statusText, headers: response.headers });
}
function responseWithCleanup(response, model, timeout) {
 const headers = new Headers(response.headers);
 for (const name of ["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade", "content-length", "set-cookie"]) headers.delete(name);
 headers.set("cache-control", "no-store");
 headers.set("x-ai-gateway-model", model);
 headers.set("x-upstream-status", String(response.status));
 if (!response.body) { timeout.clear(); return new Response(null, { status: response.status, statusText: response.statusText, headers }); }
 const reader = response.body.getReader();
 let closed = false;
 const cleanup = () => { if (!closed) { closed = true; timeout.clear(); } };
 const stream = new ReadableStream({
  async pull(controller) { try { const result = await reader.read(); if (result.done) { cleanup(); controller.close(); } else { timeout.reset(); controller.enqueue(result.value); } } catch (cause) { cleanup(); controller.error(cause); } },
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
 const signatureRestore = await restoreThoughtSignatures(body, env);
 let forwarded = signatureRestore.body;
 const restoredThoughtSignatures = signatureRestore.restored;
 const missingThoughtSignatures = signatureRestore.missing;
 if (Object.prototype.hasOwnProperty.call(body, "prompt_cache_key")) {
  forwarded = { ...forwarded };
  delete forwarded.prompt_cache_key;
  strippedFields.push("prompt_cache_key");
 }
 // Gemini's OpenAI-compat endpoint can reject an empty assistant content field
 // when that same message carries tool_calls. Omit only that empty field.
 if (Array.isArray(forwarded.messages) && forwarded.messages.some(message => message?.role === "assistant" && Array.isArray(message.tool_calls) && message.tool_calls.length && message.content === "")) {
  if (forwarded === body) forwarded = { ...body };
  forwarded.messages = forwarded.messages.map(message => {
   if (message?.role !== "assistant" || !Array.isArray(message.tool_calls) || !message.tool_calls.length || message.content !== "") return message;
   const normalized = { ...message };
   delete normalized.content;
   return normalized;
  });
  strippedFields.push("empty_assistant_tool_content");
 }
 if (forwarded !== body) upstreamBody = JSON.stringify(forwarded);
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
  const controller = new AbortController();
  // Bound upstream connection and idle-body time, not total stream lifetime.
  const timeoutMs = Math.max(1000, Math.min(120000, Number(env.PROVIDER_TIMEOUT_MS) || 120000));
  let timer = setTimeout(() => controller.abort(), timeoutMs);
  const timeout = {
   reset() { clearTimeout(timer); timer = setTimeout(() => controller.abort(), timeoutMs); },
   clear() { clearTimeout(timer); }
  };
  let response;
  try {
   response = await fetch(upstreamUrl, { method: "POST", headers: { "content-type": request.headers.get("content-type") || "application/json", authorization: `Bearer ${apiKey}`, accept: request.headers.get("accept") || (body.stream ? "text/event-stream" : "application/json") }, body: upstreamBody, signal: controller.signal, redirect: "manual" });
  } catch (cause) {
   timeout.clear();
   console.error(JSON.stringify({ event: "upstream_fetch_failed", provider: "google", model: body.model, requestId: request.headers.get("cf-ray") || crypto.randomUUID(), errorName: cause?.name || "Error", message: String(cause?.message || cause).replace(/[A-Za-z0-9_-]{32,}/g, "[redacted]").slice(0, 200) }));
   return error("Upstream connection failed; request was not retried to avoid duplicate usage.", "upstream_error", 502);
  }
  if (response.ok) {
   console.warn(JSON.stringify({ event: "upstream_response_received", provider: "google", model: body.model, status: response.status, contentType: response.headers.get("content-type") || "", streaming: body.stream === true, hasBody: Boolean(response.body), restoredThoughtSignatures, missingThoughtSignatures, upstreamRequestId: response.headers.get("x-request-id") || response.headers.get("x-goog-request-id") || "" }));
   timeout.reset();
   if (body.stream === true) response = normalizeToolCallStream(response, env, body.model);
   else await captureNonStreamingThoughtSignatures(response, env, body.model);
   return responseWithCleanup(response, body.model, timeout);
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
   timeout.clear();
   const cooldown = response.status === 429 ? retryAfterSeconds(response.headers.get("retry-after")) : 900;
   try { await setCooldown(env, key.id, cooldown); } catch { return error("Key rotation state unavailable.", "service_unavailable", 503); }
   continue;
  }
  timeout.reset();
  return responseWithCleanup(response, body.model, timeout);
 }
 const latest = parseRegistry(await redis(env, ["GET", REGISTRY_KEY]));
 const future = latest.keys.map(key => key.cooldownUntil || 0).filter(value => value > Date.now());
 const retry = future.length ? Math.max(1, Math.ceil((Math.min(...future) - Date.now()) / 1000)) : 60;
 return error("Every available Google AI Studio key is rate-limited or out of quota.", "provider_exhausted", 503, { "retry-after": String(retry) });
}
export { handleChat, isQuotaFailure, retryAfterSeconds };