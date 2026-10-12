# Enterprise pool source immutability (prospective, local only)

The v2 pool snapshot is an amount, not billing-owner authorization or a signed
contract. Existing paid/activation holds remain. No checkout worker, provider
request, real signature, browser route or migration deployment is added here.

The additive migration freezes all of a marked draft's template snapshot except
root `execution`, plus its native commercial, buyer, legal/template, original
creator and expiry fields. Changing platform fees, usage fees, interview
capacity/duration/questions or legal text now requires a new draft. Existing
snapshot validation continues to prevent stripping or backfilling the marker.
Deletion of marked agreements is denied. Both-null legacy rows are unaffected.

The existing signing RPC can append its execution object, sign the source and
supersede an older agreement. Once signed, native signing evidence and root
execution cannot change; current/supersession/void and checkout bookkeeping can.
Reverting a signed source to a draft/sent row is denied. This preserves stored
evidence; it does not authenticate the signer, verify PDF bytes in Storage or
prove that a service-role caller used the signing route. Those admission checks
are mandatory in the later durable checkout executor.

The pool insert predicate uses `IS DISTINCT FROM 'pending'` so its own NULL
behavior is safe even without the existing column's NOT NULL constraint. This
does not remove the native paid-proof hold or create spendable credits.

Before durable checkout effects, a trusted server must freshly authenticate the
billing owner and configured Stripe account/mode, load the exact native current
signed source and its real execution artifacts, create one atomic operation and
pending pool, and use frozen request identities for all provider steps. An
unknown provider acknowledgment cannot authorize a second checkout. Custom
Enterprise terms/legal versioning, admin-quote admission, stable provider steps,
payment receipts and real activation remain unfinished and separately reviewed.

## Existing native writer audit

All server mutations use the service database client; native tests explicitly
`SET ROLE service_role`, including actual signing and supersession. Inspected
post-insert writers at this candidate:

- `routes/admin/billingRouter`: send sets status/sent_at; void sets void/current
  metadata and restores a superseded source's current/status metadata.
- `routes/sales/index`: send sets status/sent_at; resend/payment reminder rotate
  signer capabilities and operational clocks. Expired terms create a replacement
  row, not in-place expiry or commercial edits. Failure cleanup deletes drafts:
  marked deletion is now denied, preserving source/audit for reviewed voiding.
- `services/alphaScreen/index` and `adminPublicPurchasesService`: rotate signer
  capabilities and updated_at only, not the stored commercial/expiry fields.
- `routes/public/membershipAgreements/signing`: opened clocks; existing native
  signing RPC writes evidence/root execution and supersedes prior current row.
- Native `replace_sales_assisted_agreement` and
  `cancel_sales_assisted_purchase` update status/current/supersession/
  operational clocks only; replacement inserts a different source. Native
  `complete_public_purchase_activation` also performs the legacy client/date
  rewrite described below, and MUST NOT activate a marked source using that
  legacy path. Its previous activation fences and pool paid holds are unchanged.
- `routes/public/membershipAgreements/checkout`: checkout/session/created clocks
  and replacement operational metadata. No non-execution snapshot rewrite.
- `routes/public/checkoutSuccess`: checkout-paid clocks and replacement/error
  operational metadata. These are bookkeeping, not proof of activation.
- `services/membershipAgreements/index` and `publicPurchaseActivation`: legacy
  unlinked buyer-account paths write client_id; the earlier v2 snapshot guard
  already denies that marker's client reassignment. Legacy activation can also
  rewrite initial dates on successful-payment terms; this new freeze denies
  that rewrite for a marked source. New pool paid/activation holds stay intact;
  the later v2 executor MUST NOT run that legacy date-rewrite path. Actual
  identity linking and original-anchor funded dates belong in separate native
  operational records, not accepted document edits. Legacy rows still work.

Native tests include NULL↔value freezes, combined execution+price edits before
and after signing, marked pending/all-nonpending/NULL inserts, actual invoker
signing, rollback, supersession/restore, and catalog BEFORE/nondeferrable flags.
Table owner/TRUNCATE/replica-trigger bypass remain outside this mutation guard;
no protection against a malicious privileged database administrator is claimed.
