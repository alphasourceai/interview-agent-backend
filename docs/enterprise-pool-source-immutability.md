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
