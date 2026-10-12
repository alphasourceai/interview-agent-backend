# Pending purchase linkage — inert, local and unmounted

This is a new-buyer bridge to preserve account/password setup after Checkout.
It records the actual signed retail document, accepted original offer, source,
legal descriptor, verified contact proof and original salesperson before a
buyer/account/contract association exists. It does NOT supply Auth ownership,
payment proof, provider admission, a billing customer, contract, role credit,
access, payroll qualification, mail or any route. All old defaults are unchanged.

Native migration `20261012155804_membership_v2_pending_purchases.sql` creates a
service SELECT/INSERT-only immutable ledger with ENABLE+FORCE RLS. FK parentage
includes issued document AND immutable acceptance plus unique attempt/per-sale
scope/source and original rep. There is no Auth or client FK, no compatibility
view into old contracts, and no change to their meaning or constraints.

Lock order is rep SHARE -> accepted head SELECT FOR UPDATE (without a column
write) -> same accepted legal gate SHARE. Context, reserve and direct insert guard
use that order; no head SHARE-to-UPDATE upgrade, provider I/O or GUC bypass.
Native guard rejects all nonNULL caller-supplied derived fields, enforces false
flags, derives snapshots/ids/original attribution/native time and fixed deadline.
Source/acceptance/pixel/quote/contact/legal identities must match exact native
parents. Offboarded reps retain attribution but acquire no new access.

Only immutable descriptors enter native JSONB-text SHA256. Dynamic document/
acceptance/pixel timestamps are UTC6decimal strings; frozen legal snapshot retains
its originally accepted representation. New created_at and context observed_at
are NOT digest inputs. Context can be recomputed without changing the checksum;
created_at is one native guard observation after locks, not an application date.

Fresh insert requires the original legal descriptor still unrevoked and exact
document deadline strictly in the future. A successor legal publication never
substitutes for or retroactively invalidates a signed agreement. Matching replay
after explicit revocation/deadline is historical identity only; its deadline and
flags do not change. Future SDK admission needs a separate fresh legal/time/
actual PNG+PDF/provider/source check; pending existence confers no permission.

Injected application service uses the existing actual signing session to prove
43-character signing capability and private executed PDF, loads actual minimal
document token/fingerprint fields, timing-compares domain hash, validates native
context against that accepted PDF/offer/source, and repeats the session before
reserve. No browser amounts, actor/owner/user/client IDs or timestamps accepted.

Native head lock serializes duplicate requests to the original pending ID/time.
23505 or ambiguous outcome permits only exact document/token/source/environment
readback: no second INSERT/UUID/path, no repair or external effect. Other known
SQLSTATE/PGRST denial fails closed. Missing/mismatched context/result holds.

External response is persistence only: purchase/document/environment/native
created_at/frozen expires_at, recorded_pending_linkage for a new confirmed
reservation or historical_inert otherwise, and all effect/ownership/activation
flags false. Internal awaiting_payment_and_account is not exposed as an admission
state. This ledger cannot make a checkout ready or grant a client dashboard.

Tests distinguish fake-provider units from real isolated PG parent migrations,
native issue/emailproof/PNG acceptance/pending transactions with fake files/PDF.
Expired-history tests use privileged synthetic clock shifting to exercise the
deadline predicate without waiting a day; that is NOT a product backfill path
or valid hosted financial history. Oversize test disables a guard only inside a
rolled-back fixture transaction to independently prove the SQL size CHECK.
No runtime role may disable triggers; tests verify the trigger is restored.

Remaining: actual provider operations/payment fact storage, buyer Auth claim,
genuine contract/client activation, paid access, original-anchor renewal/invoice
fences, payroll qualification, public/sales route and frontend mounts, published
legal copy and dev acceptance. No whole-release approval or deployment implied.
