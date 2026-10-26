# n8n workflows

Exported copies of the product's n8n workflows. Both are exported inactive and are new workflows only; the
existing workflows on the n8n instance are not touched.

## Marketing — daily heartbeat

`marketing-daily-heartbeat.json`. Runs at 02:30 Asia/Kolkata and proves the n8n-to-core path with one signed
request: `POST /api/v1/triggers/daily` with the body `{"workflow":"marketing-daily-heartbeat"}`.

Node chain: Daily 02:30, Build request (body, path, timestamp), Generate nonce, Hash body, Build signing text,
Sign text, Call core.

- The signed text is five lines joined by a line feed: `POST`, the path, the timestamp, the nonce and the
  SHA-256 hex of the body. The signature is the HMAC-SHA256 hex of that text. This must stay equal to the
  core's `signingText` and `sign` (`apps/core/src/triggers/signature.ts`); `tools/n8n/workflows.test.mjs`
  fails if either side drifts.
- Call core sends the exact signed body string as a raw body with content type `application/json`, and the
  headers `X-Mkt-Timestamp`, `X-Mkt-Nonce` and `X-Mkt-Signature`. The signed path has no query string.
- A failed call (the core answers 502 when a duty fails) leaves through the error output, waits 10 minutes
  and goes back to Build request, so every retry has a new timestamp, a new nonce and a new signature. There
  are 3 retries after the first try, then the run ends. Nothing else is notified: the core's missing-heartbeat
  alert is the alarm.

## Marketing — canary

`marketing-canary.json`. Runs every minute and records its own run time (`ranAt`). It makes no outside call.
Its execution times are read from n8n in milestone 7 to measure whether the product affects n8n.

## What the instance needs

| Name                       | Kind                      | Purpose                                                                     |
| -------------------------- | ------------------------- | --------------------------------------------------------------------------- |
| `Marketing trigger secret` | Credential of type Crypto | Holds the shared trigger secret; the Sign text node uses it. Never a field. |
| `MKT_CORE_ORIGIN`          | n8n variable              | Origin of the core (scheme and host). The workflow files hold no address.   |

## Import

1. Create the credential `Marketing trigger secret` (type Crypto) with the shared trigger secret, and the
   variable `MKT_CORE_ORIGIN`.
2. Import each JSON file (Workflows, Import from file). In the heartbeat, open Sign text and select the
   credential `Marketing trigger secret`.
3. Leave both inactive until the core is reachable from n8n (milestone 7), then activate them.
