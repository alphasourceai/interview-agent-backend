-- Sales commission is recognized per reviewed provider receipt, never by annualizing activation.
-- Service-role-only tables. No direct browser access or payment execution is granted.
create table if not exists public.sales_commission_departures (
  rep_user_id uuid primary key,
  final_day date not null,
  reviewed_by_user_id uuid not null,
  reviewed_at timestamptz not null default now(),
  evidence_reference text not null check (length(trim(evidence_reference)) between 4 and 300)
);

create table if not exists public.sales_commission_receipts (
  id uuid primary key default gen_random_uuid(),
  purchase_intent_id uuid not null,
  rep_user_id uuid not null,
  provider text not null check (provider in ('stripe', 'financing_partner', 'other_verified')),
  provider_payment_id text not null check (length(trim(provider_payment_id)) between 4 and 200),
  payment_kind text not null check (payment_kind in ('monthly', 'paid_in_full', 'financed_checkout')),
  currency text not null default 'usd' check (currency = 'usd'),
  payment_success_at timestamptz not null,
  funds_received_at timestamptz not null,
  qualification_closed_at timestamptz not null,
  first_term_start_at timestamptz not null,
  first_term_end_at timestamptz not null,
  rep_final_day date,
  gross_membership_cents bigint not null check (gross_membership_cents > 0),
  discount_cents bigint not null default 0 check (discount_cents >= 0),
  provider_fee_cents bigint not null default 0 check (provider_fee_cents >= 0),
  net_membership_cents bigint generated always as (gross_membership_cents - discount_cents - provider_fee_cents) stored,
  commission_cents bigint generated always as ((gross_membership_cents - discount_cents - provider_fee_cents + 1) / 2) stored,
  statement_week_start date not null check (extract(dow from statement_week_start) = 1),
  evidence_reference text not null check (length(trim(evidence_reference)) between 4 and 300),
  review_note text check (review_note is null or length(review_note) <= 1000),
  reviewed_by_user_id uuid not null,
  reviewed_at timestamptz not null default now(),
  policy_version text not null default '2026-10-02-receipt-v1',
  unique (provider, provider_payment_id),
  check (gross_membership_cents > discount_cents + provider_fee_cents),
  check (funds_received_at >= payment_success_at),
  -- Later installments follow the original qualifying close; they do not re-close the sale.
  check (first_term_end_at > first_term_start_at),
  check (qualification_closed_at >= first_term_start_at and qualification_closed_at < first_term_end_at),
  check (payment_success_at < first_term_end_at)
);
create index if not exists sales_commission_receipts_rep_week_idx
  on public.sales_commission_receipts (rep_user_id, statement_week_start, reviewed_at);
create index if not exists sales_commission_receipts_intent_idx
  on public.sales_commission_receipts (purchase_intent_id);

-- Filter in PostgreSQL before the API page limit. A stored completed intent is
-- only reviewable when its signed/paid agreement and client activation agree.
create or replace view public.sales_commission_review_candidates
with (security_invoker = true) as
select i.id, i.company_legal_name, i.buyer_email, i.selected_plan_key,
       i.selected_billing_cadence, i.created_by_user_id, i.activated_at
from public.public_purchase_intents i
join public.membership_agreements a on a.id = i.agreement_id and a.client_id = i.client_id
join public.clients c on c.id = i.client_id
where i.status = 'completed'
  and i.activated_at is not null
  and i.created_by_user_id is not null
  and a.status = 'signed' and a.checkout_status = 'paid'
  and a.signed_at is not null and a.checkout_paid_at is not null
  and c.billing_status = 'active'
  and coalesce(nullif(lower(btrim(c.subscription_status)), ''), 'active') in ('active', 'trialing');
revoke all on public.sales_commission_review_candidates from public, anon, authenticated;
grant select on public.sales_commission_review_candidates to service_role;

create table if not exists public.sales_commission_adjustments (
  id uuid primary key default gen_random_uuid(),
  receipt_id uuid not null references public.sales_commission_receipts(id) on delete restrict,
  adjustment_type text not null check (adjustment_type in ('refund', 'chargeback', 'recovery')),
  provider_event_id text not null check (length(trim(provider_event_id)) between 4 and 200),
  net_membership_delta_cents bigint not null check (net_membership_delta_cents <> 0),
  commission_delta_cents bigint not null,
  effective_at timestamptz not null,
  statement_week_start date not null check (extract(dow from statement_week_start) = 1),
  evidence_reference text not null check (length(trim(evidence_reference)) between 4 and 300),
  reviewed_by_user_id uuid not null,
  reviewed_at timestamptz not null default now(),
  unique (adjustment_type, provider_event_id),
  check ((adjustment_type = 'recovery' and net_membership_delta_cents > 0)
    or (adjustment_type in ('refund', 'chargeback') and net_membership_delta_cents < 0))
);
create index if not exists sales_commission_adjustments_receipt_idx
  on public.sales_commission_adjustments (receipt_id, reviewed_at);

create table if not exists public.sales_commission_payouts (
  id uuid primary key default gen_random_uuid(),
  receipt_id uuid not null references public.sales_commission_receipts(id) on delete restrict,
  amount_cents bigint not null check (amount_cents > 0),
  ach_reference text not null unique check (length(trim(ach_reference)) between 4 and 200),
  paid_at timestamptz not null,
  evidence_reference text not null check (length(trim(evidence_reference)) between 4 and 300),
  recorded_by_user_id uuid not null,
  recorded_at timestamptz not null default now()
);
create index if not exists sales_commission_payouts_receipt_idx
  on public.sales_commission_payouts (receipt_id, recorded_at);

create table if not exists public.sales_commission_statement_locks (
  rep_user_id uuid not null,
  week_start date not null check (extract(dow from week_start) = 1),
  snapshot jsonb not null,
  snapshot_sha256 text not null check (snapshot_sha256 ~ '^[a-f0-9]{64}$'),
  locked_by_user_id uuid not null,
  locked_at timestamptz not null default now(),
  primary key (rep_user_id, week_start)
);

-- An approved ledger row is never edited or deleted. Corrections are new, linked rows.
create or replace function public.reject_sales_commission_ledger_mutation()
returns trigger language plpgsql as $$
begin
  raise exception 'sales_commission_ledger_is_append_only';
end;
$$;
create trigger sales_commission_receipts_immutable before update or delete on public.sales_commission_receipts
  for each row execute function public.reject_sales_commission_ledger_mutation();
create trigger sales_commission_adjustments_immutable before update or delete on public.sales_commission_adjustments
  for each row execute function public.reject_sales_commission_ledger_mutation();
create trigger sales_commission_payouts_immutable before update or delete on public.sales_commission_payouts
  for each row execute function public.reject_sales_commission_ledger_mutation();
create trigger sales_commission_statement_locks_immutable before update or delete on public.sales_commission_statement_locks
  for each row execute function public.reject_sales_commission_ledger_mutation();
create trigger sales_commission_departures_immutable before update or delete on public.sales_commission_departures
  for each row execute function public.reject_sales_commission_ledger_mutation();

create or replace function public.check_sales_commission_departure_cutoff()
returns trigger language plpgsql as $$
declare
  final_day_recorded date;
  cutoff_exclusive timestamptz;
begin
  if tg_table_name = 'sales_commission_departures' then
    cutoff_exclusive := (new.final_day + 31)::timestamp at time zone 'America/Denver';
    if exists (
      select 1 from public.sales_commission_receipts r
      where r.rep_user_id = new.rep_user_id and
        (r.payment_success_at >= cutoff_exclusive or r.qualification_closed_at >= cutoff_exclusive)
    ) then
      raise exception 'existing_receipt_exceeds_departure_cutoff';
    end if;
  else
    select d.final_day into final_day_recorded from public.sales_commission_departures d
      where d.rep_user_id = new.rep_user_id;
    if final_day_recorded is distinct from new.rep_final_day then
      raise exception 'receipt_departure_snapshot_mismatch';
    end if;
    if final_day_recorded is not null then
      cutoff_exclusive := (final_day_recorded + 31)::timestamp at time zone 'America/Denver';
      if new.payment_success_at >= cutoff_exclusive or new.qualification_closed_at >= cutoff_exclusive then
        raise exception 'receipt_exceeds_departure_cutoff';
      end if;
    end if;
  end if;
  return new;
end;
$$;
create trigger sales_commission_departure_cutoff_guard before insert on public.sales_commission_departures
  for each row execute function public.check_sales_commission_departure_cutoff();
create trigger sales_commission_receipt_cutoff_guard before insert on public.sales_commission_receipts
  for each row execute function public.check_sales_commission_departure_cutoff();

-- Serialize all changes for one source receipt and enforce that no receipt is over-reversed
-- or over-paid. A post-departure reversal cannot reclaim money already paid.
create or replace function public.check_sales_commission_receipt_balance()
returns trigger language plpgsql as $$
declare
  original_cents bigint;
  adjusted_cents bigint;
  paid_cents bigint;
  previous_net_delta_cents bigint;
  expected_commission_delta_cents bigint;
  previous_commission_delta_cents bigint;
  departed boolean;
  rep_id uuid;
  receipt_week date;
begin
  select r.commission_cents, r.rep_user_id, r.statement_week_start
    into original_cents, rep_id, receipt_week
    from public.sales_commission_receipts r where r.id = new.receipt_id for update;
  if original_cents is null then raise exception 'unknown_commission_receipt'; end if;
  perform 1 from public.sales_reps where user_id = rep_id for update;
  select coalesce(sum(commission_delta_cents), 0) into adjusted_cents
    from public.sales_commission_adjustments where receipt_id = new.receipt_id;
  select coalesce(sum(amount_cents), 0) into paid_cents
    from public.sales_commission_payouts where receipt_id = new.receipt_id;
  if tg_table_name = 'sales_commission_adjustments' then
    select exists (
      select 1 from public.sales_commission_departures d
      where d.rep_user_id = rep_id and d.final_day < (new.effective_at at time zone 'America/Denver')::date
    ) into departed;
    select coalesce(sum(net_membership_delta_cents), 0) into previous_net_delta_cents
      from public.sales_commission_adjustments where receipt_id = new.receipt_id;
    previous_commission_delta_cents :=
      (case when previous_net_delta_cents < 0 then -1 else 1 end) *
      ((abs(previous_net_delta_cents) + 1) / 2);
    previous_net_delta_cents := previous_net_delta_cents + new.net_membership_delta_cents;
    expected_commission_delta_cents :=
      (case when previous_net_delta_cents < 0 then -1 else 1 end) *
      ((abs(previous_net_delta_cents) + 1) / 2);
    new.commission_delta_cents := expected_commission_delta_cents - previous_commission_delta_cents;
    adjusted_cents := adjusted_cents + new.commission_delta_cents;
    if new.adjustment_type in ('refund', 'chargeback') and departed and
       original_cents + adjusted_cents < paid_cents then
      raise exception 'post_departure_reversal_exceeds_unpaid_source';
    end if;
  else
    if not exists (select 1 from public.sales_commission_statement_locks
                   where rep_user_id = rep_id and week_start = receipt_week) then
      raise exception 'source_statement_not_locked';
    end if;
    if exists (
      select 1 from public.sales_commission_adjustments a
      where a.receipt_id = new.receipt_id and not exists (
        select 1 from public.sales_commission_statement_locks l
        where l.rep_user_id = rep_id and l.week_start = a.statement_week_start
      )
    ) then
      raise exception 'adjustment_statement_not_locked';
    end if;
    if (new.paid_at at time zone 'America/Denver')::date < receipt_week + 8 then
      raise exception 'ach_before_following_tuesday';
    end if;
    paid_cents := paid_cents + new.amount_cents;
  end if;
  if adjusted_cents > 0 or adjusted_cents < -original_cents then
    raise exception 'commission_adjustments_outside_source_balance';
  end if;
  if tg_table_name = 'sales_commission_payouts' and paid_cents > original_cents + adjusted_cents then
    raise exception 'commission_payout_exceeds_unpaid_verified_source';
  end if;
  if tg_table_name = 'sales_commission_payouts' and exists (
    select 1 from public.sales_commission_receipts other
    where other.rep_user_id = rep_id and other.id <> new.receipt_id and
      other.commission_cents +
      coalesce((select sum(a.commission_delta_cents) from public.sales_commission_adjustments a where a.receipt_id = other.id), 0) -
      coalesce((select sum(p.amount_cents) from public.sales_commission_payouts p where p.receipt_id = other.id), 0) < 0
  ) then
    raise exception 'representative_has_unrecovered_commission_debit';
  end if;
  return new;
end;
$$;
create trigger sales_commission_adjustment_balance before insert on public.sales_commission_adjustments
  for each row execute function public.check_sales_commission_receipt_balance();
create trigger sales_commission_payout_balance before insert on public.sales_commission_payouts
  for each row execute function public.check_sales_commission_receipt_balance();

create or replace function public.check_sales_commission_week_unlocked()
returns trigger language plpgsql as $$
declare
  rep_id uuid;
begin
  if tg_table_name = 'sales_commission_receipts' then
    rep_id := new.rep_user_id;
  else
    select rep_user_id into rep_id from public.sales_commission_receipts where id = new.receipt_id;
  end if;
  perform pg_advisory_xact_lock(hashtextextended(rep_id::text || ':' || new.statement_week_start::text, 0));
  if exists (select 1 from public.sales_commission_statement_locks
             where rep_user_id = rep_id and week_start = new.statement_week_start) then
    raise exception 'sales_commission_statement_week_locked';
  end if;
  return new;
end;
$$;
create trigger sales_commission_receipt_week_guard before insert on public.sales_commission_receipts
  for each row execute function public.check_sales_commission_week_unlocked();
create trigger sales_commission_adjustment_week_guard before insert on public.sales_commission_adjustments
  for each row execute function public.check_sales_commission_week_unlocked();

create or replace function public.lock_sales_commission_statement(
  p_rep_user_id uuid, p_week_start date, p_locked_by_user_id uuid
)
returns public.sales_commission_statement_locks language plpgsql as $$
declare
  receipt_items jsonb;
  adjustment_items jsonb;
  statement_snapshot jsonb;
  locked_row public.sales_commission_statement_locks;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_rep_user_id::text || ':' || p_week_start::text, 0));
  if exists (select 1 from public.sales_commission_statement_locks
             where rep_user_id = p_rep_user_id and week_start = p_week_start) then
    raise exception 'sales_commission_statement_week_locked';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('id', id, 'commission_cents', commission_cents)
                            order by id), '[]'::jsonb)
    into receipt_items from public.sales_commission_receipts
    where rep_user_id = p_rep_user_id and statement_week_start = p_week_start;
  select coalesce(jsonb_agg(jsonb_build_object('id', a.id, 'receipt_id', a.receipt_id,
                                              'commission_delta_cents', a.commission_delta_cents)
                            order by a.id), '[]'::jsonb)
    into adjustment_items from public.sales_commission_adjustments a
    join public.sales_commission_receipts r on r.id = a.receipt_id
    where r.rep_user_id = p_rep_user_id and a.statement_week_start = p_week_start;
  statement_snapshot := jsonb_build_object('receipts', receipt_items, 'adjustments', adjustment_items);
  if jsonb_array_length(receipt_items) = 0 and jsonb_array_length(adjustment_items) = 0 then
    raise exception 'empty_commission_statement';
  end if;
  insert into public.sales_commission_statement_locks
    (rep_user_id, week_start, snapshot, snapshot_sha256, locked_by_user_id)
  values
    (p_rep_user_id, p_week_start, statement_snapshot,
     encode(sha256(convert_to(statement_snapshot::text, 'UTF8')), 'hex'), p_locked_by_user_id)
  returning * into locked_row;
  return locked_row;
end;
$$;

alter table public.sales_commission_departures enable row level security;
alter table public.sales_commission_receipts enable row level security;
alter table public.sales_commission_adjustments enable row level security;
alter table public.sales_commission_payouts enable row level security;
alter table public.sales_commission_statement_locks enable row level security;
revoke all on public.sales_commission_departures from anon, authenticated;
revoke all on public.sales_commission_receipts from anon, authenticated;
revoke all on public.sales_commission_adjustments from anon, authenticated;
revoke all on public.sales_commission_payouts from anon, authenticated;
revoke all on public.sales_commission_statement_locks from anon, authenticated;
grant all on public.sales_commission_departures to service_role;
grant all on public.sales_commission_receipts to service_role;
grant all on public.sales_commission_adjustments to service_role;
grant all on public.sales_commission_payouts to service_role;
grant all on public.sales_commission_statement_locks to service_role;
revoke all on function public.reject_sales_commission_ledger_mutation() from public, anon, authenticated;
revoke all on function public.check_sales_commission_receipt_balance() from public, anon, authenticated;
revoke all on function public.check_sales_commission_week_unlocked() from public, anon, authenticated;
revoke all on function public.check_sales_commission_departure_cutoff() from public, anon, authenticated;
revoke all on function public.lock_sales_commission_statement(uuid, date, uuid) from public, anon, authenticated;
grant execute on function public.lock_sales_commission_statement(uuid, date, uuid) to service_role;
