import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import worker, { validateBaseUrl, parseRegistry, isQuotaFailure, retryAfterSeconds } from '../src/index.js';

const ADMIN = 'admin-secret-for-tests-only-0123456789';
const ENCRYPTION = 'encryption-secret-for-tests-only-0123456789';
const BASE = 'https://generativelanguage.googleapis.com/v1beta/openai';
let originalFetch;
let store;
let upstreamChatCalls;
let upstreamMode;
let lastUpstreamModel;

function makeEnv() {
  store = new Map();
  upstreamChatCalls = 0;
  upstreamMode = 'rotate';
  lastUpstreamModel = null;
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
    if (url.hostname === 'generativelanguage.googleapis.com' && url.pathname.endsWith('/models')) {
      return Response.json({ data: [{ id: 'gemini-2.5-flash' }, { id: 'gemini-2.5-pro' }] });
    }
    if (url.hostname === 'generativelanguage.googleapis.com' && url.pathname.endsWith('/chat/completions')) {
      upstreamChatCalls++;
      lastUpstreamModel = JSON.parse(init.body).model;
      if (upstreamMode === 'rotate' && upstreamChatCalls === 1) return new Response(JSON.stringify({ error: { message: 'RESOURCE_EXHAUSTED rate limit' } }), { status: 429, headers: { 'retry-after': '60', 'content-type': 'application/json' } });
      if (upstreamMode === 'ambiguous') return new Response(JSON.stringify({ error: { message: 'server error' } }), { status: 500 });
      return Response.json({ id: 'chatcmpl-test', choices: [{ message: { content: 'ok' } }] });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };
  globalThis.fetch = fakeFetch;
  return {
    ADMIN_SECRET: ADMIN,
    PROVIDER_ENCRYPTION_KEY: ENCRYPTION,
    UPSTASH_REDIS_REST_URL: 'https://redis.test',
    UPSTASH_REDIS_REST_TOKEN: 'redis-token-for-tests',
    CLIENT_RPM: '60', CLIENT_TPM: '100000', PROVIDER_TIMEOUT_MS: '5000',
    ALLOWED_ORIGINS: '*'
  };
}
function request(path, { method = 'GET', body, auth = false } = {}) {
  const headers = new Headers();
  if (auth) headers.set('Authorization', `Bearer ${ADMIN}`);
  if (body !== undefined) headers.set('Content-Type', 'application/json');
  return new Request(`https://gateway.test${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
}
afterEach(() => { if (originalFetch) globalThis.fetch = originalFetch; });

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

test('manager is private, saves encrypted keys, and exposes no raw key', async () => {
  originalFetch = globalThis.fetch;
  const env = makeEnv();
  const denied = await worker.fetch(request('/admin/settings'), env);
  assert.equal(denied.status, 401);
  const initial = await worker.fetch(request('/admin/settings', { auth: true }), env);
  assert.equal(initial.status, 200);
  assert.equal((await initial.json()).baseUrl, BASE);
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
  assert.equal(JSON.stringify(listed).includes('google-test-secret-one'), false);
});

test('keyless client rotates after an explicit 429 and cools down that key', async () => {
  originalFetch = globalThis.fetch;
  const env = makeEnv();
  for (const key of ['google-test-secret-one', 'google-test-secret-two']) {
    const response = await worker.fetch(request('/admin/keys', { method: 'POST', auth: true, body: { apiKey: key } }), env);
    assert.equal(response.status, 201);
  }
  const response = await worker.fetch(request('/v1/chat/completions', { method: 'POST', body: { model: 'models/gemini-2.5-flash', messages: [{ role: 'user', content: 'hello' }] } }), env);
  assert.equal(response.status, 200);
  assert.equal(lastUpstreamModel, 'gemini-2.5-flash');
  assert.equal(upstreamChatCalls, 2);
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
  const response = await worker.fetch(request('/v1/chat/completions', { method: 'POST', body: { model: 'gemini-2.5-flash', messages: [{ role: 'user', content: 'hello' }] } }), env);
  assert.equal(response.status, 502);
  assert.equal(upstreamChatCalls, 1);
});

test('model listing is keyless and returns discovered models', async () => {
  originalFetch = globalThis.fetch;
  const env = makeEnv();
  await worker.fetch(request('/admin/keys', { method: 'POST', auth: true, body: { apiKey: 'google-test-secret-one' } }), env);
  const response = await worker.fetch(request('/v1/models'), env);
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.deepEqual(data.data.map(item => item.id), ['gemini-2.5-flash', 'gemini-2.5-pro']);
});
