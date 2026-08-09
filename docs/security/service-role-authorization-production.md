# Production service-role trust model and authorization inventory

This document is the Finding #2 inventory and acceptance contract for the production
backend. It contains no credentials or customer data. The inventory was taken
from production commit `aa0853d953c2bb1869ca97f5262102488eb394e1` before reconstruction.

## Why the service role exists

The backend uses a server-only Supabase service-role client for provider
callbacks, candidate public flows, scheduled workers, report generation,
private-object signing, and authenticated application routes. Service-role
requests bypass RLS, so RLS is defense in depth for these callers rather than
their authorization decision. Human routes must authenticate the actor and
prove client permission plus canonical database ownership. Trusted system
routes must authenticate their system entry point and prove resource/provider
bindings before mutation.

## Privileged-client construction inventory

The accepted construction point is `src/lib/supabaseClient.js`, which creates a
server-only `supabaseAdmin` client and a separate anonymous verification client.
Before this phase, active duplicate constructors existed in `analyzeResume.js`,
`generateRubric.js`, `handlers/resumeUpload.js`, `routes/files.js`,
`routes/reportsPdf.js`, `routes/webhook.js`, and `utils/jdParser.js`. The
standalone maintenance scripts `scripts/backfillInterviews.js`,
`scripts/normalizeCandidates.js`, and `scripts/verify-routes.js`, plus developer
utilities `test-upload.js` and `testResumeAnalysis.js`, are approved non-runtime
exceptions and are not bundled into the HTTP service.

The initial active inventory contains **43 route/service families**. A family
groups endpoints that share the same entry-point trust contract and downstream
authorization logic; individual endpoint variants remain listed in the route
column.

## Active route and service inventory

Abbreviations: `U` authenticated user, `S` system secret/provider signature,
`T` bounded public token/OTP, `DB` canonical database lookup, `REQ` request
identifier, and `PROV` provider callback identifier.

| # | File / route or service | Operation / resource | Entry identity and scope/binding evidence | Initial classification |
|---:|---|---|---|---|
| 1 | `src/middleware/auth.js` (`requireAuth`, `withClientScope`) | SELECT auth, admins, memberships, clients | U; JWT verified with anon client; Super Admin loaded server-side; direct membership plus active direct-child expansion | SAFE_CENTRALIZED |
| 2 | `app.js` `/auth/*`, `/clients/my`, `/clients/entities` | SELECT/INSERT/UPDATE clients and hierarchy | U; scope context and manager-class hierarchy permission; REQ client asserted against scope/DB | SAFE_BUT_DUPLICATED |
| 3 | `app.js` client billing and role checkout routes | SELECT/INSERT billing, clients, roles, storage | U; legal/billing or manager permission; selected/billing client resolved from DB | SAFE_BUT_DUPLICATED |
| 4 | `app.js` compatibility dashboard routes | SELECT candidates, roles, interviews, reports | U; every base query filtered by effective client IDs | SAFE_BUT_DUPLICATED |
| 5 | `app.js` `/clients/invite`, `/clients/accept-invite` | INSERT/UPDATE memberships/auth | U or bounded invite; manager permission for invite; invite acceptance binds authenticated email/token | SAFE_BUT_DUPLICATED |
| 6 | `app.js` `/admin/*` client management | CRUD clients/settings/hierarchy | U; server-trusted global Super Admin middleware | SAFE_CENTRALIZED |
| 7 | `app.js` `/admin/roles*` | CRUD roles, rubric, storage | U; server-trusted global Super Admin; DB role/client predicates on resource updates | SAFE_BUT_DUPLICATED |
| 8 | `app.js` `/admin/candidates*` | SELECT/DELETE candidates/interviews/reports/storage | U; server-trusted global Super Admin; cascade ownership is DB-derived | SAFE_BUT_DUPLICATED |
| 9 | `app.js` `/admin/reports/generate` | SELECT/INSERT/UPDATE reports | U; server-trusted global Super Admin; candidate/role lookup drives report data | SAFE_BUT_DUPLICATED |
| 10 | `app.js` `/admin/client-members*` | CRUD memberships/auth users | U; server-trusted global Super Admin | SAFE_BUT_DUPLICATED |
| 11 | `routes/adminBilling.js`, `routes/accommodationRequests.js` admin surfaces | CRUD billing, agreements, requests | U; admin middleware uses server-trusted admin table | SAFE_BUT_DUPLICATED |
| 12 | `routes/adminInterviewReliability.js` | SELECT interviews/lifecycle/recovery | U; global Super Admin only; detail uses canonical interview ID | SAFE_CENTRALIZED |
| 13 | `app.js` internal contract, OTP, recording cleanup | DELETE/UPDATE/RPC/storage | S; dedicated cron secret; DB-selected resources | INTERNAL_SYSTEM_ONLY |
| 14 | `routes/roles.js` list/create/status/change request | CRUD roles/audit | U; effective scope and manager-class writes; DB role ownership for ID routes | SAFE_BUT_DUPLICATED |
| 15 | `routes/roles.js` JD signed URL | SELECT role, storage sign/list | U; user-scoped RLS lookup or Super Admin; role client rechecked before signing | HIGH_RISK_DUPLICATED |
| 16 | `routes/roleJdReplacement.js` + `src/lib/roleJdReplacement.js` | SELECT/UPDATE/RPC role, storage | U; manager-class client permission; role ID and client ID jointly resolved in DB | SAFE_BUT_DUPLICATED |
| 17 | `routes/rolesUpload.js` `/upload-jd` | UPDATE role, storage upload, enrichment | U; only client membership was checked; role ID was updated without DB client binding | MISSING_AUTHORIZATION / MISSING_BINDING |
| 18 | `routes/kb.js` `/kb/upload` | UPDATE role, external KB mutation | U; role client is DB-derived and scope checked, but ordinary members could mutate role KB | MISSING_AUTHORIZATION |
| 19 | `routes/clientMembersScoped.js` | CRUD memberships/auth users | U; read scope plus manager/admin/owner write checks and privilege ceilings | SAFE_BUT_DUPLICATED |
| 20 | `routes/dashboard.js` rows/interviews/candidates | SELECT roles/candidates/interviews/reports | U; queries filtered by effective client/entity scope | SAFE_BUT_DUPLICATED |
| 21 | `routes/dashboard.js` recording URL | SELECT interview, AWS signed URL | U; interview client DB-derived then checked against effective scope before signing | HIGH_RISK_DUPLICATED |
| 22 | `routes/files.js` transcript/analysis signed URL | SELECT interview, storage sign | U; interview client DB-derived and checked before using stored path | HIGH_RISK_DUPLICATED |
| 23 | `routes/files.js` resume signed URL | SELECT candidate/accommodation request, storage sign | U; candidate client DB-derived and checked before using stored path | HIGH_RISK_DUPLICATED |
| 24 | `routes/reports.js` historical download | SELECT report/candidate/interview, storage sign | U; report→candidate→client/role and optional interview binding checked before signing | HIGH_RISK_DUPLICATED |
| 25 | `routes/reportsPdf.js` report/interview URL routes | SELECT report/candidate/interview, storage sign | U; client scope checked and most bindings checked locally | HIGH_RISK_DUPLICATED |
| 26 | `routes/reportsPdf.js` legacy generate path | SELECT/UPDATE report, candidate, role, interview; storage | U; report client scoped, but candidate/role/latest-interview binding was not fully proven | MISSING_BINDING |
| 27 | `routes/interviewRecovery.js` | SELECT/RPC interview recovery | U; global Admin-only mount; candidate and requested client are jointly verified before RPC | SAFE_CENTRALIZED |
| 28 | `src/lib/interviewAttemptService.js`, `src/lib/tavusVendorReconciliation.js` | RPC/SELECT/UPDATE recovery state | Trusted admin/system caller; RPCs enforce candidate/interview/replacement/provider binding | INTERNAL_SYSTEM_ONLY |
| 29 | `routes/candidateSubmit.js` | INSERT/UPDATE candidate/report/OTP/storage | T; public role token/ID resolves canonical active role/client; idempotency and duplicate rules bind candidate | SAFE_BUT_DUPLICATED |
| 30 | `routes/verifyOtp.js` | SELECT/UPDATE OTP/candidate | T; OTP subject/email/candidate/role binding and rate limit | SAFE_BUT_DUPLICATED |
| 31 | `routes/createTavusInterview.js` + internal creator | SELECT/INSERT/UPDATE interview/provider binding | T; verified candidate/OTP and role/client capacity; DB attempt claim owns provider binding | HIGH_RISK_DUPLICATED |
| 32 | `routes/textInterview.js` | INSERT/UPDATE candidate/interview/report/storage | T; signed/text session and role/candidate/interview binding | HIGH_RISK_DUPLICATED |
| 33 | `routes/accommodationRequests.js` public request flow | INSERT/UPDATE request/candidate/report/storage | T/public intake; active role DB lookup establishes client; candidate/request linkage preserved | SAFE_BUT_DUPLICATED |
| 34 | `analyzeResume.js`, `handlers/resumeUpload.js`, `src/lib/resumeUpload.js` | SELECT role, UPDATE candidate/report, storage | Called only after parent route establishes role/candidate context; candidate ID remains a high-risk downstream binding input | INTERNAL_SYSTEM_ONLY |
| 35 | `generateRubric.js`, `src/lib/rolePurchaseFinalizer.js` | SELECT/UPDATE role, storage/provider docs | Admin/manager or verified purchase finalizer; role loaded canonically before artifacts attach | INTERNAL_SYSTEM_ONLY |
| 36 | `routes/automation.js` + automation services | CRUD rules/actions/tokens, email | U with manager-class configuration checks, or S runner/token-bound public approval; rule/action DB binding | SAFE_CENTRALIZED |
| 37 | `routes/feedback.js`, `routes/publicAnalytics.js`, `routes/publicLeads.js` | INSERT bounded public telemetry/feedback | Public rate limits, validated payloads, generated/owned IDs; no tenant resource read | INTERNAL_SYSTEM_ONLY |
| 38 | `routes/alphaScreenPackages.js`, purchase activation services | CRUD purchase intents/agreements/clients/memberships | T; intent verification and agreement/Stripe binding; no arbitrary authenticated client pivot | INTERNAL_SYSTEM_ONLY |
| 39 | `routes/membershipAgreementsPublic.js` | SELECT/UPDATE agreements, storage signing | T for public signing; U plus legal/billing permission for client reads; agreement/client DB binding | SAFE_BUT_DUPLICATED |
| 40 | `routes/webhookStripe.js`, `routes/webhookSendgrid.js` | INSERT/UPDATE billing/email state | S; provider signature/event identity; canonical purchase/client/event binding | PROVIDER_CALLBACK_ONLY |
| 41 | `routes/webhook.js` Tavus webhook | SELECT/UPDATE interview/candidate/report/lifecycle, storage/provider read | S; webhook auth → payload validation → canonical conversation ID → DB interview binding | PROVIDER_CALLBACK_ONLY |
| 42 | `routes/tavus.js` end conversation and reliability telemetry | SELECT/UPDATE interview/lifecycle/provider | T or signed telemetry authorization; canonical interview/conversation comparison and single-flight termination | HIGH_RISK_DUPLICATED |
| 43 | `handlers/recordingReady.js`, `handlers/tavusWebhook.js` legacy helpers | SELECT/UPDATE callback resources/storage | Not mounted as alternate HTTP routes; invoked/retained only as callback helper or dormant compatibility code | PROVIDER_CALLBACK_ONLY |

`routes/candidates.js` is not mounted by `app.js`. Its unscoped
`/by-role/:roleId` handler is a dormant unsafe implementation and is included in
the static guard/removal decision, not counted as an active exploitable route.

Production also retains an unmounted ESM compatibility module at
`routes/adminRoutes.js`. It is not imported or mounted by `app.js`, so its raw
service-role constructor is classified as a documented dormant exception rather
than an active caller. The static guard fails if that module becomes mounted;
active HTTP/runtime code has no raw service-role constructor outside
`src/lib/supabaseClient.js`.

## Accepted authorization matrix

| Actor | Own/direct client | Active direct child | Sibling/unrelated | Writes |
|---|---|---|---|---|
| Unauthenticated | No privileged application access | No | No | Only purpose-built bounded public/provider flows |
| Authenticated without membership | No | No | No | No |
| Member | Read own-client application resources | No inherited child scope | No | No manager-class role/member/entity mutations |
| Manager / client Admin / Owner | CRUD in direct client | CRUD in active direct child where current scope contract expands | No | Current manager-class operations only |
| Global Super Admin | Current global administrative behavior | Current behavior | Current behavior | Explicit global-admin routes and helper bypass only |
| System worker / provider callback | No human scope is implied | N/A | N/A | Only authenticated system purpose plus canonical resource/provider binding |

Child-only membership never reaches the parent or a sibling. Archived children
remain excluded. Request `client_id` values are assertions only; canonical
database ownership controls resource authorization.

## Canonical resource-binding contract

- Role: role row → `client_id` → actor effective scope; manager permission for mutations.
- Candidate: candidate row → `client_id` and `role_id` → authorized role/client.
- Interview: interview row → candidate/client/role/attempt; all supplied related IDs must match.
- Report: report row → candidate/client/role and optional interview/attempt; every populated binding must agree.
- Provider conversation: canonical Tavus conversation ID → exactly one application interview binding before mutation.
- Storage: the request supplies a resource ID, never authority to an object path; the path is taken from the authorized resource row and validated before signing/downloading.

Authorization failures use bounded existing 403/404/409 responses and must not
include foreign names, emails, storage paths, transcripts, resumes, JWTs,
provider credentials, or the service-role key.

## Approved non-human exceptions

- Authenticated Tavus, Stripe, and SendGrid callbacks.
- Dedicated-secret contract, OTP, automation, and recording cleanup workers.
- Candidate OTP/session, agreement-token, purchase-verification, and automation-approval flows.
- Candidate-submission analysis and role/purchase artifact workers after their parent entry point establishes the canonical resource.
- Maintenance scripts that are not imported by `app.js`; operators remain responsible for their explicit environment and target selection.
