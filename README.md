# Shade AI Gateway — the ELI5 guide

Shade is a small front door for AI APIs. Your apps talk to Shade once. Shade sends each request to one of the AI services you connected, and can try another connected service if the first one is busy.

This version includes a real provider manager at the same HTTPS address as the gateway. It saves provider details in the existing Upstash Redis database. It does **not** put provider keys in browser storage or in a downloadable JSON file.

## The short version

- The provider page has exactly three inputs per provider: **provider name**, **base URL**, and **API key**.
- There is no provider-count setting in the page: add or remove providers as needed. Redis storage has a practical size limit. The page has no model-ID, alias, priority, timeout, or rate-limit settings.
- Provider keys are encrypted with AES-GCM before they are saved in Redis. The encryption password lives in a Cloudflare Worker secret, separately from the admin password.
- The page never gets a saved API key back. It only gets a “Key saved” status. The key box is blank when you return.
- The gateway speaks the OpenAI chat-completions format. Point an OpenAI-compatible client at the Shade URL and use the gateway key—not a provider key.

## What is where?

- `dashboard/index.html` is the small provider-manager page.
- `src/index.js` is the gateway and protected admin API.
- `wrangler.toml` tells Cloudflare to serve the page and Worker together.
- Provider records are stored in the existing Upstash Redis database under a Shade-owned key. No new paid database is needed.

The old hand-edited `PROVIDERS` JSON file is no longer how providers are configured. Names, URLs, and encrypted keys come from the manager. The Worker makes its internal provider ID automatically; you do not need to make secret names or edit code for each provider.

## Put it online

You need a Cloudflare account, the existing Upstash database, Node.js 22 or newer, and npm. This repository is designed for Cloudflare Workers and uses the free-tier approach; actual account quotas still apply.

1. Download or clone this repository, then run `npm ci`.
2. Connect Wrangler to the Cloudflare account with `npx wrangler login`.
3. Add the existing Upstash REST URL and write token as **Worker secrets**. Run each command and paste its value only into Wrangler’s private prompt:

   ```sh
   npx wrangler secret put UPSTASH_REDIS_REST_URL
   npx wrangler secret put UPSTASH_REDIS_REST_TOKEN
   ```

4. Make **three different** strong random secrets. Run `openssl rand -hex 32` three separate times. Keep each value in a password manager, then run the matching Wrangler command and paste that value only into Wrangler’s private prompt:

   ```sh
   npx wrangler secret put ADMIN_SECRET
   npx wrangler secret put PROVIDER_ENCRYPTION_KEY
   npx wrangler secret put GATEWAY_API_KEY
   ```

   `ADMIN_SECRET` unlocks the provider page. `PROVIDER_ENCRYPTION_KEY` locks and unlocks provider keys inside Redis. `GATEWAY_API_KEY` is what your apps send to Shade. They must be different secrets. Do not put these values in Git, a public web variable, or a screenshot.

5. Deploy the Worker and page together:

   ```sh
   npm test
   npx wrangler deploy
   ```

6. Open the `workers.dev` address shown by Wrangler. The provider page is `/`. It will ask for `ADMIN_SECRET` using a browser prompt. That password is kept only in the current tab’s memory.

Cloudflare encrypts Worker secrets for the service. The API key used by an AI provider is entered later in the provider page; it does not need to be added to Cloudflare one provider at a time.

## Add a provider (only three fields)

1. Open the Shade page over HTTPS and unlock it with `ADMIN_SECRET`.
2. Click **Add provider**.
3. Enter the provider’s name, its OpenAI-compatible API base URL, and its API key. The base URL should stop before `/chat/completions` (for example, use the provider’s `/v1` URL).
4. Click **Save provider**. Shade checks the provider’s `/models` address when it can, encrypts the key, and saves the record in Redis.
5. Come back later and the name and base URL will still be there. The key box will be empty and say that a key is saved. Leave it blank to keep the saved key; enter a replacement key to rotate it.
6. To disconnect a provider, click **Remove**. This deletes its saved encrypted key as well as its entry.

The page sends the key directly to the protected Worker over HTTPS. It does not write it to `localStorage`, `sessionStorage`, a cookie, or a JSON export. The Worker does not return it in list/create/update responses and does not log request bodies or upstream error bodies.

## Use Shade from an app

Use the URL printed by Cloudflare as the API base. If the Worker address is `https://shade-ai-gateway.example.workers.dev`, the chat endpoint is `https://shade-ai-gateway.example.workers.dev/v1/chat/completions`.

```sh
curl https://YOUR-WORKER.workers.dev/v1/chat/completions \
  -H "Authorization: Bearer $GATEWAY_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "fast",
    "messages": [{"role": "user", "content": "Explain rate limits briefly."}]
  }'
```

To see available names, call `GET /v1/models` with the same gateway key. `GET /health` is a simple status check. The health response does not reveal provider URLs or keys.

## How automatic model routing works

You do not configure model IDs in the page. When you save a provider, Shade tries its OpenAI-compatible `GET <base URL>/models` endpoint. If it returns a model list:

- `default` means the first model the provider listed.
- `fast` means a model whose name looks like a small/quick model (such as one containing `mini`, `flash`, `haiku`, or `fast`); if none looks that way, it uses the first listed model.
- `reasoning` is offered only when a model name looks like a reasoning/thinking model (for example `reason`, `think`, `o1`, `r1`, `pro`, or `opus`).
- Shade also lists the exact model IDs it discovered.

The same alias can point to a different real model at each provider. If the first provider is busy, Shade can pass `fast` to the next provider using that provider’s own inferred fast model. If a provider does not offer `/models`, Shade still saves it; it can receive an exact model ID sent by the client, but automatic aliases cannot be inferred for that provider. A model ID that only one provider lists can only fail over to providers that list that same ID. These guesses are convenience defaults, not a promise that two providers’ models behave alike.

## What the gateway does when a provider has a problem

Shade uses the shared Redis rate limiter before making an upstream call. By default the gateway key is limited to 60 requests and about 100,000 estimated tokens per minute. The token count is an estimate based on request size and the requested output budget; the AI provider’s own count is the final word. These are fixed one-minute windows, not an exact sliding token bucket.

A provider timeout before a successful response starts, network failure, HTTP 408/409/425/429, or server-side 5xx response can move the request to another eligible provider. The timeout also closes a response stream if it stops sending chunks for too long. Once Shade has started returning a successful response to the app, it cannot safely swap providers mid-answer; a later stream interruption is returned to the app rather than replayed. For temporary failures, the gateway waits for a short, increasing delay with random jitter between attempts. It reads an upstream `Retry-After` value and returns a bounded retry suggestion if every provider fails. Other provider errors return a generic message and status; Shade does not send the provider’s raw error text back to the app because it could contain private details.

Streaming replies are returned as a stream, without buffering the whole answer first. This version focuses on OpenAI-compatible chat completions. It does not translate native Anthropic/Gemini-only APIs or promise tool calling, image/audio input, structured output, per-user keys, queues, caching, usage dashboards, or circuit breakers.

If Redis cannot be reached, Shade fails closed with a 503. It does not quietly turn off the shared rate limit.

## Keeping it safe

- Use HTTPS for the dashboard and gateway. Keep `ADMIN_SECRET`, `GATEWAY_API_KEY`, `PROVIDER_ENCRYPTION_KEY`, and Upstash credentials as Worker secrets.
- Keep the admin and encryption secrets separate. If the encryption secret is lost, saved provider keys cannot be decrypted; add them again after setting a new encryption secret.
- Save a copy of the gateway and admin secrets somewhere private before deploying. Do not paste provider API keys into chat, Git, issues, or public frontend variables.
- The admin password protects provider management, and the gateway key protects model calls. Anyone who gets the gateway key may use the connected providers and their billing quotas.
- The manager accepts HTTPS hostnames only and rejects literal IP addresses, local/internal hostnames, credentials in URLs, and nonstandard ports. Before saving and before sending a request, Shade checks the hostname’s public DNS answers and rejects private/reserved IPv4 or IPv6 addresses. Cloudflare still performs its own DNS lookup for the connection, so Shade cannot pin that address against a later DNS change; only add provider hosts you trust.
- If the admin password may have leaked, replace `ADMIN_SECRET` in Worker secrets. If the encryption password may have leaked, treat saved keys as exposed, rotate them at their providers, and replace them in the manager after updating the encryption secret.

## Quick troubleshooting

- **The page says “Admin authentication failed.”** Check that you used `ADMIN_SECRET`, not the gateway key. If you just changed it, reload the page and unlock again.
- **The page says storage is unavailable.** Check the two Upstash Worker secrets and that the existing database is active and reachable. Do not paste its credentials into the browser.
- **A provider saves but no `fast` or `reasoning` choice appears.** That provider may not have an OpenAI-compatible `/models` endpoint, or it may not return model names that match those hints. Try its exact model ID from the client if known.
- **Shade returns “No configured provider supports this model route.”** Check `GET /v1/models`; try `fast`, `default`, or an exact listed model ID.
- **Shade returns 503 after trying providers.** Check provider status, base URL, API key, provider quotas, and Upstash health. Shade hides raw provider errors on purpose; check the provider’s own console for its detailed reason.
- **A browser app gets a CORS error.** Set the Worker variable `ALLOWED_ORIGINS` to the exact website origin(s), comma-separated (for example, `https://app.example.com`). Do not use `*` for a public app.
- **A provider key was changed but requests still fail.** Replace the key in that provider card and save it. A blank key field means “keep the current key,” not “delete it.”

## Test it

```sh
npm ci
npm test
npm run check
```

The tests use fake Redis, fake DNS answers, and fake providers. They check authentication, URL/DNS validation, encrypted storage, redacted provider listing, create/update/delete, duplicate prevention, model routing, failover, idle-stream timeouts, request-size limits, health, and that secrets are not returned in responses. They do not require real AI-provider keys.
