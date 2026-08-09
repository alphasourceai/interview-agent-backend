# Tavus HTTP reliability — production reconstruction record

## Scope and identity

- Finding: Senior QA/Database Engineer Finding #7
- Accepted QA source: `07b7b9b57fe662489388ea93373243521c76abb4`
- Production repository: `alphasourceai/interview-agent-backend`
- Production branch: `prod-backend-legacy`
- Reconstruction baseline: `43f45a44a3a8575aab9933088cfe54340ccb33e0`
- Initially deployed backend: `94058ac3069b6d1234ebe5695d47a6fa9e531b41`
- Database migration: none
- Frontend/PAL change: none

This change reconstructs only the accepted QA Tavus transport-reliability
contract. It does not redesign webhook authentication, callback processing,
Recovery Core, the interview timer or closing sequence, rubric behavior,
frontend contracts, or database authorization.

## Pre-change outbound inventory

| Class | Source / function | Operation | Before | Classification |
| --- | --- | --- | --- | --- |
| Active | `handlers/createTavusInterview.js` / `createTavusInterviewHandler` | `POST /v2/conversations` | axios, no timeout/retry | `NOT_SAFE_TO_RETRY` |
| Active | `lib/tavusDocuments.js` / `createTavusDocument` | `POST /v2/documents` | axios, 15 s timeout, no retry | `NOT_SAFE_TO_RETRY` |
| Active | `src/lib/tavusVendorReconciliation.js` / `findExactConversations` | `GET /v2/conversations` | axios, no timeout/retry | `SAFE_TO_RETRY` |
| Active | `src/lib/platformHealth/tavusHealth.js` / `fetchTavusConversationPage` | `GET /v2/conversations` | generic fetch helper, aggregate timeout, no retry | `SAFE_TO_RETRY` |
| Active | `routes/tavus.js` / end route | `POST /v2/conversations/{id}/end` | axios, no timeout/retry | `NOT_SAFE_TO_RETRY` |
| Active | `routes/webhook.js` / terminal tool branch | `POST /v2/conversations/{id}/end` | fetch, no timeout/retry | `NOT_SAFE_TO_RETRY` |
| Manual | `scripts/patchTavusQaP1Persona.js` | `PATCH /v2/personas/{id}` | fetch, no timeout/retry | `NOT_SAFE_TO_RETRY` |
| Inactive | `lib/tavusClient.js` | persona create/patch | axios, no timeout/retry | `NOT_SAFE_TO_RETRY` |
| Inactive legacy | `createTavusInterview.js` and `lib/createTavusInterviewInternal.js` | obsolete `api.tavus.io` create | node-fetch, no timeout/retry | documented exception |
| Inactive | `handlers/recordingReady.js` | arbitrary recording URL GET | fetch, no timeout/retry | separate unauthenticated concern |
| Latent | `routes/webhook.js` / `putJsonToStorage` URL branch | arbitrary URL GET | fetch, no timeout/retry | no active caller passes a URL |

Pre-change active Tavus API operation count: **6**.

## QA/production differential

The accepted QA parent and current production were compared file by file before
reconstruction. Fifteen relevant pre-change files were byte-identical.
Production `routes/webhook.js` intentionally omits QA perception-event ingestion;
only the Finding #7 end-call transport was reconstructed around that difference.
Production does not contain the QA-only `scripts/syncTavusPersona.js`, so the
promotion does not add it. Existing Tavus webhook authentication remains in
place before body parsing and mutation.

## Canonical transport contract

`src/lib/tavusHttpClient.js` owns the Tavus API base URL, `x-api-key` header,
operation classification, finite deadlines, response parsing, retry decisions,
backoff/jitter, capped `Retry-After`, normalized provider errors, and bounded
telemetry/redaction. Callers do not build Tavus authentication or retry loops.

The exact Node-20-compatible transport dependency is `undici@6.28.0`.

| Operation class | Attempt deadline | Connect | Headers/body | Attempts / overall cap |
| --- | ---: | ---: | ---: | --- |
| Standard read | 8 s | 3 s | 5 s / 5 s | 3 total |
| Health read | 2 s | 1 s | 1.5 s / 1.5 s | 2 total, 4.5 s overall |
| Standard mutation | 12 s | 3 s | 8 s / 8 s | 1 |
| Document mutation | 20 s | 4 s | 15 s / 15 s | 1 |

Safe reads retry only transient network failures, timeouts, and HTTP 408, 429,
502, 503, and 504. They never retry HTTP 400, 401, 403, 404, 409, or 500.
Mutations never receive automatic transport replay.

Backoff is exponential from approximately 100 ms with injected bounded jitter
and a 1-second cap. `Retry-After` seconds and HTTP dates are accepted only for
safe reads, capped at 1 second, and rejected if the delay cannot fit within the
operation deadline. Test seams inject transport, timing, and randomness.

## Mutation invariants

Create conversation makes exactly one provider attempt. Once an HTTP attempt
begins, timeout, reset, DNS/connect failure, and provider failure remain an
ambiguous acceptance outcome because Tavus does not document a duplicate-proof
idempotency key. Existing read-only reconciliation remains separate.

Document/persona mutation and end conversation also make one attempt. End-call
application single-flight and lifecycle behavior remain unchanged; the
transport does not issue concurrent or repeated termination attempts.

## Error and telemetry boundary

`TavusProviderError` exposes only bounded caller fields: provider, operation,
category, normalized HTTP status, bounded provider code/message, retryability,
attempt count, timeout/phase, and a safe request identifier when present.

Structured events are limited to started, retry, succeeded, failed, and timeout
with bounded operation/attempt/status/category/delay metadata. API keys,
authentication headers, webhook secrets, raw provider bodies, transcripts,
candidate data, resumes, PII, and signed URLs are excluded.

## Exceptions and circuit breaker

The two obsolete, unreferenced `api.tavus.io` create modules remain documented
inactive exceptions. The inactive recording downloader and latent storage URL
branch remain separate non-authenticated concerns. No active Tavus API runtime
path may bypass the canonical client.

`CIRCUIT_BREAKER_NOT_JUSTIFIED`: finite deadlines and capped safe-read retries
already bound occupancy, while Render multi-instance breaker state and reset
behavior would add complexity and risk false-open denial without evidence of a
production benefit.
