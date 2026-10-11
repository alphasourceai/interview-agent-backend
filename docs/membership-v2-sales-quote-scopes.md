# Manual sales quote scopes (local, unmounted)

Use a separate token-verifying Auth client and server-only DB client; never
install a rep's access token into the privileged DB client's headers/session.
The factory accepts injected dependencies only, imports no real client or env
and is not mounted in an HTTP route. Future routes must use the adapter and
retain their rate limits, input limits, privacy and environment release gates.

An authenticated active sales rep can reserve one immutable manual prospective
scope per actor/idempotency key. Tokens are verified through Auth getUser on
each authorization; active sales_reps are re-read. No user_metadata, role flag,
body actor, admin email, client ID or GHL ID establishes ownership. Anonymous,
unconfirmed, deleted and explicitly banned returned identities are denied.
Actual hosted Auth/session behavior still requires separate acceptance; this
does not claim instant revocation atomicity across Auth and database requests.

SQL reservation locks the rep FOR SHARE through creation/replay, preserving
deactivation/deletion ordering within that transaction. It cannot authenticate
a token itself: RPC is callable only by the trusted service backend. The
existing parent SELECT+UPDATE grants support that lock without new parent
privileges. RPC and new table have no browser grants/policies, pinned invoker
search path and immutable update/delete/truncate guards. Existing service-role
privileges on other objects are not reduced or represented as tenant isolation.

The scope contains no PII, verified buyer, client or billing owner. It is not an
agreement or sale. Original salesperson equals verified issuer; read access
constrains both actor and scope. Returning the six fields as authorizeScope for
membershipQuoteDrafts preserves full pre/post-write checks and signing=false.
IDs and key hashes are not access capabilities. Do not log tokens or raw errors.

Idempotency applies to scope creation, not repeated createQuote calls. Key hash
plus issuer is unique; both hashes have distinct fixed v1 domain prefixes;
fingerprint binds manual scope kind, audience and verified issuer. Every retry still checks current access.
Unknown transport outcome reconciles exactly one actor/key read, no second RPC.
Only a 23505 naming the actor/key constraint may also use that recovery read;
every other definite database/PostgREST failure returns a sanitized error, not
guessed success. Post-commit revocation/readback failure can leave an inert row.

Admin, public, GHL and existing-client sources are explicitly unimplemented,
not downgraded into this adapter. No global scope FK is added to the prior quote
table until a compatible source registry for those audiences is reviewed.
Verified-buyer/source and exact legal-body acceptance checks remain mandatory
before signing and contract creation. Quotes remain source-unbound drafts.

Existing sales/Auth identity deletion is intentionally restricted once a scope
references the rep. Deactivation remains supported and immediately blocks
subsequent adapter access. Draft retention/controlled identity cleanup requires
a separately reviewed maintenance path; no cleanup job is installed here.

No package/API version, flag, route, legacy table, client/Auth account, provider
object, mail, invitation, credit, paid access, cron or hosted environment change.
