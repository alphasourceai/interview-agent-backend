# Atomic Enterprise checkout intent (unmounted)

This is a passive reservation, not a usable checkout or payment proof. Stored and
returned flags are all false: checkout_creation_authorized,
provider_binding_verified, source_artifacts_verified, credits_spendable. No
Stripe SDK, sender, access grant, account creation or old-checkout fallback is
imported. The expected provider account/mode/customer are configured intent,
not authenticated provider objects. Actual source artifacts and provider binding
must be independently verified by the next reviewed creation executor.

The service requires the configured Supabase project and four fresh getUser
checks. A native transaction rechecks confirmed/unbanned/nonanonymous existing
Auth, direct parent billing membership, active parent client, native customer
pointer and current signed Enterprise usage agreement. Native signature metadata
must agree with root execution; this is not a Storage-byte authenticity claim.
Global admin/JWT user_metadata/contact-email possession are not owner bypasses.

One immutable operation and one reciprocal pending pool commit together. Source
commercial/legal/evidence snapshot, exact cents without rounding, accepted
monthly/yearly platform recurrence, next-first-UTC anchor and a one-hour native
window are frozen. Insufficient source/anchor window, free pool or malformed
amount holds. Missing Auth/table read privileges hold; no grant or definer
bypass is added. The existing source freeze and pool paid holds remain.

Operation→pool FK is deferred only for the atomic pair; pool→operation FK and
native reciprocal check forbid orphan/reused/mismatched pools at commit.
Before-row guards derive source/money/time instead of accepting caller-priced
columns. Operation updates/deletes/truncate and pool binding backfill/reassignment
are denied. Owned pools cannot acquire provider IDs through this primitive.
Unowned legacy pools retain earlier behavior.
Owned failed/voided pools are terminal: neither a status reset nor a matching
reservation retry can resurrect them. Same-state bookkeeping remains allowed.

New marked admin pool drafts persist an explicit finite future deadline in both
the native row and the rendered/snapshot values before sending. When absent,
the existing initial seven-day signing window supplies that deadline. The link
cannot outlive it; resend tokens do not extend it. No old accepted draft or
unmarked legacy agreement is backfilled or changed. The column already exists
in 20260919161500_sales_completion_tweaks.sql.

Agreement and owner/environment/key uniqueness prevent a new operation after
retry. Known/unknown reservation replies require a separate scoped READ-only
native ownership check of both rows. No second reservation, provider effect or
fallback occurs on ambiguous/missing/corrupt readback. Source supersession,
customer/member/Auth changes and expiry hold instead of extending/repricing.
Temporal admission uses the native database clock, not the application clock.
The JavaScript adapter validates the frozen window's shape, but does not reject
a committed pair merely because its own wall clock is ahead or behind.

The operation source_digest is an opaque native-only checksum of stored jsonb
bytes. It is not cross-language canonical JSON and must not be recomputed with
JavaScript serialization. Native JSONB equality governs logical source replay;
the nine-field pool digest keeps its prior fixed-order UTF8 canonical scheme.
PostgreSQL's built-in pg_catalog.sha256(bytea) supplies the opaque checksum; it
does not depend on pgcrypto installation or schema. The older pool digest uses
the separately resolved pgcrypto extension, tested in public and extensions.

This slice supports an existing authenticated parent owner and signed, dated
marked Enterprise usage source. It does not solve new-buyer account timing,
admin/public quote admission, custom Enterprise legal publication, provider
Price/session attempt identities, expired-cache recovery, first payment,
renewal/invoice fences, atomic activation or payroll qualification. No route or
worker is mounted, no hosted schema/environment changed, no payment is enabled.
