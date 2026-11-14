# Shade AI Gateway

A keyless, OpenAI-compatible gateway for a private pool of Google AI Studio API keys.

## Client configuration

Use one base URL in your app:

```js
baseURL: "https://shade-ai-gateway.shifatmasud.workers.dev/v1"
```

No Google API key or Shade gateway API key is required in the client. Use a model ID returned by `GET /v1/models` (for example, `gemini-2.5-flash`). The gateway rate-limits clients by Cloudflare's client IP header.

**Access note:** this is intentionally a public, keyless endpoint. Anyone who knows the URL can call it. Per-IP RPM/TPM limits reduce accidental abuse but are not authentication; do not treat the URL as a strong access-control boundary.

## Private manager

The manager is served at `/`. Its private capability link carries the admin token in the URL fragment (`#manage=...`). The fragment is not sent in HTTP requests. The dashboard keeps the token in page memory only and sends it in an Authorization header to same-origin `/admin/*` endpoints. Do not share the link.

The manager exposes only:
- One shared Google AI Studio OpenAI-compatible base URL.
- Multiple Google AI Studio API key slots.

Raw API keys are encrypted with AES-GCM before being stored in Upstash Redis. The manager never receives a saved key again.

## Key rotation behavior

- Requests are distributed across eligible keys using a Redis-backed rotating counter.
- An explicit upstream `429` cools that key down using `Retry-After` (bounded to 1–60 minutes).
- A `403` is treated as quota exhaustion only when the response body clearly identifies quota/rate/billing exhaustion.
- A request is not retried after ambiguous network errors, timeouts, generic `5xx`, or other failures, avoiding accidental duplicate model usage.
- When every key is cooling down, the gateway returns `503` with `Retry-After`.

## Endpoints

- `GET /health` — gateway and Redis health.
- `GET /v1/models` — merged model list; no client key required.
- `POST /v1/chat/completions` — OpenAI-compatible chat completions; no client key required.
- `/admin/settings` — private manager settings.
- `/admin/keys` — private key-pool management.

## Cloudflare configuration

Required Worker secrets:
- `ADMIN_SECRET` — random private manager capability token, at least 32 characters.
- `PROVIDER_ENCRYPTION_KEY` — stable random encryption secret, at least 32 characters. **Do not rotate this without first re-encrypting stored keys.**
- `UPSTASH_REDIS_REST_URL`
- `UPSTASH_REDIS_REST_TOKEN`

`GATEWAY_API_KEY` is no longer used by the keyless client API.

Worker variables:
- `CLIENT_RPM` (default 60)
- `CLIENT_TPM` (default 100000)
- `PROVIDER_TIMEOUT_MS` (default 45000)
- `ALLOWED_ORIGINS` (default `*` for browser clients)

The configured upstream base URL is validated as HTTPS and checked against public DNS addresses to reduce SSRF risk.

## Local checks

```sh
npm test
npm run check
```
