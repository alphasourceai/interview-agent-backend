# Billing models

There are three ways a client can be billed for interviews. Every client is on
exactly one of them, recorded as `billing_model` on their plan settings.

| Model | Who | What happens to unused interviews |
| --- | --- | --- |
| `fixed` | Essentials | Lost when the role closes |
| `rollover` | Pro | Become client credit, usable for 90 days |
| `usage` | Enterprise | Interviews past the included count are invoiced |

A client's model normally comes from their plan tier, and moves with it: a
client who goes from Pro to Enterprise is billed on `usage` from then on, with
nothing to update. A client can instead be given a model of their own, which
then stays put whatever happens to their subscription.

**An empty `billing_model` means "follow the plan tier".** The column has no
default and may be left empty. When it is empty, the client is billed as their
tier implies: Essentials → `fixed`, Pro → `rollover`, Enterprise → `usage`. When
it holds a value, that value is a deliberate choice for that client and wins
over the tier. Every part of the backend that decides money reads the model the
same way, through one function, so an empty value can never be read as
"fixed" by accident.

This matters because not everything that writes plan settings fills the column
in. The public purchase activation (the database function
`apply_public_purchase_billing`) creates a client's plan settings without it. If
the column had a default of `fixed`, every Pro client activated that way would
silently lose rollover credit.

---

## What counts as a billable interview

The same definition applies everywhere — capacity limits, credits and Enterprise
invoices all use it, so the three can never disagree.

An interview counts once **any** of these is true:

- its status is `completed` or `analyzed`
- it has an interview summary
- it has a numeric overall transcript score

With one exception that overrides all of the above: an interview where the
candidate never gave a substantive response **does not count**. If a candidate
joins and says nothing usable, the client is not charged for it and it does not
consume their allowance.

An interview can also become billable late — a transcript sometimes arrives after
the interview has ended. That is handled: the interview is charged at most once
no matter how many times its record is updated.

---

## Essentials — the fixed model

Each role gets an allowance of 20 interviews. Additional interviews can be bought
for that role at $25 each, and count toward the same role.

When the role is closed, any unused part of the allowance is gone. Reopening the
role does not bring it back — the allowance is per role, and closing it ends it.

---

## Pro — the rollover model

Each role gets an allowance of 30 interviews, and additional interviews can be
bought at $30 each.

**When a role is closed**, whatever is left of that role's allowance becomes
client credit. Credit is not tied to the role it came from: it can be spent on
any role the client has open. It expires 90 days after the role closed. The
window is configurable per client.

**Closing the same role twice** does not hand out a second credit.

**When a role is reopened**, its own allowance comes back and the credit from
closing it is cancelled — but interviews already spent from that credit are not
taken back from the roles that used them. Instead, the reopened role's allowance
is reduced by the number already spent. If a role closed with 10 left, 3 of those
were spent on other roles, and the role is then reopened, it comes back with 7.

**Which allowance is spent first.** A role always uses what it has of its own —
its included allowance plus anything bought specifically for it — before touching
any credit. Once its own allowance is gone, the next interview draws from the
credit that expires soonest, so nothing lapses unused.

**Capacity warnings.** A role is only reported as full when the client has no
credit left either, so a client holding credit is never told to buy more.

---

## Enterprise — the usage model

Enterprise pricing is set per client: the platform fee, the per-role fee, the
number of interviews included per role, and a per-interview price for anything
beyond it. Any of these may be zero — an Enterprise client can have no included
interviews at all and simply pay per interview.

**What gets billed.** For each role, the included count is free. Every used
interview beyond it is charged at the client's per-interview price. The included
count is per role, not per client.

**Which allowance is spent first.** The role's own included count, then the
client's interview pool, then the meter. An Enterprise client with 25 included
per role and a pool of 200 pays nothing until both are gone. An interview's payer
is decided by the order interviews were completed in and never changes
afterwards.

**When it is billed.** Always the calendar month that has just ended, decided by
when each interview completed. How it reaches the client depends on how they pay
the platform fee.

- **Monthly clients.** When Stripe opens the next invoice, last month's usage is
  added to it as line items before it goes out. One invoice, platform fee and
  usage together.
- **Annual clients.** Their platform-fee invoice appears once a year, so a
  scheduled job raises a separate usage invoice on the **1st of each month**. The
  job runs daily and does nothing on any other day, so a missed day is a missed
  run rather than a missed month.

**Subscriptions start on the 1st.** An Enterprise checkout anchors the
subscription's billing cycle to the next 1st of the month at 00:00 UTC, and the
part-month before that is charged up front as a proration. Without this, a client
who signed up on the 20th would be invoiced on the 20th while their usage was
being calculated for calendar months.

**What the invoice looks like.** One line per role, naming the entity where the
role belongs to a child client, and whether the role is still open:

```
Interviews — Hygienist [open] (August 2026)                12 x $25.00   $300.00
Interviews — Downtown Office · Front Desk [closed] (August 2026)  3 x $25.00  $75.00
```

**An interview with no completion time.** Completion is recorded on the
interview when it finishes. If that write failed, the interview has no month to
be billed in, so it is billed on the invoice being built now, logged as
`usage_missing_completed_at` with the interview and client id, and stamped with
the billing time so it behaves normally from then on. **A `usage_missing_completed_at`
line means a completion stamp failed and is worth investigating** — the billing
is correct either way, but something upstream did not finish cleanly.

**An interview is never billed twice.** Each billed interview is recorded
individually, and the database refuses a second record for the same interview.
That holds across retries, redelivered Stripe events, and a re-run of the same
period.

**If no per-interview price is set**, nothing is billed. The system will not
guess a price.

**If Stripe is unavailable part-way through**, the work is already written down
before any charge is created, so the retry picks up exactly the part that did not
finish. Nothing is lost and nothing is charged twice.

**If the invoice has already been finalized** when the usage is calculated, it is
left alone and the usage is carried into the next cycle. This is logged as
`usage_invoice_already_finalized`.

---

## Administrator endpoints

All of these require an authenticated administrator.

### How a client's pricing and model are set

There is no direct edit. Pricing is set on the **membership agreement** — the
Billing → Agreement Generator form in the admin console — and becomes the
client's plan settings only once the client has signed and paid:

1. An administrator generates the agreement
   (`POST /admin/billing/agreements/send`), choosing the membership tier and
   billing option, and for Enterprise the platform fee, per-role fee, included
   interviews per role, additional-interview fee and per-interview usage price.
2. The client opens the signing link, signs, and pays through Stripe checkout.
3. The Stripe subscription webhook writes `client_plan_settings` from the
   agreement's values.

Until step 3 nothing is written, so an agreement that is never paid changes
nothing.

| Field | Meaning | Units |
| --- | --- | --- |
| `per_role_fee` | Charge to open a role | dollars |
| `included_interviews_per_role` | Free interviews per role | count |
| `additional_interview_fee` | Price of a top-up interview | dollars |
| `usage_interview_fee_cents` | Enterprise per-interview price | **cents** |

Note the mixed units: `usage_interview_fee_cents` is in cents, the other money
fields are in dollars. This follows the existing column conventions.

**Nothing in the backend writes `billing_model`.** Not the Stripe webhook, not
the agreement activation, not the public purchase activation. Every new client
therefore starts with it empty, which means "follow the tier", and a Stripe
event never changes it.

A value in the column is an explicit choice for that one client: for example,
an Enterprise client billed on `rollover` instead of `usage`. It wins over the
tier and survives every subscription event, including a change of tier. There
is no admin screen or endpoint for it yet; it is set directly in the database.
To put a client back on their tier's model, set it to empty (`null`), not to
the tier's model, or a later tier change will not move them.

`rollover_days` is 90 for every client; there is no setting for it.

> **The Agreement Generator form does not yet have a field for the Enterprise
> per-interview usage price.** The backend accepts `usage_interview_fee_cents`
> on the agreement and carries it through to the client's plan settings, but
> the form has no input for it. Until one is added, Enterprise usage cannot be
> priced through the form, and a usage client is billed nothing for overage.

`POST /admin/clients/:id/subscription-checkout` is the other way to start an
Enterprise subscription. It takes the same fields directly in the request body.

### Raise a usage invoice now

```
POST /admin/clients/:id/usage-invoice
Idempotency-Key: <8 to 255 characters; letters, digits and . : _ - >
```

Invoices everything unbilled immediately, rather than waiting for the cycle. This
is the path for a one-time order at signup.

The `Idempotency-Key` header is **required**. Sending the same key twice returns
the first answer rather than raising a second invoice. Sending the same key with
different data is refused.

Returns `{ "skipped": true, "reason": "..." }` when there is nothing to bill.

### Read everything about a client's billing

```
GET /admin/clients/:id/billing-summary
```

Returns the billing model, the plan settings, current credits, unbilled usage,
and the last twelve usage invoices.

---

## Client endpoints

Field-by-field request and response shapes for every endpoint below, with an
example per billing model and every error code, are in
[`docs/billing-frontend-contract.md`](billing-frontend-contract.md) — that is the
document to hand a frontend developer.

Both require an authenticated client user and return only that client's data.

```
GET /clients/billing/credits
GET /clients/billing/usage
GET /clients/billing/pool
```

`credits` lists unspent credit — the role it came from, how much is left, and
when it expires — soonest to expire first. A client with no credits gets an empty
list, not an error.

`usage` shows what a usage client has run and not yet been invoiced for, plus the
last twelve invoices their usage was billed on. It is read-only and does not
contact Stripe.

`pool` shows what is left of the Enterprise interview pool bought at signup.

**The dashboard figure and the invoice are not the same number, deliberately.**
What these endpoints report as unbilled is *live*: every metered interview not
yet invoiced, including one that finished a minute ago. An invoice covers the
calendar month that has ended. So the dashboard will usually show more than the
next invoice charges. Both come from the same calculation over the same data and
differ only in how far back they look.

Every figure on these endpoints is worked out when it is asked for, from the
interviews table, by the same function the invoice is built from — so a screen
and a bill cannot disagree, and no number needs repairing after a failure.

`GET /roles` also now returns `own_remaining_interviews`, `credit_interviews` and
`billing_model` for each role, alongside the counts it already returned.

---

## Configuration required before this works

### 1. Stripe webhook subscription

The Stripe webhook endpoint **must be subscribed to `invoice.created`**. It is
not today. Without it, monthly Enterprise clients will not have their usage added
to their invoices.

Add it in the Stripe dashboard under Developers, Webhooks, your endpoint, then
"Select events".

### 2. Environment variable

```
USAGE_BILLING_CRON_SECRET=<a long random value>
```

Used by the monthly usage cron, in the same way as `CONTRACTS_CRON_SECRET`. If it
is unset, the endpoint refuses every request rather than letting them through.

### 3. Scheduled job

```
POST /internal/billing/usage-invoices
Header: x-cron-secret: <USAGE_BILLING_CRON_SECRET>
```

Run this **once a day**. The job bills annual Enterprise clients only, and does
nothing at all unless the day is the **1st of the month** in UTC — it answers
`{ "skipped": "not_first_of_month" }` otherwise. Running it daily is correct, and
running it twice on the 1st is harmless: an interview already on the ledger is
never billed again.

It always answers `200` with a per-client breakdown, even if an individual client
fails, so that a scheduler does not replay the clients that already succeeded.
Check the `failed` count and the `results` array.

---

## Migrations

Every migration this billing work added, in the order they apply. Names are
timestamps, so alphabetical order is run order.

| File | What it does |
| --- | --- |
| `20261009120000_billing_models.sql` | Adds `billing_model` (no default, may be empty: empty means "follow the plan tier"), `usage_interview_fee_cents` and `rollover_days` to `client_plan_settings`, and backfills each existing client to the model its tier implies. On a database that already has `billing_model` from an earlier version of this migration, it removes the old `not null` and `default 'fixed'` |
| `20261009130000_interview_credits.sql` | Creates `interview_credits` — what was minted and when it lapses, with a partial unique index giving a closed role at most one live credit |
| `20261009140000_usage_billing_ledger.sql` | Creates `usage_billing_ledger`, with a unique constraint on `interview_id` — the guard that stops an interview being billed twice |
| `20261009150000_billing_idempotency_keys.sql` | Creates `billing_idempotency_keys`, for the `Idempotency-Key` contract on the money-spending admin routes |
| `20261009160000_role_interview_purchase_failed_status.sql` | Widens the status check on `role_interview_purchases` to allow `failed`, which the code already wrote |
| `20261009170000_enterprise_pool_discounts.sql` | Creates `enterprise_pool_discounts` and seeds the volume bands for pool pricing |
| `20261009180000_client_interview_pools.sql` | Creates `client_interview_pools` — what was bought and whether it was paid for |
| `20261009190000_interviews_completed_at.sql` | Adds `completed_at` to `interviews`, indexes `(client_id, completed_at)`, and backfills existing rows |
| `20261009200000_client_plan_settings_money_units.sql` | Comments only: records which `client_plan_settings` money columns are dollars and which are cents, and that a zero included count is a setting. Changes no column and no value |
| `20261011120000_billing_model_follow_plan_tier.sql` | Empties `billing_model` wherever it only repeats the client's own tier (Essentials with `fixed`, Pro with `rollover`, Enterprise with `usage`). Those values were stamped by the first migration and by the webhook, not chosen. No client changes model when it runs; afterwards a tier change moves them. A value that differs from the tier is left alone |

### Why these run after the client's own migrations

These nine files used to be dated September (`20260921…` to `20260927…`), in
between migrations from the client's own sales work. They were re-dated to
`20261009120000` onwards, in the same order, so they now run after all of the
client's migrations (the last is `20261008215557`). None of the client's
migrations depends on anything these create, and none of these depends on a
client migration dated after them, so a fresh database ends up the same.

If any environment had already applied them under their old names, its
migration history would list the nine old versions, and the next
`supabase db push` would see nine "new" files and nine unknown old versions.
That environment would need its migration history repaired first. As recorded in
`review/BILLING-LOG.md`, none of them had been applied to the client's database
when they were re-dated.

### Which of these touch tables this repository does not define

Most of the schema predates this repository: `interviews`, `clients`, `roles`
and `client_plan_settings` have no `create table` anywhere in
`supabase/migrations`. They are created and governed elsewhere, so a migration
that touches one is changing a table whose access model is **not** visible here.

| Migration | Foreign table it changes | What that means |
| --- | --- | --- |
| `20261009120000_billing_models.sql` | `client_plan_settings` | Adds three columns and backfills them. No change to who can read the table. |
| `20261009190000_interviews_completed_at.sql` | `interviews` | Adds one column and one index, and backfills it. |
| `20261009200000_client_plan_settings_money_units.sql` | `client_plan_settings` | Comments only. No column, value or access changes. |
| `20261011120000_billing_model_follow_plan_tier.sql` | `client_plan_settings` | Empties `billing_model` where it equals the tier's default. No column or access changes. |

**`20261009190000_interviews_completed_at.sql` deliberately contains no RLS,
`grant` or `revoke` statement**, and a test asserts it never gains one.
`public.interviews` is not in the containment migration that locks the billing
tables down, so it carries policies from outside this repository — very likely
ones that let an authenticated dashboard user read their own client's rows.
Revoking on it to match the billing tables would have broken the frontend.
Adding a column is not a reason to change a table's access model.

The other migrations create their own tables, so they set their own access:
every one enables row-level security, revokes all privileges from `anon` and
`authenticated`, and grants only the service role. Nothing reaches them except
the backend.

### Two things the client should check against the live database

1. **Does `interviews.updated_at` have a default or a trigger?** Nothing in
   `supabase/migrations` sets one, and the code writes it on some paths and not
   others. It is no longer used for anything that decides money, but the C1
   backfill of `completed_at` used it, so it is worth knowing what is really
   there.
2. **The `completed_at` backfill is approximate for older video interviews.**
   It used `updated_at`, which on the scored-transcript path can predate the
   finish. Interviews completed from C1 onwards carry a real stamp. Only
   historical reporting is affected: nothing already billed is re-billed, because
   the ledger is what prevents that.

### Safe to re-run

All of them. Every table creation is `create table if not exists`, every column
addition is guarded by an existence check, and every backfill only fills rows
that are still null — so re-running will not overwrite a model an administrator
has since changed by hand, or move a completion time that is already recorded.
`20261011120000` only empties values that equal the tier's default, so a second
run finds nothing to do.

### Rolling back

Rolling back is a configuration change, not a migration.

1. **Stop the charging.** Remove the `invoice.created` subscription from the
   Stripe webhook endpoint and disable the daily usage cron. No further usage is
   billed from that moment.
2. **Stop the credits.** `update client_plan_settings set billing_model =
   'fixed'` stops minting and spending immediately, and it holds: no Stripe
   event writes the column, so it stays `fixed` until someone changes it. The
   durable rollback is still to revert the Billing 2 and Billing 3 commits.

Once no client is on `rollover` or `usage`, the new columns and tables are inert. Leave them in place: they hold the record of what was
billed and what credit was issued, which is needed to answer questions about past
invoices. Dropping them would discard that history.
