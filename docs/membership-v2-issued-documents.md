# Retail issued-document ledger — local and unmounted

The ledger freezes exact source, quote, legal descriptor, UTF-8 HTML and private
preview-PDF identity. It separately records one immutable acceptance per
document/source/scope. It creates no client, Auth user, contract, paid access,
commission qualification, welcome, provider binding or checkout.

No legal version is seeded by the migration. Final retail template/refund-policy
publication has not been approved. The review renderer is not an issuer and
cannot be converted by flags or rehashing. The new service requires an explicitly
pinned server legal version and injected trusted legal loader, renderer, fresh
rep authorization, source/quote loaders and private artifact driver. None has a
default provider. No routes or hosted storage buckets are created.

## Issuer / exact bytes

`issue(subject, {sourceId})` is the only adapter method. It checks active owning
rep and verified current source/unexpired quote before and after rendering and
upload. Only the source identity is accepted from the caller: never buyer,
money, legal choice, timestamps, document ID, paths or tokens. The trusted
renderer must return `retail_issued_artifact_v2` with exact source/quote/legal
bindings. Draft/review markers are rejected in both adapter and SQL. The
application's final published renderer is still to be implemented/reviewed;
these checks do not prove semantic legal-body equivalence by themselves.

Server Node `crypto.randomUUID()` chooses the document identity BEFORE staging
so `retail-v2/{documentId}/preview.pdf` is stable. The private driver receives
copied bytes and `upsert:false`; actual private download must equal retained
bytes before SQL reservation. HTML maximum2MiB, PDF maximum8MiB. SQL stores
metadata, not PDF bytes; it does not independently prove the object exists.

SQL derives full source/quote/legal snapshots and HTML hash, never trusts caller
snapshot or clock claims. There is one document per source. Refresh requires a
new quote and CAS source revision, then a new document/capability. Prior previews
remain immutable. Failed uploads/late checks may leave orphan private files:
no unsafe cleanup or overwrite is attempted here.

256-bit signing token hash preimage is UTF-8 `retail-signing-v2`, LF,
document UUID, LF, source fingerprint, LF, base64url token. Lowercase SHA256 only
is stored. Raw token remains ephemeral and is never returned/logged/persisted.
Delivery is NOT implemented: result is `delivery:not_configured`, with signing
and checkout disabled. Unknown commit gets exactly one scoped same-ID readback,
no second reservation, upload or send. Future durable encrypted delivery/outbox
and safe recovery are required before real issuance can be mounted.

## Acceptance / time / concurrency

SQL accepts only a trusted staged-artifact descriptor, NOT raw browser body.
Current adapter exposes NO signing method. Future parser/executed renderer must
stage actual signature/executed-PDF bytes at server-attempt-specific immutable
paths, read them back, and bind exact hashes before calling acceptance:
`retail-v2/{documentId}/attempts/{attemptId}/signature.png` and `executed.pdf`.
This migration does not validate/decode images or build executed PDFs.

Consent must be JSON boolean true. `typed_name` is a bounded signer ATTESTATION,
not buyer Auth identity or a replacement for frozen contact first/last names.
No new legal-name matching rule is inferred. The future buyer linkage must
independently enforce authorized identity without claiming existing accounts.

Issuance locks active rep -> current scope head -> legal gate. Acceptance locks
original rep by primary key (not active status) -> same current head -> legal
gate. Rep offboarding does not retroactively close an issued buyer window.
Contact-proof source/fingerprint checked at issuance; immutable source/proof
identity persists. Quote/contact-link expiry do not shorten an issued window.
No current catalog repricing at signing. Original rep attribution never resets.

All authoritative timestamps use `clock_timestamp()` AFTER locks. Deadline is
the existing following midnight in America/Denver, including DST. No paid
term-start/renewal date is fabricated: payment success remains the term basis.

Concurrent signatures choose exactly one acceptance. Exact same attempt/evidence
replay returns unchanged history, even after deadline; it is not new signing
authority. Different/changed attempts conflict, not a success with winner's
bytes. Source-head replacement checks accepted scope, so an accepted source
cannot be superseded; losing source registration rolls back source/challenge.

Legal descriptors/revocation history are append-only. One mutable legal gate is
the documented exception: false->true once with existing revocation history,
never reopening/key change/delete/truncate. Issuance/acceptance lock its latest
row, so concurrent committed revocation cannot hide behind an old statement
snapshot. Existing accepted rows are retained. Publication approvals are trusted
administrative inputs; this code does not approve legal text or policy.

## Security / verification limits

RLS on all new exposed tables, PUBLIC/anon/authenticated grants and EXECUTE
revoked; service SELECT+INSERT only except guarded legal-gate UPDATE. All
functions SECURITY INVOKER with pinned pg_catalog search path. Owner mutation/
TRUNCATE guards and restrictive FKs retained. Parent grants/constraints/legacy
rows unchanged except additive accepted-source-head trigger.

Actual disposable PG tests use the real prior migrations/RPCs and non-owner
service role, synthetic publication/HTML/PDF metadata, forced lock overlaps and
populated RLS. Adapter unit tests and actual SQL adapter roundtrip use fake
Auth/render/storage callbacks. No hosted Supabase/Auth/PostgREST/storage, legal
publication or real signature acceptance claimed. Installed CLI2.67.1 lacks
advisors; actual grant/function/catalog tests are not a hosted advisor report.

Next: published legal body/policy, durable delivery, strict signature parser,
exact issued-HTML execution attestation, real private storage/readbacks, inert
buyer/contract linkage, source-bound public session and rate limits, then
checkout/native payment/calendar/activation/renewal gates. Existing legacy and
Enterprise signing paths remain unchanged.
