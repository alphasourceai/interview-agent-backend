# Prospective Enterprise pool snapshot transport

Local unified-release candidate only. No hosted SQL, provider or delivery action.

New admin drafts and direct admin checkout derive pool terms from the reviewed
fixed0/5/7/10 volume bands with integer half-up rounding on the automatic discount.
Browser-supplied discounts, coupons, versions, snapshots and digests are not
authority. Draft coupon defaults to0; no new coupon UI or policy is enabled.

One closed nine-field snapshot is carried through normalized agreement input,
the commercial PDF table, signed-template checkout and the native pending pool.
Checkout charges snapshot.net_cents as a single quantity1 line; it does not
recompute an accepted offer from today's bands or approximate per-unit display.
The new pool session omits both unrestricted promotion entry and additional
promotion discounts. Legacy sessions retain their existing promotion behavior.

Canonical hash bytes are UTF8 JSON with no whitespace and these exact field
positions: offer_version,currency,quantity,unit_price_cents,gross_cents,
automatic_discount_percent,automatic_discount_cents,coupon_cents,net_cents.
Numbers are nonnegative decimal integers; SHA256 is lowercase hexadecimal.
Native JSONB rebuild uses the same order, never jsonb::text. Terms are bounded
by existing signed32-bit financial columns before any provider dependency.
V2 unit price is at least1cent; legacy zero-price rows are unchanged.

Both-null/absent protocol fields identify legacy input. A split, malformed or
unknown nonnull pair holds; it cannot downgrade to old rounding. Native new
agreement/pool fields are immutable after insertion and cannot be stripped or
backfilled onto old rows. Legacy accepted rows, grants, RLS, calculations and
operational settlement transitions remain unchanged. Migration is additive and
must precede code deployment, which is not authorized in this work.

## Deliberate settlement hold

This phase is NOT an activation implementation. The old pool paid helper and
webhook explicitly select both new marker columns and accept only actual nulls
for legacy settlement. Missing fields fail closed. The legacy paid UPDATE also
compares both columns to null. The native guard refuses new-protocol paid/
refunded states and paid_at; failed/voided remain unspendable. Webhook hold occurs
before client/activation writes and is recorded as a permanent held event, not
success. A later independently reviewed native paid-proof/binding adapter must
replace this hold before any v2 pool rollout, including replay/reconciliation
of held events. Existing legacy pool settlement is unchanged.

## Limitations retained, not acceptance claims

No real Checkout, charge, email, user, credential, flag or hosted change. Fake
SDKs and synthetic local PostgreSQL do not establish hosted/Sandbox acceptance.
Current legacy Checkout customer/Price orphan and unknown-response/session
idempotency limitations remain. The full provider account/line/invoice/payment
proof and credit activation are next; no pool becomes spendable in this phase.
The existing agreement's12month/30day legal copy is intentionally NOT changed by
this pool-only slice; unified customizable Enterprise/renewal copy and actual
monthly usage scheduling remain separately required before the full release.
