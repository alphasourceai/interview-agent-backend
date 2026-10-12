# Enterprise pool payment proof policy (unmounted)

`enterprisePoolPaymentProof` is a synchronous mathematical check of a trusted
native reservation and fresh authenticated Stripe API2023-10-16 readback. JSON
objects, metadata, session-completed events or this module do not authenticate
a customer, prove recipient delivery, or authorize spending.

The caller must obtain account identity through its configured authenticated
SDK and load immutable pool/client/customer/session/subscription/Price/item
bindings from the reviewed native reservation. It must separately fetch complete
Checkout lines, subscription items, invoice lines and refunds. No embedded
partial lists, client-provided bindings or metadata-only lookup may supply that
authority. The adapter/native reservation are NOT implemented by this module.

The exact accepted positive integer pool net must appear once as a non-prorated
quantity1 one-time native Price and invoice line. Platform nominal is positive;
its actual initial line can be reduced by legitimate proration (even to0).
This proof checks that line's ownership, price and bounded nonnegative amount,
not the correctness of the platform calendar proration formula or membership
activation. All exclusive taxes and all captured cash must reconcile, with no
credits, provider discounts, refund history, disputes or incomplete lists.
Accepted volume/coupon reductions already embedded in the reserved integer net
are distinct from provider-side discounts, which are held. Zero-net/free pools
and zero nominal platform prices require separately reviewed policies.

The receipt returns exact native identity, reserved net, actual platform line,
tax/total and invoice paid_at, with `credits_spendable:false`,
`membership_activation_required:true` and `native_receipt_required:true`.
It contains no term dates, renewal reset, commission or mutation instructions.
There is no historical replay shortcut: future native receipt persistence owns
that identity and late refund/dispute adjustments. Platform and pool can
legitimately share an invoice/charge; the future executor must uniquely own the
pool line rather than independently claiming the entire charge twice.

Current snapshot migration/helper/webhook paid holds are unchanged. No runtime
caller imports this module. Real provider/proration/Checkout shapes, hosted
ownership, native atomic paid/credit release, unknown-response recovery and
specific held-event reconciliation remain unfinished. Synthetic local JSON
tests are not actual Stripe Sandbox or hosted acceptance. No API/SDK upgrade,
tax settings change, key, sender, job, flag, migration or deployment is included.
