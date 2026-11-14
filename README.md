# Shade AI Gateway

A provider-agnostic, OpenAI-compatible AI gateway for Cloudflare Workers. One client API routes requests across Google AI Studio, OpenRouter, and any number of custom OpenAI-compatible endpoints.

## Current MVP

- `POST /v1/chat/completions` — OpenAI-compatible chat-completions proxy.
- `GET /v1/models` — model aliases enabled in provider configuration.
- `GET /health` — gateway and Redis health.
- Unlimited provider entries in the `PROVIDERS` JSON registry.
- Shared Upstash Redis RPM/TPM enforcement.
- Per-provider RPM/TPM safety caps.
- Model-alias routing and ordered provider failover.
- Failover for 408, 409, 425, 429, 5xx, network errors, and timeouts.
- Streaming responses passed through without buffering.
- Provider API keys are read from Worker secrets, not stored in the registry or Git.

## Provider model

Every provider entry has:
- `id`: unique stable identifier.
- `baseUrl`: OpenAI-compatible API base URL, without the final `/chat/completions`.
- `apiKeyEnv`: Worker secret name containing the provider key.
- `priority`: lower number is tried first.
- `limits.rpm` and `limits.tpm`: local safety limits; 0 disables a local cap.
- `models`: map of public aliases to that provider's real model IDs.

A single alias can map to different real models on different providers. For example, the client sends `model: "fast"`; Google may receive `gemini-2.5-flash` and OpenRouter may receive `google/gemini-2.5-flash`. If the first provider is throttled, the gateway tries the next eligible provider with the same alias.

## Google AI Studio and OpenRouter

Use `providers.example.json` as the starting configuration. It includes Google AI Studio and OpenRouter entries plus a custom-provider template. Replace the example model IDs with the models enabled for your accounts.

Google OpenAI-compatible base URL:
`https://generativelanguage.googleapis.com/v1beta/openai`

OpenRouter base URL:
`https://openrouter.ai/api/v1`

## Add multiple custom providers

No code change is required for providers that expose an OpenAI-compatible `/chat/completions` endpoint.

1. Add another object to the `PROVIDERS` JSON array.
2. Give it a unique `id`, its `baseUrl`, and a new `apiKeyEnv` secret name.
3. Add that API key as a Cloudflare Worker secret.
4. Add one or more aliases under `models`.
5. Set its priority and provider-side RPM/TPM safety caps.

Example:

```json
{
  "id": "my-custom-provider",
  "baseUrl": "https://api.example.com/v1",
  "apiKeyEnv": "CUSTOM_PROVIDER_API_KEY",
  "priority": 30,
  "timeoutMs": 45000,
  "limits": { "rpm": 20, "tpm": 80000 },
  "models": {
    "fast": "vendor/model-fast",
    "reasoning": "vendor/model-reasoning"
  }
}
```

Repeat this object for as many custom providers as needed. Use distinct IDs and secret names. The provider must be OpenAI-compatible; native Anthropic, Gemini-only, or other proprietary APIs need an adapter before they can be added.

## Worker configuration

Required Worker variables/secrets:
- `GATEWAY_API_KEY` — client-facing bearer key.
- `UPSTASH_REDIS_REST_URL` — Upstash REST URL.
- `UPSTASH_REDIS_REST_TOKEN` — Upstash REST token.
- `PROVIDERS` — JSON array of provider definitions.
- Provider secrets referenced by each `apiKeyEnv`, e.g. `GOOGLE_API_KEY`, `OPENROUTER_API_KEY`, `CUSTOM_PROVIDER_API_KEY`.

Optional:
- `CLIENT_RPM` (default 60)
- `CLIENT_TPM` (default 100000)
- `PROVIDER_TIMEOUT_MS` (default 45000)
- `ALLOWED_ORIGINS` (comma-separated origins)

Example secret commands:

```bash
npx wrangler secret put GATEWAY_API_KEY
npx wrangler secret put UPSTASH_REDIS_REST_TOKEN
npx wrangler secret put GOOGLE_API_KEY
npx wrangler secret put OPENROUTER_API_KEY
npx wrangler secret put CUSTOM_PROVIDER_API_KEY
```

Set `UPSTASH_REDIS_REST_URL` and `PROVIDERS` as Worker variables. Keep all credentials out of Git and client-side code.

## Use

```bash
curl https://YOUR-WORKER.workers.dev/v1/chat/completions \
  -H "Authorization: Bearer $GATEWAY_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "fast",
    "messages": [{"role": "user", "content": "Explain rate limits briefly."}]
  }'
```

Clients only need the gateway URL and gateway key. They do not need provider-specific keys.

## Important behavior and limitations

- Only providers with a configured API key and a matching model alias are eligible.
- Providers are tried by ascending priority.
- Retryable provider failures move to the next provider. Other 4xx responses return immediately because they usually indicate invalid requests or credentials.
- If Redis is unavailable, the gateway fails closed with 503 rather than bypassing shared rate limits.
- The current rate limiter uses fixed 60-second windows, not a smooth token bucket.
- TPM estimation is approximate (serialized request size divided by four plus the requested output budget); upstream provider accounting remains authoritative.
- The current release supports OpenAI-compatible chat completions only. It does not yet normalize provider-specific tool calling, structured outputs, image/audio APIs, or native Anthropic/Gemini APIs.
- The current release uses one shared gateway client key. Per-app keys, durable request queues, usage analytics, caching, circuit breakers, and a provider management UI are follow-up work.

## Security

- Keep gateway and provider keys in Worker secrets, never in Git.
- Restrict `ALLOWED_ORIGINS` for browser clients.
- Use a separate gateway key per client when per-client quotas are required; this MVP currently has a single shared client identity.
