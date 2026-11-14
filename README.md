# Shade AI Gateway

An API-key-protected, OpenAI-compatible gateway for a private pool of Google AI Studio API keys.

## Client configuration

Use one base URL in your app:

```js
baseURL: "https://shade-ai-gateway.shifatmasud.workers.dev/v1",
apiKey: "YOUR_SHADE_API_KEY"
```

Every `/v1/*` request requires the shared Shade client key in the standard `Authorization: Bearer` header. Use a model ID returned by `GET /v1/models` (for example, `gemini-2.5-flash`). The Google AI Studio provider keys remain server-side.

There is no IP-based access control, request rate limiting, or token quota. Anyone with the client API key can use the gateway, so share it only with trusted clients and rotate it if exposed.

## Private manager

The manager is served at `/`. Its private capability link carries the admin token in the URL fragment (`#manage=...`). The fragment is not sent in HTTP requests. The dashboard keeps the token in page memory only and sends it in an Authorization header to same-origin `/admin/*` endpoints. Do not share the link.

The authenticated manager shows the shared client bearer key from `GATEWAY_API_KEY` (masked by default, with explicit reveal/copy controls), the upstream base URL, and provider key-pool metadata. The client key is returned only from the admin-authenticated settings endpoint with `no-store` caching and is never included in the public client panel.

Upstream provider API keys are encrypted with AES-GCM before being stored in Upstash Redis. The manager never receives a saved provider key again.

## Key rotation behavior

- Requests are distributed across eligible keys using a Redis-backed rotating counter.
- An explicit upstream `429` cools that key down using `Retry-After` (bounded to 1–60 minutes).
- A `403` is treated as quota exhaustion only when the response body clearly identifies quota/rate/billing exhaustion.
- A request is not retried after ambiguous network errors, timeouts, generic `5xx`, or other failures, avoiding accidental duplicate model usage.
- When every key is cooling down, the gateway returns `503` with `Retry-After`.

## Endpoints

- `GET /health` — gateway and Redis health.
- `GET /v1/models` — merged model list; requires the Shade client API key.
- `POST /v1/chat/completions` — OpenAI-compatible chat completions; requires the Shade client API key.
- `/admin/settings` — private manager settings.
- `/admin/keys` — private key-pool management.

## Cloudflare configuration

Required Worker secrets:
- `ADMIN_SECRET` — random private manager capability token, at least 32 characters.
- `PROVIDER_ENCRYPTION_KEY` — stable random encryption secret, at least 32 characters. **Do not rotate this without first re-encrypting stored keys.**
- `GATEWAY_API_KEY` — shared client API key, at least 32 characters. Keep it different from the admin and encryption secrets.
- `UPSTASH_REDIS_REST_URL`
- `UPSTASH_REDIS_REST_TOKEN`

Worker variables:
- `PROVIDER_TIMEOUT_MS` (default 45000)
- `ALLOWED_ORIGINS` (default `*` for browser clients)

The configured upstream base URL is validated as HTTPS and checked against public DNS addresses to reduce SSRF risk.

## Local checks

```sh
npm test
npm run check
```
