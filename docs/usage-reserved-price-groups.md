# Reserved usage price groups and retry safeguards

Invoice reconstruction groups ledger rows by role AND their reserved integer
unit price, not role alone or today's plan settings. Valid uniform-price groups
retain the exact prior operation hash and payload. Legitimate zero-price legacy
rows remain valid. Malformed/duplicate/overflowing rows hold for review rather
than silently becoming free. A partially stamped group also holds instead of
turning its remaining rows into another provider item.

Every write-capable invocation checks a complete invoice ledger census with
an exact native row count, including siblings and already stamped groups. A
fresh reserve re-reads that census but retains only its owned pending rows as
the charge batch. A partial owned group holds; it is not widened to siblings or
assigned an invented provider batch. Complete provider item history is checked
before any create or stamp. Allowed operation keys cover complete groups,
including already stamped ones. An old combined item,
unknown/missing key, duplicate, changed owner/amount/quantity or incomplete
pagination holds before further writes. The code does not guess which new
groups an old role-only item paid for. There is no automatic deletion, refund
or rewrite of historical invoices; ambiguous old items need manual review.

Mixed-price items also require exact fresh provider readback before stamping;
a create response containing an ID alone is not reserved amount/ownership proof.
Known groups recover after response loss, stamp failures and retry-key expiry.
Fresh reservation still charges only the rows that invocation actually reserved,
not another concurrent worker's rows. Native unique interview reservation and
invoice/interview/null stamp predicates are unchanged. Fully billed historical
invoices keep their existing no-op; normal uniform keys/payloads and existing
provider reconciliation remain, with an additional conservative whole-invoice
history gate. Unknown wider items cannot bypass it through a uniform subset.
No pool paid holds or retail behavior changed.

This fix does not implement native immutable contract/unit-price/entity/month
ownership before reservation, a durable whole-invoice batch, account proof,
immediate-invoice unknown-response recovery or a scheduler. Current role labels
remain current role metadata; they are not represented as frozen labels.
Cross-system races cannot be called an atomic financial transaction. Those
prospective ledger/adapter pieces remain required for the unified release.

Local in-memory provider tests are not actual Stripe acceptance or payment
collection. No hosted SQL/schema/grant/Auth/SDK/API/tax/config/credentials,
provider job, push or deployment is part of this source-only candidate.
