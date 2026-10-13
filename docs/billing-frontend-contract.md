# Billing API contract

Written for the frontend developer building the billing and role screens. It
describes every endpoint the dashboard needs, every field in the response, what
each field means on each billing model, and every error you can be handed.

`docs/billing-models.md` explains *why* the models behave as they do. This file
is only what comes over the wire.

---

## The three models

Every client is on exactly one billing model. Almost every field below means
something slightly different depending on which:

| `billing_model` | Plan tier | In one sentence |
| --- | --- | --- |
| `fixed` | Essentials | A per-role allowance; unused interviews are lost when the role closes. |
| `rollover` | Pro | A per-role allowance; what is unused when a role closes becomes client credit for 90 days. |
| `usage` | Enterprise | A per-role included count, then an interview pool, then a per-interview charge on the invoice. |

`billing_model` is never chosen by a user. It is derived from the plan tier when
the Stripe subscription webhook runs. Treat it as read-only and branch on it.

**Always branch on `billing_model`, never on the plan name.** A client's tier is
display text; the model is what the numbers mean.

---

## Two figures that are not the same

This trips people up, so it is worth stating before the endpoints.

- **What a dashboard shows as unbilled usage is live.** It is every metered
  interview that has not yet been invoiced, whenever it ran — including one that
  finished a minute ago. That is the figure a client wants when they ask "what is
  this costing me".
- **What lands on an invoice is the calendar month that has ended.** Interviews
  run this month are billed next month.

So `GET /clients/billing/usage` will usually show *more* than the next invoice
will charge, and that is correct. If you display it next to an invoice total,
label it as running usage, not as an amount due.

---

## Client endpoints

All require an authenticated client user. All return only data for clients the
caller is a member of.

Where an endpoint takes `client_id`, it is **required if the user belongs to more
than one client** — otherwise you get `400 client_id_required`. With exactly one
membership it may be omitted.

### GET /clients/billing/summary

The subscription state of each client the caller can see. Not about interviews.

<!-- fields: GET /clients/billing/summary items[] -->

| Field | Type | Null? | Meaning |
| --- | --- | --- | --- |
| `id` | string (uuid) | no | Client id. |
| `name` | string | yes | Client name. |
| `plan_tier` | string | yes | `basic`, `pro` or `enterprise`. Display only. |
| `billing_status` | string | yes | Free text from the client record. |
| `billing_interval` | string | yes | `monthly`, `annual`, or `prepaid`. Use `membership_terms` for an accepted retail commitment. |
| `auto_renew` | boolean | yes | Whether the subscription renews. |
| `current_term_end` | string (ISO 8601) | yes | End of the current provider billing period. This alone is not a funded-access or membership-commitment proof. |
| `contract_end_at` | string (ISO 8601) | yes | End of the contract, if one is set. |
| `subscription_status` | string | yes | Stripe's subscription status. |
| `cancel_at_term_end` | boolean | yes | Set when a cancellation is scheduled. |
| `access_override_mode` | string | yes | An administrative override on access. |
| `has_stripe_customer` | boolean | no | Whether a Stripe customer exists. **The id itself is never sent.** |
| `membership_terms` | object | yes | Read-only accepted retail terms for a current signed, paid agreement. Null for legacy or pending agreements. |

Response: `{ "items": [ … ] }`. An empty array is a normal answer.

The accepted terms come from the existing signed agreement snapshot, preserving
historical prices. Malformed marked agreements and a client binding that changes
during the read cause an error. This projection does not consult today's price
catalog, count received installments, calculate an unpaid balance, or change
renewal settings. Parent billing permissions apply to child scopes.

<!-- fields: GET /clients/billing/summary items[].membership_terms -->

| Field | Type | Null? | Meaning |
| --- | --- | --- | --- |
| `commitment_months` | integer | no | Accepted membership commitment: 3, 6, or 12 months. |
| `payment_option` | string | no | `prepaid` or `monthly_installments`. |
| `currency` | string | no | `usd`. |
| `platform_payment_cents` | integer | no | Accepted platform fee per scheduled payment, excluding roles, interviews, and tax. |
| `platform_commitment_total_cents` | integer | no | Full platform commitment; not a paid amount or remaining balance. |
| `installment_count` | integer | no | One prepaid payment or the accepted number of monthly payments. |
| `current_term_start_at` | string (ISO 8601) | no | Current membership commitment start, validated against the original first-payment anchor. |
| `current_term_end_at` | string (ISO 8601) | no | Current membership commitment end; use this instead of the provider's individual payment-cycle end. |
| `auto_renew` | boolean | no | Current next-term renewal preference; remaining monthly payments still belong to the current commitment. |

### GET /clients/billing/credits

Interview credit the client can still spend, soonest to expire first.

**Per model:** `rollover` is the only model that mints credit. On `fixed` and
`usage` this is always an empty list — that is a normal answer, not an error, so
do not treat it as a failure or hide the section behind a model check.

<!-- fields: GET /clients/billing/credits -->

| Field | Type | Null? | Meaning |
| --- | --- | --- | --- |
| `items` | array | no | The spendable credits. May be empty. |
| `total_remaining` | integer | no | Interviews left across all credits. |

<!-- fields: GET /clients/billing/credits items[] -->

| Field | Type | Null? | Meaning |
| --- | --- | --- | --- |
| `id` | string (uuid) | no | Credit id. |
| `source_role_id` | string (uuid) | yes | The role whose closure minted it. |
| `source_role_title` | string | yes | That role's title. Null if the role is not one of this client's own. |
| `quantity` | integer | no | Interviews the credit was minted with. |
| `remaining` | integer | no | Interviews still unspent. Always ≥ 1 — a spent credit is not listed. |
| `minted_at` | string (ISO 8601) | yes | When the role closed. |
| `expires_at` | string (ISO 8601) | yes | When it lapses. Null means no expiry. |

`remaining` is computed at read time from the interviews that have been run
against the credit. It moves the moment an interview completes; there is no lag.

### GET /clients/billing/usage

What a usage client has run and not yet been invoiced for, plus what it has
already been invoiced.

**Per model:** only `usage` ever has lines. On `fixed` and `rollover` you get
`lines: []`, `total_cents: 0`, `billable: false` — again a normal answer.

<!-- fields: GET /clients/billing/usage -->

| Field | Type | Null? | Meaning |
| --- | --- | --- | --- |
| `lines` | array | no | One entry per role with unbilled metered interviews. |
| `total_cents` | integer | no | The sum of the lines, in **cents**. |
| `billable` | boolean | no | `true` when there is at least one line. |
| `billed_invoices` | array | no | The last twelve invoices this usage was billed on, newest first. |

<!-- fields: GET /clients/billing/usage lines[] -->

| Field | Type | Null? | Meaning |
| --- | --- | --- | --- |
| `role_id` | string (uuid) | no | The role the interviews were run under. |
| `role_title` | string | no | Its title. Falls back to `"Role"` if the role record is gone. |
| `role_status` | string | no | `open` or `closed`. A closed role can still have unbilled interviews. |
| `entity_label` | string | yes | The child entity the role belongs to, when the payer is a parent client. Null for the payer's own roles. |
| `quantity` | integer | no | Interviews on this line. |
| `unit_price_cents` | integer | no | The client's per-interview price, in **cents**. |
| `amount_cents` | integer | no | `quantity × unit_price_cents`. |
| `interview_ids` | array of string | no | The interviews counted. Useful for drill-down; do not display raw. |

<!-- fields: GET /clients/billing/usage billed_invoices[] -->

| Field | Type | Null? | Meaning |
| --- | --- | --- | --- |
| `stripe_invoice_id` | string | no | The Stripe invoice. |
| `interviews` | integer | no | How many interviews were on it. |
| `amount_cents` | integer | no | What was charged for them, in **cents**. |
| `period_start` | string (ISO 8601) | yes | Start of the month billed. |
| `period_end` | string (ISO 8601) | yes | Exclusive end of the month billed. |
| `month_label` | string | yes | That month in words, e.g. `"August 2026"`. Use this for display. |
| `billed_at` | string (ISO 8601) | yes | When it was charged. |

History comes from the billing ledger, so a past invoice never changes if a role
is renamed or a price is updated. Live figures come from the interviews; history
does not.

### GET /clients/billing/pool

The Enterprise interview pool bought at signup.

**Per model:** only `usage` clients have a pool. Others get zeroes and an empty
`items` array.

<!-- fields: GET /clients/billing/pool -->

| Field | Type | Null? | Meaning |
| --- | --- | --- | --- |
| `billing_model` | string | yes | `fixed`, `rollover`, `usage`, or null if the client's plan could not be resolved. |
| `purchased` | integer | no | Interviews bought across all paid pool blocks. |
| `used` | integer | no | How many have been run against them. |
| `remaining` | integer | no | `purchased − used`, never below zero. |
| `items` | array | no | One entry per paid pool block. Unpaid blocks are not listed. |

<!-- fields: GET /clients/billing/pool items[] -->

| Field | Type | Null? | Meaning |
| --- | --- | --- | --- |
| `id` | string (uuid) | no | Pool block id. |
| `quantity_purchased` | integer | no | Interviews in the block. |
| `used` | integer | no | Interviews drawn from it. Blocks are used oldest first. |
| `remaining` | integer | no | What is left of it. |
| `paid_at` | string (ISO 8601) | yes | When it settled. |
| `created_at` | string (ISO 8601) | yes | When it was reserved. |

The pool belongs to the paying client and is **shared with its child entities**:
an interview run under a child's role draws the parent's pool.

### POST /clients/billing/portal-session

Opens the Stripe billing portal. Body: `{ "client_id": "…", "tab": "billing" }`.

<!-- fields: POST /clients/billing/portal-session -->

| Field | Type | Null? | Meaning |
| --- | --- | --- | --- |
| `ok` | boolean | no | Always `true` on success. |
| `url` | string | yes | Where to send the browser. Null means Stripe returned no URL; treat as a failure. |

Requires write access to the client and an existing Stripe customer, otherwise
`400 missing_stripe_customer`.

### POST /clients/billing/additional-interviews/checkout-session

Buys more interviews for one role.

Body: `client_id` (required), `role_id` (required), `quantity` (required,
positive integer), `tab` (optional), `embedded` (optional boolean).

<!-- fields: POST /clients/billing/additional-interviews/checkout-session -->

| Field | Type | Null? | Meaning |
| --- | --- | --- | --- |
| `ok` | boolean | no | Always `true` on success. |
| `url` | string | yes | Hosted checkout URL. Null when embedded checkout was requested. |
| `role_interview_purchase_id` | string (uuid) | no | The pending purchase. It becomes `paid` when Stripe settles, and the interviews appear on the role then — not before. |
| `checkout_client_secret` | string | yes | For Stripe's embedded checkout. Null for hosted. |
| `embedded_checkout` | boolean | no | Which of the two you were given. |

**Per model:** `usage` clients are refused with `409 usage_billing_no_top_ups`.
They are invoiced for interviews beyond the included count after the fact, so
buying in advance would charge twice. **Hide the top-up button entirely when
`billing_model === 'usage'`** rather than letting the user hit the error.

### GET /roles — the availability fields

Each role in the list carries the interview figures alongside its other fields.

<!-- fields: GET /roles availability -->

| Field | Type | Null? | Meaning |
| --- | --- | --- | --- |
| `included_interviews_per_role` | integer | yes | The free allowance every role gets on this plan. Null when the plan could not be resolved. |
| `purchased_interviews` | integer | yes | Extra interviews bought for this role specifically. |
| `used_interviews` | integer | yes | Interviews this role has actually used. |
| `remaining_interviews` | integer | yes | What the role can still run. **Null on `usage`** — see below. |
| `own_remaining_interviews` | integer | yes | What is left of this role's own allowance, before credit. |
| `credit_interviews` | integer | yes | Client credit spendable on this role. Always 0 outside `rollover`. |
| `billing_model` | string | yes | The model these numbers should be read under. |

**`remaining_interviews` is null for `usage` clients, and that does not mean
zero.** There is no cap: an interview past the pool is charged, not refused.
Render "billed per interview" or the pool figure, never "0 remaining".

On `fixed` and `rollover`, `remaining_interviews` is
`own_remaining_interviews + credit_interviews`. Show the breakdown if you want
to explain a number, but the total is the one to gate on.

Every one of these is `null` when the client's plan settings cannot be read.
Treat null as "unknown", not as zero.

---

## Administrator endpoints

Require an authenticated administrator.

### GET /admin/roles — the availability fields

The same eight figures as the client roles list, plus the pool. An
administrator's list can span many clients; the figures for each role are those
of whoever pays for it.

<!-- fields: GET /admin/roles availability -->

| Field | Type | Null? | Meaning |
| --- | --- | --- | --- |
| `included_interviews_per_role` | integer | yes | The free allowance every role gets on that client's plan. |
| `purchased_interviews` | integer | yes | Extra interviews bought for this role specifically. |
| `used_interviews` | integer | yes | Interviews this role has used. |
| `remaining_interviews` | integer | yes | What the role can still run. **Null on `usage`** — no limit, not zero. |
| `own_remaining_interviews` | integer | yes | What is left of the role's own allowance, before credit. |
| `credit_interviews` | integer | yes | Client credit spendable on this role. 0 outside `rollover`. |
| `pool_remaining_interviews` | integer | yes | What is left of the payer's Enterprise pool. 0 outside `usage`. |
| `billing_model` | string | yes | Which model these numbers should be read under. |

**`billing_model` is how a null `remaining_interviews` is read.** Null with
`billing_model: "usage"` means there is no cap — show the pool figure instead.
Null with `billing_model: null` means the client's plan could not be read, and
nothing about that role's capacity is known. Rendering either as "0 remaining"
is wrong, and for different reasons.

The rest of the role payload — title, status, rubric, `job_description_replacement`
and the entity fields — is unchanged.


### GET /admin/clients/:id/billing-summary

Everything about one client's billing in a single call.

<!-- fields: GET /admin/clients/:id/billing-summary -->

| Field | Type | Null? | Meaning |
| --- | --- | --- | --- |
| `ok` | boolean | no | Always `true` on success. |
| `client_id` | string (uuid) | no | Echoed back. |
| `billing_model` | string | yes | `fixed`, `rollover`, `usage`, or null if unresolved. |
| `plan_settings` | object | yes | The row from `client_plan_settings`, or null if the client has none. |
| `credits` | object | no | `{ items, total_remaining }`, same item shape as the client endpoint minus the role title. |
| `interview_pool` | object | no | `{ items, purchased, used, remaining }`, same shape as `GET /clients/billing/pool`. |
| `roles` | array | no | Per-role counts, below. |
| `unbilled_usage` | object | no | `{ lines, total_cents }`, same line shape as the client endpoint. |
| `recent_usage_invoices` | array | no | The last twelve billed invoices, newest first, same shape as `billed_invoices`. |

<!-- fields: GET /admin/clients/:id/billing-summary roles[] -->

| Field | Type | Null? | Meaning |
| --- | --- | --- | --- |
| `role_id` | string (uuid) | no | The role. |
| `client_id` | string (uuid) | yes | Which client owns it — a child entity, where there is one. |
| `title` | string | yes | Role title. |
| `status` | string | yes | `active` or `inactive` as stored on the role. |
| `allowance` | integer | no | Included count plus anything bought for this role. |
| `used` | integer | no | Interviews used. |
| `own` | integer | no | Of those, paid by the role's own allowance. |
| `credit` | integer | no | Paid by client credit. |
| `pool` | integer | no | Paid from the Enterprise pool. |
| `usage` | integer | no | Metered — these are what get invoiced. |
| `own_remaining` | integer | no | What is left of the role's own allowance. |

`used = own + credit + pool + usage`, always. If it does not add up, that is a
bug worth reporting.

`plan_settings` carries `plan_tier`, `billing_model`, `billing_interval`,
`platform_fee`, `per_role_fee`, `included_interviews_per_role`,
`additional_interview_fee`, `usage_interview_fee_cents`, `rollover_days` and
`updated_at`.

**Money units are mixed and this is deliberate, matching the columns.**
`usage_interview_fee_cents` and every `*_cents` field are in cents;
`platform_fee`, `per_role_fee` and `additional_interview_fee` are in dollars.

### POST /admin/clients/:id/usage-invoice

Raises a usage invoice for the prior UTC calendar month instead of waiting for
the cycle. Send `{}` (or no body). A date selector or any other body field is
rejected with 400 `PERIOD_NOT_SELECTABLE` before reserving the key or charging.

Requires an `Idempotency-Key` header: 8–255 characters of letters, digits and
`. : _ -`. The same key with the same body replays the first answer; the same
key with a different body is refused.

Returns either `{ "ok": true, "invoice_id": …, "total_cents": …,
"period_start": …, "period_end": … }` or
`{ "ok": true, "skipped": true, "reason": … }` when there is nothing to bill.
If `USAGE_INVOICE_FAILED` includes `USAGE_INVOICE_REQUIRES_REVIEW`, do not suggest
blind retries. The operator must reconcile the held Stripe draft/reservation.

---

## The agreement form

Enterprise pricing is not edited directly. It is set on the membership agreement
(Billing → Agreement Generator) and becomes the client's plan settings only once
the client has signed and paid.

| Form field | Sent as | Type | Required | Notes |
| --- | --- | --- | --- | --- |
| Client legal name | `client_legal_name` | string | yes | |
| DBA / trade name | `dba_trade_name` | string | no | |
| Primary admin | `primary_admin_name` | string | yes | |
| Admin email | `admin_email` | string | yes | Lower-cased. |
| Membership tier | `membership_tier` | `basic` \| `pro` \| `enterprise` | yes | Anything unrecognised becomes `basic`. |
| Billing option | `billing_option` | `monthly` \| `annual` | yes | |
| Platform fee | `platform_fee` | number, **dollars** | Enterprise | May be 0. |
| Per-role fee | `per_role_fee` | number, **dollars** | Enterprise | May be 0. |
| Included interviews per role | `included_interviews_per_role` | integer | Enterprise | **May be 0**, meaning the client is billed from the pool and the meter from their first interview. |
| Additional interview fee | `additional_interview_fee` | number, **dollars** | Enterprise | May be 0. |
| Per-interview usage price | `usage_interview_fee_cents` | integer, **cents** | no | **The form has no input for this yet — it needs one.** Without it an Enterprise client is billed nothing for metered interviews. |
| Interview pool quantity | `pool_quantity` | integer | no | Interviews bought up front. Absent or 0 means no pool. Priced by volume bands when the agreement is sent. |
| Max interview minutes | `max_interview_minutes` | integer | no | Must be at least 1. |
| Term start | `initial_term_start` | date | yes | |
| Renewal date | `initial_renewal_date` | date | yes | |
| Auto renew | `auto_renew` | boolean | no | Defaults to true. |
| Notice days | `notice_deadline_days` | integer | no | Defaults to 30. |

**Send zero as a number or the string `"0"` — both are accepted and both mean
zero.** Send an empty string or omit the field to mean "not set"; an Enterprise
agreement missing any of the four required fee fields is refused at checkout
with `invalid_enterprise_checkout_fields`.

`billing_model` and `rollover_days` are not form fields. The first is derived
from the tier; the second is 90 for everyone.

---

## Error codes

Errors come back as `{ "error": "<code>", "detail": "…" }`, some also with an
upper-case `code`. Match on `error`; `detail` is for logs, not for users.

### Client billing

| Status | `error` | When |
| --- | --- | --- |
| 400 | `client_id_required` | The user belongs to several clients and none was named. |
| 400 | `invalid_quantity` | Top-up quantity is not a positive whole number. |
| 400 | `invalid_additional_interview_fee` | The client has no valid top-up price configured. |
| 400 | `missing_stripe_customer` | Portal requested for a client with no Stripe customer. |
| 400 | `role_id_required` | Top-up without a role. |
| 403 | `forbidden` | Not a member of the client, or no write access for a purchase. |
| 404 | `client_not_found` | |
| 404 | `role_not_found` | The role is not this client's. |
| 409 | `usage_billing_no_top_ups` (`USAGE_BILLING_NO_TOP_UPS`) | A `usage` client tried to buy interviews in advance. Hide the button instead. |
| 500 | `list_credits_failed` | |
| 500 | `read_usage_failed` | |
| 500 | `read_pool_failed` | |
| 500 | `list_billing_summary_failed` | |
| 500 | `create_portal_session_failed` | |
| 500 | `create_additional_interviews_checkout_session_failed` | |
| 500 | `create_role_interview_purchase_failed` | |
| 500 | `update_role_interview_purchase_failed` | |
| 500 | `plan_settings_lookup_failed`, `role_lookup_failed`, `client_lookup_failed`, `stripe_customer_create_failed`, `server_error` | Infrastructure. Retry is reasonable. |

### Admin billing

Admin errors carry both `error: "invalid_request" | "internal_error" | …` and a
specific upper-case `code`. Match on `code`.

| Status | `code` | When |
| --- | --- | --- |
| 400 | `CLIENT_ID_REQUIRED` | |
| 400 | `INVALID_BILLING_CYCLE` | Billing interval is neither monthly nor annual. |
| 400 | `IDEMPOTENCY_KEY_REQUIRED` | The usage-invoice header is missing or malformed. |
| 400 | `PERIOD_NOT_SELECTABLE` | The usage-invoice request contains unsupported body fields. |
| 400 | `ACTOR_REQUIRED` | No administrator identity on the request. |
| 404 | `CLIENT_NOT_FOUND` | |
| 409 | `IDEMPOTENCY_KEY_REUSED` | Same key, different body. |
| 409 | `REQUEST_IN_PROGRESS` | The first call with this key has not finished. |
| 409 | `ENTERPRISE_CHECKOUT_NOT_CONFIGURED` | Enterprise fees are missing or unusable. |
| 409 | `STRIPE_PRICE_NOT_CONFIGURED` | No Stripe price for that tier and interval. |
| 500 | `BILLING_READ_FAILED`, `BILLING_SUMMARY_FAILED`, `PLAN_SETTINGS_LOOKUP_FAILED`, `CLIENT_LOOKUP_FAILED`, `CLIENT_UPDATE_FAILED`, `IDEMPOTENCY_LOOKUP_FAILED`, `STRIPE_CHECKOUT_SESSION_FAILED`, `STRIPE_CUSTOMER_CREATE_FAILED`, `USAGE_INVOICE_FAILED` | Infrastructure or Stripe. |

### Agreement checkout

| Status | `code` | When |
| --- | --- | --- |
| 400 | `token_required` | No signing token. |
| 404 | `token_invalid` | Unknown or superseded signing link. |
| 409 | `agreement_not_checkout_eligible` | Not signed, or superseded. |
| 409 | `agreement_checkout_already_paid` | |
| 409 | `invalid_agreement_plan` / `invalid_agreement_billing_interval` | Bad tier or interval on the agreement. |
| 409 | `invalid_enterprise_checkout_fields` | An Enterprise agreement is missing one of the four required fee fields. Zero is **not** missing. |
| 410 | `agreement_expired` | Past the agreement's deadline. |

---

## Example responses

### Essentials — `fixed`

`GET /clients/billing/credits`

```json
{ "items": [], "total_remaining": 0 }
```

`GET /clients/billing/usage`

```json
{ "lines": [], "total_cents": 0, "billable": false, "billed_invoices": [] }
```

`GET /roles` (availability fields on one role)

```json
{
  "included_interviews_per_role": 20,
  "purchased_interviews": 5,
  "used_interviews": 22,
  "remaining_interviews": 3,
  "own_remaining_interviews": 3,
  "credit_interviews": 0,
  "billing_model": "fixed"
}
```

### Pro — `rollover`

`GET /clients/billing/credits`

```json
{
  "items": [
    {
      "id": "8f1c…",
      "source_role_id": "b2d9…",
      "source_role_title": "Receptionist",
      "quantity": 12,
      "remaining": 7,
      "minted_at": "2026-08-14T09:12:03.000Z",
      "expires_at": "2026-11-12T09:12:03.000Z"
    }
  ],
  "total_remaining": 7
}
```

`GET /roles` (availability fields on one role)

```json
{
  "included_interviews_per_role": 30,
  "purchased_interviews": 0,
  "used_interviews": 30,
  "remaining_interviews": 7,
  "own_remaining_interviews": 0,
  "credit_interviews": 7,
  "billing_model": "rollover"
}
```

The role's own allowance is spent, but it can still run 7 interviews on credit.
Do not show it as full.

### Enterprise — `usage`

`GET /clients/billing/usage`

```json
{
  "lines": [
    {
      "role_id": "c41a…",
      "role_title": "Hygienist",
      "role_status": "open",
      "entity_label": null,
      "quantity": 12,
      "unit_price_cents": 2500,
      "amount_cents": 30000,
      "interview_ids": ["…", "…"]
    },
    {
      "role_id": "77b0…",
      "role_title": "Front Desk",
      "role_status": "closed",
      "entity_label": "Downtown Office",
      "quantity": 3,
      "unit_price_cents": 2500,
      "amount_cents": 7500,
      "interview_ids": ["…"]
    }
  ],
  "total_cents": 37500,
  "billable": true,
  "billed_invoices": [
    {
      "stripe_invoice_id": "in_1Q…",
      "interviews": 9,
      "amount_cents": 22500,
      "period_start": "2026-07-01T00:00:00.000Z",
      "period_end": "2026-08-01T00:00:00.000Z",
      "month_label": "July 2026",
      "billed_at": "2026-08-01T06:03:11.000Z"
    }
  ]
}
```

`GET /clients/billing/pool`

```json
{
  "billing_model": "usage",
  "purchased": 50,
  "used": 44,
  "remaining": 6,
  "items": [
    {
      "id": "p0f2…",
      "quantity_purchased": 50,
      "used": 44,
      "remaining": 6,
      "paid_at": "2026-06-30T17:44:02.000Z",
      "created_at": "2026-06-30T17:41:55.000Z"
    }
  ]
}
```

`GET /roles` (availability fields on one role)

```json
{
  "included_interviews_per_role": 0,
  "purchased_interviews": 0,
  "used_interviews": 44,
  "remaining_interviews": null,
  "own_remaining_interviews": 0,
  "credit_interviews": 0,
  "billing_model": "usage"
}
```

`remaining_interviews` is null because there is no limit. Show the pool figure
and the per-interview price instead.

---

## Parent and child clients

A client may have child entities, one level deep. A child has no subscription of
its own:

- **Billing rolls up.** The pool, the usage and the invoices are the parent's.
  An invoice line for a child's role carries the child's name as
  `entity_label`.
- **Credit does not roll up.** A credit is earned by a role and stays with the
  client that owns that role. A parent does not see or spend a child's credit.
- **Role figures are per role**, whichever client owns it.
