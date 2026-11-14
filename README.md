# Shade AI Gateway

Provider-agnostic OpenAI-compatible API gateway for Cloudflare Workers. It adds one endpoint in front of multiple OpenAI-compatible providers, with shared Redis-backed RPM/TPM limits, model-alias routing, provider failover, timeouts, and health checks.

## Included
- POST /v1/chat/completions — OpenAI-compatible chat-completions proxy.
- GET /v1/models — configured model aliases.
- GET /health — gateway and Redis health.
- Provider selection by requested model alias.
- Failover on provider throttling (429), overload (5xx), timeout, and network errors.
- Shared per-client RPM/TPM and per-provider RPM/TPM counters in Upstash Redis.
- Streaming responses passed through without buffering.
- No prompts or provider credentials are logged or persisted.

## Current limitation
This release supports OpenAI-compatible chat-completions APIs. It does not yet normalize native Anthropic/Gemini APIs, provider-specific tool-call differences, image/audio APIs, or structured-output extensions.

## Configure Worker secrets and variables
Required:
- GATEWAY_API_KEY — client-facing bearer key.
- UPSTASH_REDIS_REST_URL — Upstash REST URL.
- UPSTASH_REDIS_REST_TOKEN — Upstash REST token.
- PROVIDERS — JSON array described below.
- Provider keys such as GOOGLE_API_KEY and OPENROUTER_API_KEY.

Optional:
- CLIENT_RPM (default 60)
- CLIENT_TPM (default 100000)
- PROVIDER_TIMEOUT_MS (default 45000)
- ALLOWED_ORIGINS (comma-separated origins)

## Provider registry example
[
  {
    "id": "google",
    "baseUrl": "https://generativelanguage.googleapis.com/v1beta/openai",
    "apiKeyEnv": "GOOGLE_API_KEY",
    "priority": 10,
    "timeoutMs": 45000,
    "limits": { "rpm": 15, "tpm": 250000 },
    "models": { "fast": "gemini-2.5-flash", "reasoning": "gemini-2.5-pro" }
  },
  {
    "id": "openrouter",
    "baseUrl": "https://openrouter.ai/api/v1",
    "apiKeyEnv": "OPENROUTER_API_KEY",
    "priority": 20,
    "limits": { "rpm": 30, "tpm": 100000 },
    "models": { "fast": "google/gemini-2.5-flash", "reasoning": "deepseek/deepseek-r1" }
  }
]

Use the same alias (for example fast) across providers to make it eligible for failover. Provider limits are local safety caps; set them at or below actual provider limits. A value of 0 disables that provider cap.

## Deploy
1. Create a Cloudflare Worker named shade-ai-gateway.
2. Set the variables and secrets above in Worker Settings.
3. Deploy src/index.js with wrangler or the Cloudflare dashboard.
4. Set the compatibility date from wrangler.toml.
5. Test /health, /v1/models, and /v1/chat/completions.

## Example request
curl https://YOUR-WORKER.workers.dev/v1/chat/completions \
  -H "Authorization: Bearer $GATEWAY_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"fast","messages":[{"role":"user","content":"Explain rate limits briefly."}]}'

## Behavior and safety
- A provider is eligible only when its API key is present and its model map contains the requested alias.
- Providers are tried by ascending priority.
- Provider-level 429/408/409/425/5xx and network/timeouts move to the next eligible provider.
- Other upstream 4xx responses return immediately because they usually indicate invalid requests or credentials.
- If Redis is unavailable, the gateway fails closed with 503 rather than bypassing shared rate limits.
- Fixed 60-second windows are used in this first release; provider-side token accounting remains authoritative.
- Token estimates are approximate (serialized character count divided by four plus requested output budget).

## Security
- Keep gateway and provider keys in Worker secrets, never in Git.
- Restrict ALLOWED_ORIGINS for browser clients.
- This initial release uses one shared client key. Per-app keys and usage attribution are planned for a later iteration.
