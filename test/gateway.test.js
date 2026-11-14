import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import worker, { deriveRoutes, selectCandidates, validateBaseUrl } from "../src/index.js";

const ADMIN = "admin-secret-for-tests-only-0123456789";
const ENCRYPTION = "encryption-secret-for-tests-only-0123456789";
const GATEWAY = "gateway-secret-for-tests-only-0123456789";
const BASE_URL = "https://shade.test";
let restoreFetch;

function makeEnv(options = {}) {
  const redis = { value: null };
  const upstreamCalls = [];
  const modelLists = new Map([
    ["https://alpha.example.com/v1", ["alpha-fast", "alpha-reasoning"]],
    ["https://beta.example.com/v1", ["beta-mini", "beta-reasoning"]],
    ["https://stream.example.com/v1", ["stream-model"]]
  ]);
  const env = {
    ADMIN_SECRET: ADMIN,
    PROVIDER_ENCRYPTION_KEY: ENCRYPTION,
    GATEWAY_API_KEY: GATEWAY,
    UPSTASH_REDIS_REST_URL: "https://redis.test",
    UPSTASH_REDIS_REST_TOKEN: "fake-redis-token",
    CLIENT_RPM: "60",
    CLIENT_TPM: "100000",
    PROVIDER_TIMEOUT_MS: "1000",
    ALLOWED_ORIGINS: "https://client.test",
    ...options.env
  };

  restoreFetch = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const requestUrl = typeof input === "string" ? input : input.url;
    if (requestUrl === env.UPSTASH_REDIS_REST_URL) {
      const command = JSON.parse(init.body);
      if (command[0] === "GET") return Response.json({ result: redis.value });
      if (command[0] === "PING") return Response.json({ result: "PONG" });
      if (command[0] === "EVAL" && command[1].includes("__SHADE_MISSING__")) {
        const expected = command[4];
        const matches = expected === "__SHADE_MISSING__" ? redis.value === null : redis.value === expected;
        if (matches) redis.value = command[5];
        return Response.json({ result: matches ? 1 : 0 });
      }
      if (command[0] === "EVAL") return Response.json({ result: [1, 1, 128, 60] });
      return Response.json({ result: "OK" });
    }

    if (requestUrl.startsWith("https://cloudflare-dns.com/dns-query")) {
      const query = new globalThis.URL(requestUrl);
      const hostname = query.searchParams.get("name");
      const type = query.searchParams.get("type");
      const data = hostname === "private-dns.example.com" && type === "A"
        ? "10.2.3.4"
        : type === "A" ? "93.184.216.34" : "2606:4700:4700::1111";
      return Response.json({ Status: 0, Answer: [{ type: type === "A" ? 1 : 28, data, TTL: 60 }] });
    }

    if (requestUrl.endsWith("/models")) {
      const parsed = new globalThis.URL(requestUrl);
      const origin = parsed.origin + parsed.pathname.replace(/\/models$/, "");
      const ids = modelLists.get(origin) || [];
      return Response.json({ data: ids.map(id => ({ id })) });
    }

    if (requestUrl.endsWith("/chat/completions")) {
      const parsed = new globalThis.URL(requestUrl);
      const sentBody = JSON.parse(init.body);
      upstreamCalls.push({ url: requestUrl, authorization: new Headers(init.headers).get("authorization"), body: sentBody });
      if (options.upstream) return options.upstream({ requestUrl, init, parsed, sentBody, upstreamCalls });
      if (parsed.hostname.startsWith("alpha")) {
        return new Response("PRIVATE-UPSTREAM-DETAIL", { status: 429, headers: { "retry-after": "3", "content-type": "text/plain" } });
      }
      return Response.json({ choices: [{ message: { role: "assistant", content: "hello" } }], model: sentBody.model });
    }

    throw new Error(`Unexpected fake network request to ${requestUrl}`);
  };
  return { env, redis, upstreamCalls };
}

afterEach(() => {
  if (restoreFetch) globalThis.fetch = restoreFetch;
  restoreFetch = undefined;
});

function adminRequest(path, { method = "GET", body, secret = ADMIN, origin } = {}) {
  const headers = {};
  if (secret) headers.Authorization = `Bearer ${secret}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (origin) headers.Origin = origin;
  return new Request(`${BASE_URL}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
}

async function addProvider(env, { name, baseUrl, apiKey }) {
  const response = await worker.fetch(adminRequest("/admin/providers", { method: "POST", body: { name, baseUrl, apiKey } }), env);
  return { response, payload: await response.json() };
}

async function listProviders(env) {
  const response = await worker.fetch(adminRequest("/admin/providers"), env);
  return { response, payload: await response.json() };
}

function apiRequest(path, { method = "GET", body, secret = GATEWAY } = {}) {
  const headers = {};
  if (secret) headers.Authorization = `Bearer ${secret}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  return new Request(`${BASE_URL}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
}

test("rejects non-HTTPS, IP, local, private-suffix, credentialed, and nonstandard-port URLs", () => {
  for (const address of [
    "http://api.example.com/v1",
    "https://127.0.0.1/v1",
    "https://[::1]/v1",
    "https://localhost/v1",
    "https://service.local/v1",
    "https://metadata.google.internal/v1",
    "https://user:pass@api.example.com/v1",
    "https://api.example.com:8443/v1",
    "https://api.example.com/v1?token=oops",
    "https://api.example.com/v1#fragment"
  ]) assert.equal(validateBaseUrl(address), null, address);
  assert.equal(validateBaseUrl("https://api.example.com/v1/"), "https://api.example.com/v1");
});

test("admin API requires its separate secret and rejects cross-origin management", async () => {
  const { env } = makeEnv();
  const unauthorized = await worker.fetch(adminRequest("/admin/providers", { secret: GATEWAY }), env);
  assert.equal(unauthorized.status, 401);
  const crossOrigin = await worker.fetch(adminRequest("/admin/providers", { origin: "https://attacker.test" }), env);
  assert.equal(crossOrigin.status, 403);
  const authorizedResponse = await worker.fetch(adminRequest("/admin/providers"), env);
  assert.equal(authorizedResponse.status, 200);
});

test("creates and lists providers without returning or storing plaintext API keys", async () => {
  const { env, redis } = makeEnv();
  const providerKey = "provider-api-key-never-return-this";
  const { response, payload } = await addProvider(env, {
    name: "Alpha Provider",
    baseUrl: "https://alpha.example.com/v1",
    apiKey: providerKey
  });
  assert.equal(response.status, 201);
  assert.equal(payload.provider.name, "Alpha Provider");
  assert.equal(payload.provider.keyConfigured, true);
  assert.equal(JSON.stringify(payload).includes(providerKey), false);
  assert.equal(redis.value.includes(providerKey), false);
  assert.equal(redis.value.includes("encryptedKey"), true);
  const listed = await listProviders(env);
  assert.equal(listed.payload.providers.length, 1);
  assert.equal(listed.payload.providers[0].keyConfigured, true);
  assert.equal(JSON.stringify(listed.payload).includes(providerKey), false);
  assert.equal(JSON.stringify(listed.payload).includes("encryptedKey"), false);
});

test("accepts exactly the three provider fields and blocks duplicate entries", async () => {
  const { env } = makeEnv();
  const first = await addProvider(env, { name: "Alpha", baseUrl: "https://alpha.example.com/v1", apiKey: "fake-key-1" });
  assert.equal(first.response.status, 201);
  const extraField = await worker.fetch(adminRequest("/admin/providers", {
    method: "POST", body: { name: "Other", baseUrl: "https://beta.example.com/v1", apiKey: "fake-key-2", model: "hidden-setting" }
  }), env);
  assert.equal(extraField.status, 400);
  const duplicateName = await addProvider(env, { name: "alpha", baseUrl: "https://beta.example.com/v1", apiKey: "fake-key-2" });
  assert.equal(duplicateName.response.status, 409);
  const duplicateUrl = await addProvider(env, { name: "Other", baseUrl: "https://alpha.example.com/v1", apiKey: "fake-key-2" });
  assert.equal(duplicateUrl.response.status, 409);
});

test("updates provider details, keeps a blank saved key, rotates key, and deletes provider", async () => {
  const { env, redis } = makeEnv();
  const created = await addProvider(env, { name: "Alpha", baseUrl: "https://alpha.example.com/v1", apiKey: "first-private-key" });
  const id = created.payload.provider.id;
  const firstEncryptedKey = JSON.parse(redis.value).providers[0].encryptedKey;
  const updated = await worker.fetch(adminRequest(`/admin/providers/${id}`, {
    method: "PUT", body: { name: "Alpha Renamed", baseUrl: "https://alpha.example.com/v1", apiKey: "" }
  }), env);
  assert.equal(updated.status, 200);
  assert.equal((await updated.json()).provider.keyConfigured, true);
  assert.equal(JSON.parse(redis.value).providers[0].encryptedKey, firstEncryptedKey);
  const rotated = await worker.fetch(adminRequest(`/admin/providers/${id}`, {
    method: "PUT", body: { name: "Alpha Renamed", baseUrl: "https://alpha.example.com/v1", apiKey: "replacement-private-key" }
  }), env);
  assert.equal(rotated.status, 200);
  assert.equal(JSON.stringify(await rotated.clone().json()).includes("replacement-private-key"), false);
  assert.notEqual(JSON.parse(redis.value).providers[0].encryptedKey, firstEncryptedKey);
  const removed = await worker.fetch(adminRequest(`/admin/providers/${id}`, { method: "DELETE" }), env);
  assert.equal(removed.status, 200);
  assert.deepEqual((await listProviders(env)).payload.providers, []);
});

test("discovers safe model aliases and lists inferred aliases plus exact provider model IDs", async () => {
  const { env } = makeEnv();
  await addProvider(env, { name: "Alpha", baseUrl: "https://alpha.example.com/v1", apiKey: "fake-alpha" });
  const unauthorized = await worker.fetch(apiRequest("/v1/models", { secret: null }), env);
  assert.equal(unauthorized.status, 401);
  const response = await worker.fetch(apiRequest("/v1/models"), env);
  const payload = await response.json();
  const ids = payload.data.map(model => model.id);
  assert.equal(ids.includes("default"), true);
  assert.equal(ids.includes("fast"), true);
  assert.equal(ids.includes("reasoning"), true);
  assert.equal(ids.includes("alpha-fast"), true);
  assert.equal(ids.includes("alpha-reasoning"), true);
});

test("selects per-provider inferred models and fails over after 429 without leaking provider error text", async () => {
  const { env, upstreamCalls } = makeEnv();
  await addProvider(env, { name: "Alpha", baseUrl: "https://alpha.example.com/v1", apiKey: "fake-alpha-key" });
  await addProvider(env, { name: "Beta", baseUrl: "https://beta.example.com/v1", apiKey: "fake-beta-key" });
  const response = await worker.fetch(apiRequest("/v1/chat/completions", {
    method: "POST", body: { model: "fast", messages: [{ role: "user", content: "hello" }] }
  }), env);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-ai-gateway-model"), "fast");
  assert.match(response.headers.get("x-ai-gateway-provider"), /^beta-/);
  assert.equal(upstreamCalls.length, 2);
  assert.equal(upstreamCalls[0].body.model, "alpha-fast");
  assert.equal(upstreamCalls[1].body.model, "beta-mini");
  assert.equal(upstreamCalls[0].authorization, "Bearer fake-alpha-key");
  assert.equal(await response.text().then(text => text.includes("PRIVATE-UPSTREAM-DETAIL")), false);
});

test("passes streaming responses through without buffering or stripping SSE content", async () => {
  const streaming = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("data: {\"delta\":\"hello\"}\n\n"));
      controller.close();
    }
  });
  const { env } = makeEnv({ upstream: async () => new Response(streaming, { status: 200, headers: { "content-type": "text/event-stream" } }) });
  await addProvider(env, { name: "Stream", baseUrl: "https://stream.example.com/v1", apiKey: "fake-stream-key" });
  const response = await worker.fetch(apiRequest("/v1/chat/completions", {
    method: "POST", body: { model: "stream-model", stream: true, messages: [{ role: "user", content: "hello" }] }
  }), env);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /text\/event-stream/);
  assert.equal(response.headers.get("x-accel-buffering"), "no");
  assert.equal(await response.text(), "data: {\"delta\":\"hello\"}\n\n");
});

test("health reports Redis status without exposing credentials or provider details", async () => {
  const { env } = makeEnv();
  await addProvider(env, { name: "Alpha", baseUrl: "https://alpha.example.com/v1", apiKey: "private-health-key" });
  const response = await worker.fetch(new Request(`${BASE_URL}/health`), env);
  const body = await response.text();
  assert.equal(response.status, 200);
  assert.match(body, /"redis":"ok"/);
  assert.match(body, /"configuredProviders":1/);
  assert.equal(body.includes("private-health-key"), false);
  assert.equal(body.includes("alpha.example.com"), false);
});

test("gateway requests require the gateway key and do not reveal upstream credentials", async () => {
  const { env } = makeEnv();
  const response = await worker.fetch(apiRequest("/v1/chat/completions", {
    method: "POST", secret: null, body: { model: "fast", messages: [] }
  }), env);
  assert.equal(response.status, 401);
  assert.equal((await response.text()).includes(ADMIN), false);
});

test("route inference is stable and unknown exact model IDs can pass through", () => {
  assert.deepEqual(deriveRoutes(["vendor/model-standard", "vendor/model-mini", "vendor/model-reasoning"]), {
    default: "vendor/model-standard",
    fast: "vendor/model-mini",
    reasoning: "vendor/model-reasoning"
  });
  const providers = [
    { id: "one", routes: { fast: "one-fast" }, modelIds: ["one-fast"] },
    { id: "two", routes: { fast: "two-fast" }, modelIds: ["two-fast"] }
  ];
  assert.deepEqual(selectCandidates(providers, "fast").map(item => item.routedModel), ["one-fast", "two-fast"]);
  assert.deepEqual(selectCandidates(providers, "unlisted-model").map(item => item.routedModel), ["unlisted-model", "unlisted-model"]);
});

test("dashboard renders only the three provider inputs and does not persist or export keys", async () => {
  const { readFile } = await import("node:fs/promises");
  const html = await readFile(new URL("../dashboard/index.html", import.meta.url), "utf8");
  const script = await readFile(new URL("../dashboard/app.js", import.meta.url), "utf8");
  const styles = await readFile(new URL("../dashboard/styles.css", import.meta.url), "utf8");
  assert.match(html, /href="\/styles\.css"/);
  assert.match(html, /src="\/app\.js"/);
  assert.doesNotMatch(html, /<style\b|<script\s*>/i);
  assert.doesNotMatch(script, /localStorage|sessionStorage|document\.cookie|URL\.createObjectURL|Export provider config/);
  const fields = [...script.matchAll(/<input\b[^>]*data-field="([^"]+)"/g)].map(match => match[1]).sort();
  assert.deepEqual(fields, ["apiKey", "baseUrl", "name"]);
  assert.match(script, /keyConfigured: Boolean\(provider\.keyConfigured\)/);
  assert.match(script, /apiKey: ''/);
  assert.match(styles, /\.provider\{/);
});

test("enforces request-size limits even when Content-Length is missing", async () => {
  const { env } = makeEnv();
  const oversizedAdmin = new Request(`${BASE_URL}/admin/providers`, {
    method: "POST",
    headers: { Authorization: `Bearer ${ADMIN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ name: "x".repeat(20_000), baseUrl: "https://api.example.com/v1", apiKey: "key" })
  });
  assert.equal((await worker.fetch(oversizedAdmin, env)).status, 413);
  const oversizedGateway = new Request(`${BASE_URL}/v1/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${GATEWAY}`, "Content-Type": "application/json" },
    body: " ".repeat(1_048_577)
  });
  assert.equal((await worker.fetch(oversizedGateway, env)).status, 413);
});

test("refuses to operate when admin, gateway, and encryption secrets are not distinct", async () => {
  const { env } = makeEnv({ env: { PROVIDER_ENCRYPTION_KEY: ADMIN } });
  assert.equal((await worker.fetch(adminRequest("/admin/providers"), env)).status, 503);
  assert.equal((await worker.fetch(apiRequest("/v1/models"), env)).status, 503);
});

test("fails closed when the encryption secret no longer matches stored keys", async () => {
  const { env } = makeEnv();
  await addProvider(env, { name: "Alpha", baseUrl: "https://alpha.example.com/v1", apiKey: "never-return-key" });
  const wrongEnv = { ...env, PROVIDER_ENCRYPTION_KEY: "another-encryption-secret-for-tests-0123456789" };
  const response = await worker.fetch(apiRequest("/v1/chat/completions", {
    method: "POST", body: { model: "fast", messages: [{ role: "user", content: "hello" }] }
  }), wrongEnv);
  assert.equal(response.status, 503);
  assert.equal((await response.text()).includes("never-return-key"), false);
});

test("returns a bounded retry suggestion and no upstream error body after all providers fail", async () => {
  const { env } = makeEnv({ upstream: async ({ parsed }) => new Response("PRIVATE-UPSTREAM-ERROR", {
    status: parsed.hostname.startsWith("alpha") ? 429 : 503,
    headers: { "retry-after": parsed.hostname.startsWith("alpha") ? "2" : "9" }
  }) });
  await addProvider(env, { name: "Alpha", baseUrl: "https://alpha.example.com/v1", apiKey: "fake-alpha" });
  await addProvider(env, { name: "Beta", baseUrl: "https://beta.example.com/v1", apiKey: "fake-beta" });
  const response = await worker.fetch(apiRequest("/v1/chat/completions", {
    method: "POST", body: { model: "fast", messages: [{ role: "user", content: "hello" }] }
  }), env);
  assert.equal(response.status, 503);
  assert.equal(response.headers.get("retry-after"), "9");
  assert.equal((await response.text()).includes("PRIVATE-UPSTREAM-ERROR"), false);
});

test("aborts an upstream body that stalls beyond the response idle timeout", async () => {
  let timedOut = false;
  const { env } = makeEnv({
    env: { PROVIDER_TIMEOUT_MS: "1000" },
    upstream: async ({ init }) => {
      const stream = new ReadableStream({
        start(controller) {
          init.signal.addEventListener("abort", () => {
            timedOut = true;
            controller.error(new Error("test upstream timed out"));
          }, { once: true });
        }
      });
      return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
    }
  });
  await addProvider(env, { name: "Stream", baseUrl: "https://stream.example.com/v1", apiKey: "fake-stream-key" });
  const response = await worker.fetch(apiRequest("/v1/chat/completions", {
    method: "POST", body: { model: "stream-model", stream: true, messages: [{ role: "user", content: "hello" }] }
  }), env);
  assert.equal(response.status, 200);
  await assert.rejects(() => response.text());
  assert.equal(timedOut, true);
});


test("rejects a hostname whose DNS returns private or reserved addresses", async () => {
  const { env } = makeEnv();
  const result = await addProvider(env, {
    name: "Private DNS",
    baseUrl: "https://private-dns.example.com/v1",
    apiKey: "fake-key"
  });
  assert.equal(result.response.status, 400);
  assert.match(result.payload.error.message, /public Internet addresses/);
});
