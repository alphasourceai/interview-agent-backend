# Versioned retail review document — local, unmounted

`createRetailMembershipReviewService` prepares a genuine branded HTML/PDF review
bundle from the reviewed manual sales source and quote services. This is not
legal publication, electronic acceptance or a signing route. No default Auth,
database, browser, email, storage or provider connection exists. Inject
`loadSource(subject, id)` as `membershipSalesProspects.readProspect` and
`loadQuote(subject, id)` as `membershipQuoteDrafts.readQuote`; they must retain
their authoritative active-rep/scope/current-source/DB lifetime and catalog gates.

Input is exactly `{sourceId}`. No body money, buyer identity, quote id, rep, legal
policy, signature, publication switch or timestamp is accepted. Full canonical
source and quote fingerprints, six ownership bindings, schema/template versions,
seven normalized buyer fields and integer-cent offer invariants are checked.
Both complete loader snapshots are cloned and compared again after PDF render.
Late replacement/revocation/staleness/expiry holds the result. Preparation time
is server controlled and is never a paid term date or signing deadline.

## What is printed

Separate static template `retail-membership-review-v1.hbs` and version
`retail-membership-review-2026-10-11-v1`: commercial summary; full payment/term/
renewal obligations; general provisions; final protections and acknowledgment.
All twelve retail plan/term/payment selections and optional first-role credit
are supported. Full monthly commitment is prominent; first-role/role/interview/
tax amounts remain separate. First full initial payment starts the full term,
accepted platform price and commitment renew by default, and turning off renewal
before term end does not cancel current installments or shorten prepaid access.
The 30-day reminder is NOT a non-renewal cutoff. No cancellation fee is added.

Unchanged clauses1,4–14 and the first two General paragraphs are copied verbatim
from the existing agreement into the NEW versioned template. The original
12-month liability lookback is preserved, not changed to3/6. Retail term/billing
clauses are changed to reflect Jason's decisions; General notices are changed
only so the account's non-renewal controls do not conflict with old email-only
notice wording. These are drafted terms, not an enforceability/legal approval.
Legacy/Enterprise renderer/template/routes/signed files are unchanged.

REFUND POLICY AND SIGNING HOLD: every page is REVIEW DRAFT. Manifest publication
is draft_only, policy reference null, acceptance unsigned, signing/send/checkout
false. The document cannot be transformed into a signable agreement by a browser
switch. No policy URL/version or exception is invented. Existing midnight Denver
sales agreement deadline remains unchanged; draft quote/contact-link lifetimes
are not adopted as a production signing deadline. Final policy/legal-body review
and a separately versioned issued document/acceptance transaction remain required.

## Exact bytes and rendering

Fresh document UUID, frozen full source/quote/offer/buyer snapshot, template and
fixed packaged asset hashes, controlled preparation time and render profile are
bound into canonical manifest bytes. SHA256 binds exact HTML and actual PDF bytes,
not a later rerender (PDF metadata may vary). Buffer copies are returned; callers
must recheck integrity before using/storing their copy. Integrity helper is NOT
authenticity/authorization: a self-rehashed copy is not an issued agreement.
No route accepts submitted bundles as authority. Future storage must use private
per-document immutable object names and upsert:false; none is implemented here.

Local logo/embedded Raleway fonts only; no environment logo overrides, remote
font/asset imports, scripts, forms or capability links. Handlebars escapes buyer
text; all buyer fields wrap without truncation. The trusted injected PDF renderer
must honor the frozen render profile. Local verification uses the actual existing
application htmlToPdf with a fresh signed-out dev profile, JavaScript disabled and
non-data requests blocked. It is not evidence of hosted Linux/browser parity.

## Verification and next steps

Unit tests use explicitly fake PDF bytes and synthetic loader-shaped snapshots;
they do NOT prove hosted Auth/DB/PDF acceptance. A separate real PDF matrix uses
the actual application renderer, extraction, word bounds and per-page raster
inspection for all12 selections plus2first-role and2max-length identity variants.
Parent services already have their scoped SQL/Auth-adapter evidence; no new SQL
or hosted data is written by this slice.

Next: approved legal/refund reference, immutable issued-document store and source-
bound signer capability, inert buyer owner/source linkage, exact CAS signature
acceptance and per-attempt immutable signed artifacts. Provider calendar/payment
alignment, paid activation, legacy-renewal exclusion, FE mount and hosted Sandbox
acceptance remain separate launch requirements. Do not deploy a full release
based on this local review renderer's gate.
