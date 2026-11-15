import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import worker, { validateBaseUrl, parseRegistry, isQuotaFailure, retryAfterSeconds } from '../src/index.js';

const ADMIN = 'admin-secret-for-tests-only-0123456789';
const ENCRYPTION = 'encryption-secret-for-tests-only-0123456789';
const CLIENT_KEY = 'shade-client-secret-for-tests-only-0123456789';
const BASE = 'https://generativelanguage.googleapis.com/v1beta/openai';
let originalFetch;
let store;
let upstreamGenerateCalls;
let upstreamMode;
let lastUpstreamModel;
let lastUpstreamBody;

function makeEnv() {
  store = new Map();
  upstreamGenerateCalls = 0;
  upstreamMode = 'rotate';
  lastUpstreamModel = null;
  lastUpstreamBody = null;
  store.set('shade-ai-gateway:key-rotation:v1', '1');
  const fakeFetch = async (input, init = {}) => {
    const url = new URL(String(input));
    if (url.hostname === 'redis.test') {
      const command = JSON.parse(init.body);
      const op = command[0];
      if (op === 'PING') return Response.json({ result: 'PONG' });
      if (op === 'GET') return Response.json({ result: store.get(command[1]) ?? null });
      if (op === 'INCR') {
        const next = Number(store.get(command[1]) || 0) + 1;
        store.set(command[1], String(next));
        return Response.json({ result: next });
      }
      if (op === 'EVAL' && String(command[1]).includes('local current = redis.call')) {
        const key = command[3];
        const current = store.get(key) ?? null;
        const expected = command[4];
        const matches = expected === '__SHADE_MISSING__' ? current === null : current === expected;
        if (!matches) return Response.json({ result: 0 });
        store.set(key, command[5]);
        return Response.json({ result: 1 });
      }
      if (op === 'EVAL') {
        const rpmKey = command[3], tokenKey = command[4];
        const rpm = Number(store.get(rpmKey) || 0) + 1;
        const tokens = Number(store.get(tokenKey) || 0) + Number(command[6]);
        store.set(rpmKey, String(rpm)); store.set(tokenKey, String(tokens));
        const allowed = (Number(command[5]) <= 0 || rpm <= Number(command[5])) && (Number(command[8]) <= 0 || tokens <= Number(command[8]));
        return Response.json({ result: [allowed ? 1 : 0, rpm, tokens, 60] });
      }
      throw new Error(`Unexpected Redis command: ${op}`);
    }
    if (url.hostname === 'cloudflare-dns.com') {
      const type = url.searchParams.get('type');
      return Response.json(type === 'A'
        ? { Status: 0, Answer: [{ type: 1, data: '142.250.72.234' }] }
        : { Status: 3, Answer: [] });
    }
    if (url.hostname === 'generativelanguage.googleapis.com' && url.pathname === '/v1beta/models') {
      if (url.searchParams.get('pageToken') === 'next') {
        return Response.json({ models: [{ name: 'models/gemini-2.5-pro', displayName: 'Gemini 2.5 Pro', supportedGenerationMethods: ['generateContent'] }] });
      }
      return Response.json({ models: [{ name: 'models/gemini-2.5-flash', displayName: 'Gemini 2.5 Flash', description: 'Fast model', inputTokenLimit: 1048576, outputTokenLimit: 65536, supportedGenerationMethods: ['generateContent', 'countTokens'] }], nextPageToken: 'next' });
    }
    if (url.hostname === 'generativelanguage.googleapis.com' && url.pathname.endsWith('/models')) {
      return Response.json({ object: 'list', data: [{ id: 'gemini-2.5-flash', created: 1750000000, owned_by: 'google' }, { id: 'gemini-2.5-pro', owned_by: 'google' }] });
    }
    if (url.hostname === 'generativelanguage.googleapis.com' && url.pathname === '/v1beta/openai/chat/completions') {
      upstreamGenerateCalls++;
      const sent = JSON.parse(init.body);
      lastUpstreamModel = sent.model;
      lastUpstreamBody = sent;
      assert.match(new Headers(init.headers).get('authorization') || '', /^Bearer google-test-secret-/);
      assert.deepEqual(sent.messages, [{ role: 'user', content: 'hello' }]);
      if (upstreamMode === 'rotate' && upstreamGenerateCalls === 1) return new Response(JSON.stringify({ error: { message: 'RESOURCE_EXHAUSTED rate limit' } }), { status: 429, headers: { 'retry-after': '60', 'content-type': 'application/json' } });
      if (upstreamMode === 'ambiguous') return new Response(JSON.stringify({ error: { message: 'server error' } }), { status: 500 });
      if (sent.stream && upstreamMode === 'slow-stream') {
        const chunks = ['data: first\n\n', 'data: second\n\n', 'data: third\n\n', 'data: [DONE]\n\n'];
        let index = 0;
        return new Response(new ReadableStream({
          async pull(controller) {
            if (index >= chunks.length) { controller.close(); return; }
            await new Promise(resolve => setTimeout(resolve, 600));
            controller.enqueue(new TextEncoder().encode(chunks[index++]));
          }
        }), { headers: { 'content-type': 'text/event-stream' } });
      }
      if (sent.stream) {
        const events = ['data: ' + JSON.stringify({ id: 'chatcmpl_test', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: 'stream ' }, finish_reason: null }] }) + '\n\n', 'data: ' + JSON.stringify({ id: 'chatcmpl_test', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: 'works' }, finish_reason: 'stop' }] }) + '\n\n', 'data: [DONE]\n\n'].join('');
        return new Response(events, { headers: { 'content-type': 'text/event-stream' } });
      }
      return Response.json({ id: 'chatcmpl_test', object: 'chat.completion', model: sent.model, choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 } });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };
  globalThis.fetch = fakeFetch;
  return {
    ADMIN_SECRET: ADMIN,
    GATEWAY_API_KEY: CLIENT_KEY,
    PROVIDER_ENCRYPTION_KEY: ENCRYPTION,
    UPSTASH_REDIS_REST_URL: 'https://redis.test',
    UPSTASH_REDIS_REST_TOKEN: 'redis-token-for-tests',
    PROVIDER_TIMEOUT_MS: '5000',
    ALLOWED_ORIGINS: '*'
  };
}
function request(path, { method = 'GET', body, auth = false, clientAuth = false } = {}) {
  const headers = new Headers();
  if (auth) headers.set('Authorization', `Bearer ${ADMIN}`);
  if (clientAuth) headers.set('Authorization', `Bearer ${CLIENT_KEY}`);
  if (body !== undefined) headers.set('Content-Type', 'application/json');
  return new Request(`https://gateway.test${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
}
afterEach(() => { if (originalFetch) globalThis.fetch = originalFetch; });

test('dashboard CSP allows same-origin fonts while keeping other sources restricted', async () => {
  originalFetch = globalThis.fetch;
  const env = makeEnv();
  env.ASSETS = { fetch: async () => new Response('<html></html>', { headers: { 'content-type': 'text/html' } }) };
  const response = await worker.fetch(request('/'), env);
  const policy = response.headers.get('content-security-policy');
  assert.match(policy, /default-src 'none'/);
  assert.match(policy, /font-src 'self'/);
  assert.match(policy, /img-src 'self' data:/);
  assert.doesNotMatch(policy, /font-src \*/);
});

test('base URL accepts public HTTPS hosts and rejects unsafe URL forms', () => {
  assert.equal(validateBaseUrl(BASE), BASE);
  assert.equal(validateBaseUrl('http://example.com/v1'), null);
  assert.equal(validateBaseUrl('https://127.0.0.1/v1'), null);
  assert.equal(validateBaseUrl('https://localhost/v1'), null);
  assert.equal(validateBaseUrl('https://user:pass@example.com'), null);
  assert.equal(validateBaseUrl('https://example.com/v1?key=x'), null);
});

test('registry migrates Google AI Studio keys, normalizes base URLs, and preserves other providers', () => {
  const legacy = { version: 1, providers: [
    { id: 'google-one', baseUrl: `${BASE}/`, encryptedKey: 'v1.a.b', modelIds: ['models/gemini-2.5-flash'] },
    { id: 'other-provider', baseUrl: 'https://openrouter.ai/api/v1', encryptedKey: 'v1.c.d', modelIds: ['other'] }
  ] };
  const migrated = parseRegistry(JSON.stringify(legacy));
  assert.equal(migrated.baseUrl, BASE);
  assert.equal(migrated.keys.length, 1);
  assert.equal(migrated.keys[0].legacy, true);
  assert.equal(migrated.keys[0].models[0], 'gemini-2.5-flash');
  assert.equal(migrated.legacyProviders.length, 1);
  assert.equal(migrated.legacyProviders[0].id, 'other-provider');
});

test('quota detection retries only explicit rate/quota rejections', () => {
  assert.equal(isQuotaFailure(429, ''), true);
  assert.equal(isQuotaFailure(403, 'RESOURCE_EXHAUSTED: quota exceeded'), true);
  assert.equal(isQuotaFailure(403, 'permission denied'), false);
  assert.equal(isQuotaFailure(500, 'internal error'), false);
  assert.equal(retryAfterSeconds('120'), 120);
});

test('all v1 endpoints reject missing or invalid client API keys', async () => {
  originalFetch = globalThis.fetch;
  const env = makeEnv();
  const missing = await worker.fetch(request('/v1/models'), env);
  assert.equal(missing.status, 401);
  assert.equal(missing.headers.get('www-authenticate'), 'Bearer');
  const invalidRequest = new Request('https://gateway.test/v1/models', { headers: { Authorization: 'Bearer wrong-key' } });
  const invalid = await worker.fetch(invalidRequest, env);
  assert.equal(invalid.status, 401);
  const health = await worker.fetch(request('/health'), env);
  assert.equal(health.status, 200);
});

test('v1 endpoints fail closed when the client API key secret is missing', async () => {
  originalFetch = globalThis.fetch;
  const env = makeEnv();
  delete env.GATEWAY_API_KEY;
  const response = await worker.fetch(request('/v1/models'), env);
  assert.equal(response.status, 503);
});

test('manager is private, exposes only the client key, and keeps provider keys encrypted', async () => {
  originalFetch = globalThis.fetch;
  const env = makeEnv();
  const denied = await worker.fetch(request('/admin/settings'), env);
  assert.equal(denied.status, 401);
  assert.equal((await denied.json()).error.type, 'authentication_error');
  const initial = await worker.fetch(request('/admin/settings', { auth: true }), env);
  assert.equal(initial.status, 200);
  assert.equal(initial.headers.get('cache-control'), 'no-store');
  const initialData = await initial.json();
  assert.equal(initialData.baseUrl, BASE);
  assert.equal(initialData.clientApiKey, CLIENT_KEY);
  assert.equal(JSON.stringify(initialData).includes(ADMIN), false);
  const added = await worker.fetch(request('/admin/keys', { method: 'POST', auth: true, body: { apiKey: 'google-test-secret-one' } }), env);
  assert.equal(added.status, 201);
  const saved = await added.json();
  assert.equal(saved.key.configured, true);
  assert.equal(JSON.stringify(saved).includes('google-test-secret-one'), false);
  const registry = JSON.parse(store.get('shade-ai-gateway:providers:v1'));
  assert.notEqual(registry.keys[0].encryptedKey, 'google-test-secret-one');
  const listing = await worker.fetch(request('/admin/settings', { auth: true }), env);
  const listed = await listing.json();
  assert.equal(listed.keys.length, 1);
  assert.equal(listed.clientApiKey, CLIENT_KEY);
  assert.equal(JSON.stringify(listed).includes('google-test-secret-one'), false);
});


test('manager does not return an invalid or unconfigured client key', async () => {
  originalFetch = globalThis.fetch;
  const env = makeEnv();
  delete env.GATEWAY_API_KEY;
  const response = await worker.fetch(request('/admin/settings', { auth: true }), env);
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.clientApiKey, null);
  assert.equal(JSON.stringify(data).includes(env.ADMIN_SECRET), false);
  env.GATEWAY_API_KEY = env.ADMIN_SECRET;
  const invalid = await worker.fetch(request('/admin/settings', { auth: true }), env);
  assert.equal((await invalid.json()).clientApiKey, null);
});

test('authenticated client rotates after an explicit 429 and cools down that key', async () => {
  originalFetch = globalThis.fetch;
  const env = makeEnv();
  for (const key of ['google-test-secret-one', 'google-test-secret-two']) {
    const response = await worker.fetch(request('/admin/keys', { method: 'POST', auth: true, body: { apiKey: key } }), env);
    assert.equal(response.status, 201);
  }
  const response = await worker.fetch(request('/v1/chat/completions', { method: 'POST', clientAuth: true, body: { model: 'models/gemini-2.5-flash', messages: [{ role: 'user', content: 'hello' }] } }), env);
  assert.equal(response.status, 200);
  assert.equal(lastUpstreamModel, 'models/gemini-2.5-flash');
  assert.equal(upstreamGenerateCalls, 2);
  const manager = await worker.fetch(request('/admin/settings', { auth: true }), env);
  const data = await manager.json();
  assert.equal(data.keys.filter(key => key.status === 'cooldown').length, 1);
});

test('ambiguous upstream 5xx is not retried', async () => {
  originalFetch = globalThis.fetch;
  const env = makeEnv();
  const added = await worker.fetch(request('/admin/keys', { method: 'POST', auth: true, body: { apiKey: 'google-test-secret-one' } }), env);
  assert.equal(added.status, 201);
  upstreamMode = 'ambiguous';
  const response = await worker.fetch(request('/v1/chat/completions', { method: 'POST', clientAuth: true, body: { model: 'gemini-2.5-flash', messages: [{ role: 'user', content: 'hello' }] } }), env);
  assert.equal(response.status, 500);
  assert.equal(upstreamGenerateCalls, 1);
});

test('model listing requires client authentication and returns discovered models', async () => {
  originalFetch = globalThis.fetch;
  const env = makeEnv();
  await worker.fetch(request('/admin/keys', { method: 'POST', auth: true, body: { apiKey: 'google-test-secret-one' } }), env);
  const response = await worker.fetch(request('/v1/models', { clientAuth: true }), env);
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.deepEqual(data.data.map(item => item.id), ['gemini-2.5-flash', 'gemini-2.5-pro']);
  const flash = data.data[0];
  assert.equal(flash.displayName, 'Gemini 2.5 Flash');
  assert.equal(flash.description, 'Fast model');
  assert.equal(flash.inputTokenLimit, 1048576);
  assert.deepEqual(flash.supportedGenerationMethods, ['generateContent', 'countTokens']);
  assert.equal(data.data[1].displayName, 'Gemini 2.5 Pro');
});


test('chat completion request is forwarded unchanged to the Gemini OpenAI-compatible endpoint', async () => {
  originalFetch = globalThis.fetch;
  const env = makeEnv();
  upstreamMode = 'success';
  await worker.fetch(request('/admin/keys', { method: 'POST', auth: true, body: { apiKey: 'google-test-secret-one' } }), env);
  const sent = { model: 'gemini-4-hydrogen', messages: [{ role: 'user', content: 'hello' }], temperature: 0.2, max_tokens: 20, tools: [{ type: 'function', function: { name: 'tool_describe', parameters: { type: 'object' } } }] };
  const response = await worker.fetch(request('/v1/chat/completions', { method: 'POST', clientAuth: true, body: sent }), env);
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.object, 'chat.completion');
  assert.equal(data.choices[0].message.content, 'ok');
  assert.equal(data.usage.total_tokens, 3);
  assert.equal(upstreamGenerateCalls, 1);
});

test('OpenAI-compatible SSE is passed through without translating chunks', async () => {
  originalFetch = globalThis.fetch;
  const env = makeEnv();
  upstreamMode = 'success';
  await worker.fetch(request('/admin/keys', { method: 'POST', auth: true, body: { apiKey: 'google-test-secret-one' } }), env);
  const response = await worker.fetch(request('/v1/chat/completions', { method: 'POST', clientAuth: true, body: { model: 'gemini-4-hydrogen', stream: true, messages: [{ role: 'user', content: 'hello' }] } }), env);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type').startsWith('text/event-stream'), true);
  const stream = await response.text();
  assert.match(stream, /"content":"stream "/);
  assert.match(stream, /"content":"works"/);
  assert.equal(stream.endsWith('data: [DONE]\n\n'), true);
});

test('active SSE streams can outlive the provider timeout without being aborted', async () => {
  originalFetch = globalThis.fetch;
  const env = makeEnv();
  env.PROVIDER_TIMEOUT_MS = '1000';
  upstreamMode = 'slow-stream';
  await worker.fetch(request('/admin/keys', { method: 'POST', auth: true, body: { apiKey: 'google-test-secret-one' } }), env);
  const response = await worker.fetch(request('/v1/chat/completions', { method: 'POST', clientAuth: true, body: { model: 'gemini-4-hydrogen', stream: true, messages: [{ role: 'user', content: 'hello' }] } }), env);
  assert.equal(response.status, 200);
  const stream = await response.text();
  assert.match(stream, /data: first/);
  assert.match(stream, /data: second/);
  assert.match(stream, /data: third/);
  assert.match(stream, /data: \[DONE\]/);
});

test('strips only Gemini-incompatible prompt_cache_key and preserves the rest of the request', async () => {
  originalFetch = globalThis.fetch;
  const env = makeEnv();
  upstreamMode = 'success';
  await worker.fetch(request('/admin/keys', { method: 'POST', auth: true, body: { apiKey: 'google-test-secret-one' } }), env);
  const input = {
    model: 'gemini-3.8-flash',
    messages: [{ role: 'user', content: 'hello' }],
    prompt_cache_key: 'openai-cache-key',
    temperature: 0.7,
    max_tokens: 17
  };
  const response = await worker.fetch(request('/v1/chat/completions', { method: 'POST', clientAuth: true, body: input }), env);
  assert.equal(response.status, 200);
  assert.deepEqual(lastUpstreamBody, {
    model: 'gemini-3.8-flash',
    messages: [{ role: 'user', content: 'hello' }],
    temperature: 0.7,
    max_tokens: 17
  });
});