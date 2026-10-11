# Manual sales buyer/quote sources — local, unmounted

`membershipSalesProspects` builds a concrete immutable buyer revision from an
owned manual sales quote. It is NOT an agreement, buyer Auth identity or paid
contract. Existing purchase intents, activation protocol, accepted documents,
cadence fields, parent constraints/grants, legacy routes and renewals are untouched.

## State and trust

Inject the already-reviewed `membershipSalesQuoteScopes.authorizeScope`, server
database and a trusted `handoffVerification` callback. No real defaults exist.
Manual sales only: public/admin/GHL/existing-client sources are held. Original
rep is the freshly authenticated active rep, never a browser identity claim.
Selected quote is read through the reviewed quote service (full canonical offer,
digest, six scope fields, draft template, expiry/current catalog); no browser
money or commercial terms. All twelve sales combinations are representable
without a fake monthly/annual legacy cadence.

`createProspect(subject, {quoteId, expectedSourceId, buyer})` strictly normalizes
seven buyer fields, with explicit null optional fields. Frozen canonical bytes
bind source/quote/digest/rep/previous revision/full buyer. Any buyer or selection
change requires a fresh quote and compare-and-swap replacement. Reusing a quote
fails, and the head guard cannot re-enable an older source.

The registration RPC locks active rep then NEW scope head, atomically writes
source/challenge/head, and permits only an exact same-attempt replay while
current. It does not lock/update the immutable parent scope or grant parent
privileges. Returned/thrown unknown transport outcomes get same-ID current scoped
readback, no second RPC and NO verification handoff. Definite database failures
do not fall back. All readbacks and postcommit Auth checks must pass before handoff.

Only the explicit trusted SERVER callback receives a crypto-generated 256-bit
base64url token, buyer and expiry. A domain-separated hash including source ID
is stored; the raw token is never returned in the caller result or persisted.
`verification_handoff: attempted` means callback completed, NOT delivered.
Callback errors are sanitized and leave an inert pending source. No mail was
sent during implementation/tests. A fresh quote and CAS replacement can supersede
an unrecoverable delivery attempt; production delivery retries/outbox/rate limits
are not implemented here.

`verifyEmail({sourceId, token})` consumes only the exact unexpired bound challenge,
requires active original rep/current head/current offer version/unexpired quote,
and records an append-only proof with database time. Replays while link-valid
return the same proof, not new effects. Wrong/unknown/expired/superseded links
all receive `sales_email_denied`. It never issues a session, signing or access
capability. Recorded proof can be read after ten-minute link expiry but only
while the quote remains current and unexpired; replacement invalidates it.
Both result flags `signing_enabled` and `checkout_enabled` are always false.

`readCurrentProspect(subject)` is authenticated actor/scope recovery. It returns
the immutable current source even when its quote expired or catalog changed,
without a token, proof assertion, resend or eligibility grant. This permits CAS
replacement after a committed create whose final readback failed or whose rep
was temporarily revoked. An empty owned scope returns null. Current-head/expiry
facts and proof timestamps are checked by a service-only read RPC under rep/head
locks using FULL native database clock precision, never the Node clock. This
corrects Grok's initial design findings; parent Auth/scope timing policy itself
is unchanged and still requires hosted version/clock acceptance before mounting.

## Database and limits

Sources/challenges/proofs are immutable including TRUNCATE; head deletion and
TRUNCATE forbidden and transitions follow the same-scope predecessor chain.
RLS, no browser policies, Public/browser revokes, service SELECT+INSERT and head
UPDATE only. RPCs are SECURITY INVOKER with pinned pg_catalog search path and
service-only execution. Restrictive FKs preserve source and original-rep identity.
The trusted service backend can insert valid records directly; it is not modeled
as an untrusted tenant principal. External Auth/catalog/readback/handoff checks
are not one cross-system transaction: a later change can render a handed-off
link inert, and proof is never permission to sign. Hosted Auth/PostgREST/RLS
acceptance is still required before mount. No Supabase advisor run is claimed
(installed CLI 2.67.1 lacks that command); isolated PostgreSQL catalog/grant and
populated RLS tests are the local evidence.

Next: reviewed contact delivery + subject/IP limits; public/admin/GHL source
adapters; approved legal renderer/PDF, exact-source acceptance transaction and
inert billing-owner identity. Only then mount sources/signing. Checkout must
remain held until native provider binding/payment/calendar alignment, scoped
activation/qualification and legacy-renewal exclusion are reviewed and proven.
