# Queued capability producers — local integration only

The manual-sales prospect creator and retail issued-document creator accept an
optional trusted server dependency `delivery: { environment, envelope }`.
`envelope` is an explicitly constructed capability-envelope factory; it is not
a browser value or environment fallback. Undefined preserves the prior inert
behavior. Null, incomplete or invalid configuration fails closed.

In queued mode, one native RPC atomically creates the source/challenge or issued
document, its immutable encrypted delivery job, and the key's budget increment.
Key identity is checked against the actual owned key bytes, not an independently
configured fingerprint label. Native latest-row gates remain authoritative if
the key, legal publication, rep or source changes during application preflight.

The creator reads its exact owned parent and encrypted job before returning a
safe reservation ID. An unknown mutation response gets persistence readback,
not a second mutation, reseal, mail callback or retry. A missing/unreadable or
conflicting record holds the response. The old raw-token handoff callback is
never invoked in queued mode.

`delivery: reserved` proves immutable persistence only. It does not prove a
currently eligible invitation, provider acceptance, recipient delivery, buyer
Auth identity, signature, checkout or activation. A key retired after commit
does not erase the saved reservation; the independent worker still blocks it.
Both creators keep `signing_enabled` and `checkout_enabled` false. Caller DTOs
contain no raw capability, sealed envelope, key identity or provider reference.

No HTTP route, default sender, key registration, actual legal publication or
worker schedule is mounted by this integration. Private PDF storage remains an
explicit injected dependency. A failed issue may retain the existing immutable
preview orphan; it is never overwritten or automatically deleted.

Contact email verification is not account ownership. An authenticated buyer
link, executed-document-to-contract bridge, real provider lifecycle, approved
refund policy and hosted owner-only acceptance remain separate release gates.

Local verification uses actual disposable PostgreSQL/native parent migrations,
random ephemeral keys, fictional `.invalid` buyers, a synthetic authorization
callback, in-memory PDF-like bytes and a fake sender. It is not hosted
Supabase Auth/Storage, a rendered legal PDF, or real email acceptance/delivery.
