# Native capability delivery — local, unmounted

No real key/sender/job/provider/route is configured. Old inert source/issuer
paths remain unchanged. New wrappers are available locally but not used by
their factories yet; queued producer wiring is the next step, not a send.

## Persistence and native authority

New source+challenge or document issuance and its encrypted delivery job are
one native transaction. Any header/nonce/key/budget failure rolls back all new
rows. Wrapper acknowledgments and rep-scoped recovery project safe IDs/status/
timestamps only; never an envelope, raw token, key fingerprint or provider ref.
The worker-only read is service-role-only, not a buyer/rep RPC grant.

First envelope attachment requires a newly created source AND challenge (or
document) in the same top-level transaction. Contacts require native time
bounds, challenge issued_at=source.created_at, and exact expiry=min(source time
+10minutes, the owned sales quote expiry). Issued document time is overwritten
by the original native guard. Old committed inert rows cannot be upgraded.
Subject/recipient/source/token/legal/HTML/PDF binding comes from native rows.
Envelope key/env/nonce must match indexed registry identity. No SQL decrypt claim.

Explicit key registry contains SHA256random-key fingerprint, NOT actual key.
One fingerprint across all environments/IDs; fixed native lifetime seal ceiling
and counter, no decrement/reset/alias, retirement irreversible. One nonce/key
slot; counter update and job insert atomic. The actual owned encryption factory
exposes only internal key identity so worker compares the REAL configured key
fingerprint, not an independently supplied label. No real registry rows seeded.

## One attempt, never automatic resend

Every immutable job gets at most one immutable automatic attempt. Eight race
claimers one winner. Even same attempt mutation replay returns no new admission;
unknown ACK is read back once by exact attempt identity. Claim is durable before
provider I/O. Crash or no result remains held_unknown; no expiring lease reclaim.

Attempt guard and last pre-send use the SAME purpose-specific native predicate:
rep -> current head -> signing legal gate -> key -> job, native clock after all
waits. Contact needs active rep/live owned quote/challenge/no proof; signing
needs original rep row/current source/live legal/document/no acceptance, NOT
new active-rep/quote requirements. Proven/accepted job skips obsolete invitation.
Pre-send hold after claim calls no sender and records no invented send result.

Fake/configured sender ACK means accepted_by_provider only, never recipient
delivery. Typed rejection or timeout/throw/malformed ACK audited once as rejected
or held_unknown. Same result replay readonly; contradiction conflicts. A result
may truthfully record ACK after source/key/legal changes; that does not recall an
email or reauthorize a now-inert link. Unknown result ACK gets one primary read,
never another provider call. Job/attempt/result immutable, service-only/RLS.

## Internal worker

Explicit DB, real-envelope/key identity, environment-pinned HTTPS origin,
normalized recipient allowlist and sender callback. No ambient/default SDK.
Preflight rebuilds authoritative binding from separate native source/challenge/
document reads, authenticates envelope, verifies recipient and actual key.
Worker-generated attempt UUID; caller only supplies job ID. Latest source/key
read precedes final native send check, then one callback. Link token is a fragment
on distinct future verification/signing route, never result DTO/querystring/log.
Cross-system change AFTER final check cannot be atomic with provider effect;
native buyer verify/signing gates still apply. No claim of recalled mail.

## Tests and release limits

Actual disposablePG17 parent/new schemas/native RPCs plus a FAKE sender; keys
and recipients synthetic, no actual email/hosted Auth/storage/provider. Includes
atomic failures/backfills/canonical encodings, nonce/key identity and retirement,
8claimers, unknown ACK/readbacks, malformed provider data, pre-send deactivation/
revocation, native waited key locks, safe recovery, zero unpaid access grants.
Migration is unapplied to Supabase. Schema/privilege tests are local catalog
checks, not a claim of hosted advisor execution.

Grok design R1 cancelled/planning, NOT approval. R2DENY findings incorporated/
validated; corrected design and exact source gates pending. Source registration
and issuer queued adapters, actual mail SDK, distributed issuance/admission rates,
frontend fragment/referrer/analytics handling, approved legal/refund descriptor,
hosted private storage and owner canary still required before mount. Buyer/Auth/
client/contract/payment/renewal/commission/FE integration remains separate. No
QA/staging/production deployment or environment change is authorized here.
