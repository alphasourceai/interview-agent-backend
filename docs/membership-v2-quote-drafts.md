# Prospective retail quote drafts

This local foundation is not mounted in any route. It does not create a client,
Auth user, signature, purchase intent, paid contract, subscription, notification,
or job. Existing monthly/annual flows are unchanged.

## Trusted adapter contract

`createMembershipQuoteDraftService` requires an injected database client and
`authorizeScope(subject)`. There is deliberately no default authorization
adapter. Before mounting a route, that adapter must prove the actual current
authenticated role or anonymous prospect capability, a stable prospective scope
association, active salesperson (when one is attributed), and any client/billing
owner association. Never use browser money, owner IDs, channel, or user-editable
Auth metadata as authority. The opaque scope and quote IDs are not bearer tokens.

Authorization returns all six explicit fields: `scope_id`, `audience`,
`issuer_user_id`, `original_salesperson_user_id`, `client_id`,
`billing_owner_user_id`. IDs are canonical non-nil UUID strings or explicit nulls.
Public has no issuer, rep, client or owner; it gets prepaid offers only. Sales
requires issuer==original rep. Admin requires an issuer and may attribute an
independently authorized rep; null rep explicitly means a non-commission quote.
Optional existing client and owner are paired. Shape checks do not prove these
associations: the future authorization adapter must do that.

Only plan, months, payment option, current offer version and first-role boolean
are caller selections. The default catalog is the reviewed server catalog;
catalog/descriptor injection is for trusted server version resolution and tests,
not a browser extension point. Complete catalog and template resolution is
checked again immediately before insertion. Prices are frozen, not recomputed
when reading a quote. A read flags an expired/stale draft and always disables
signing; it is not proof of legal acceptance or paid access.

## Persistence and recovery

The complete column-derived document includes unsigned/source-unbound markers,
scope/attribution, offer/capacity/fees/renewal, template version and UTC issue/
expiry instants. SQL independently requires the exact sorted compact canonical
bytes and built-in SHA256, not merely parsed JSON equality. It rejects divergent
input rather than silently overwriting it. All checks execute in the INSERT
transaction. The returned service result additionally requires scoped readback
and exact attempted identity/digest.

The existing backend service role is a trusted, non-owner, non-superuser role.
It receives only INSERT/SELECT on this ledger; RLS and revoked browser grants
protect clients. Immutability and truncate triggers also reject accidental table
owner mutations. No new role, secret, extension or existing table grant is
created. The broader backend service role still has its pre-existing privileges;
this module does not narrow the entire application role or authenticate that
role by itself. Isolating a deployment connection is a separate reviewed task.

One call generates one UUID and performs one INSERT. Definite SQL/PostgREST errors
fail, without reconciliation. An unknown transport acknowledgment permits one
scoped SELECT of that same ID, never another INSERT. Missing/conflicting data
fails. Reauthorization surrounds persistence and reads. Post-commit readback can
fail and leave an inert draft behind; no external effect or success is reported.
Cross-request durable idempotency and an expiry cleanup policy are not built yet.

## Launch prerequisites

Before any real quote/signing route: implement/review actual role/prospect scope
authorization and durable request identity; create inert buyer/client identities
without paid access or delivery; persist prospective source protocol fields;
approve/publish agreement and refund-policy copy; bind actual signed source and
acceptance digest atomically to the contract store. Then complete the provider
alignment, first-paid activation, qualification and renewal paths, and exclude
v2 clients from the legacy twelve-month renewal scanner. Whole-release Grok/
Codex approval and hosted Sandbox acceptance remain mandatory.
