-- Mercury CSV is an evidence source, never a payment initiation rail.
-- The ACH trace is scoped to the source account and UTC value date because it is
-- not Mercury's API transaction UUID and may recur on a later processing date.
create table public.sales_commission_bank_transactions (
  id uuid primary key default gen_random_uuid(),
  provider text not null default 'mercury' check (provider = 'mercury'),
  source_account_fingerprint text not null check (source_account_fingerprint ~ '^[a-f0-9]{64}$'),
  ach_trace text not null check (ach_trace ~ '^[0-9]{15}$'),
  value_date date not null,
  paid_at timestamptz not null,
  amount_cents bigint not null check (amount_cents > 0),
  rep_user_id uuid not null references public.sales_reps(user_id) on delete restrict,
  counterparty_label text not null check (length(counterparty_label) between 1 and 120),
  source text not null default 'csv' check (source in ('csv', 'api')),
  attestation text not null check (length(attestation) between 20 and 300),
  imported_by_user_id uuid not null,
  imported_at timestamptz not null default now(),
  unique (source_account_fingerprint, ach_trace, value_date),
  check ((paid_at at time zone 'UTC')::date = value_date)
);
create index sales_commission_bank_transactions_rep_idx
  on public.sales_commission_bank_transactions (rep_user_id, paid_at desc);

alter table public.sales_commission_payouts
  add column bank_transaction_id uuid references public.sales_commission_bank_transactions(id) on delete restrict;
create unique index sales_commission_payout_bank_receipt_uniq
  on public.sales_commission_payouts (bank_transaction_id, receipt_id)
  where bank_transaction_id is not null;
create index sales_commission_payout_bank_idx
  on public.sales_commission_payouts (bank_transaction_id)
  where bank_transaction_id is not null;

create table public.sales_commission_bank_reversals (
  bank_transaction_id uuid primary key references public.sales_commission_bank_transactions(id) on delete restrict,
  observed_at timestamptz not null,
  evidence_reference text not null check (length(trim(evidence_reference)) between 4 and 300),
  recorded_by_user_id uuid not null,
  recorded_at timestamptz not null default now()
);

-- Reserved for a later read-only Mercury adapter. Ambiguous API matches must
-- remain unbound; binding never inserts another payout.
create table public.sales_commission_bank_api_bindings (
  bank_transaction_id uuid primary key references public.sales_commission_bank_transactions(id) on delete restrict,
  mercury_transaction_id uuid not null unique,
  bound_at timestamptz not null default now(),
  bound_by_user_id uuid not null
);

create trigger sales_commission_bank_transactions_immutable before update or delete on public.sales_commission_bank_transactions
  for each row execute function public.reject_sales_commission_ledger_mutation();
create trigger sales_commission_bank_reversals_immutable before update or delete on public.sales_commission_bank_reversals
  for each row execute function public.reject_sales_commission_ledger_mutation();
create trigger sales_commission_bank_api_bindings_immutable before update or delete on public.sales_commission_bank_api_bindings
  for each row execute function public.reject_sales_commission_ledger_mutation();

-- Reversed bank transfers remain in the audit trail but no longer count as paid.
create or replace function public.sales_commission_effective_paid(p_receipt_id uuid)
returns bigint language sql stable set search_path = '' as $$
  select coalesce(sum(p.amount_cents), 0)::bigint
  from public.sales_commission_payouts p
  where p.receipt_id = p_receipt_id and (
    p.bank_transaction_id is null or not exists (
      select 1 from public.sales_commission_bank_reversals rev
      where rev.bank_transaction_id = p.bank_transaction_id
    )
  );
$$;

create or replace function public.check_sales_commission_receipt_balance()
returns trigger language plpgsql set search_path = '' as $$
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
  paid_cents := public.sales_commission_effective_paid(new.receipt_id);
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
      public.sales_commission_effective_paid(other.id) < 0
  ) then
    raise exception 'representative_has_unrecovered_commission_debit';
  end if;
  return new;
end;
$$;

create or replace function public.import_sales_commission_bank_transaction(
  p_source_account_fingerprint text, p_ach_trace text, p_value_date date,
  p_paid_at timestamptz, p_amount_cents bigint, p_rep_user_id uuid,
  p_counterparty_label text, p_attestation text, p_imported_by_user_id uuid,
  p_allocations jsonb
) returns public.sales_commission_bank_transactions
language plpgsql security definer set search_path = '' as $$
declare
  existing public.sales_commission_bank_transactions;
  imported public.sales_commission_bank_transactions;
  item record;
  item_count integer;
  total_cents bigint;
begin
  if p_source_account_fingerprint !~ '^[a-f0-9]{64}$' or p_ach_trace !~ '^[0-9]{15}$'
     or p_value_date is null or p_paid_at is null or p_amount_cents is null or p_amount_cents <= 0
     or p_rep_user_id is null or p_imported_by_user_id is null
     or p_paid_at > now() or (p_paid_at at time zone 'UTC')::date <> p_value_date
     or length(p_counterparty_label) not between 1 and 120
     or length(p_attestation) not between 20 and 300
     or jsonb_typeof(p_allocations) <> 'array' then
    raise exception 'invalid_bank_import';
  end if;
  item_count := jsonb_array_length(p_allocations);
  if item_count < 1 or item_count > 50 then raise exception 'invalid_bank_allocations'; end if;
  if exists (select 1 from jsonb_array_elements(p_allocations) j
             where jsonb_typeof(j) <> 'object' or j ? 'receipt_id' is false or j ? 'amount_cents' is false) then
    raise exception 'invalid_bank_allocations';
  end if;
  select count(distinct a.receipt_id), sum(a.amount_cents)
    into item_count, total_cents
    from jsonb_to_recordset(p_allocations) as a(receipt_id uuid, amount_cents bigint);
  if item_count <> jsonb_array_length(p_allocations) or total_cents <> p_amount_cents or
     exists (select 1 from jsonb_to_recordset(p_allocations) as a(receipt_id uuid, amount_cents bigint)
             where a.receipt_id is null or a.amount_cents is null or a.amount_cents <= 0) then
    raise exception 'invalid_bank_allocations';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('mercury:' || p_source_account_fingerprint || ':' || p_ach_trace || ':' || p_value_date::text, 0));
  select * into existing from public.sales_commission_bank_transactions
    where source_account_fingerprint = p_source_account_fingerprint and ach_trace = p_ach_trace and value_date = p_value_date;
  if existing.id is not null then
    if existing.paid_at <> p_paid_at or existing.amount_cents <> p_amount_cents or existing.rep_user_id <> p_rep_user_id or
       exists (select 1 from public.sales_commission_bank_reversals where bank_transaction_id = existing.id) or
       (select count(*) from public.sales_commission_payouts where bank_transaction_id = existing.id) <> item_count or
       exists (
         select 1 from jsonb_to_recordset(p_allocations) as a(receipt_id uuid, amount_cents bigint)
         left join public.sales_commission_payouts p on p.bank_transaction_id = existing.id and p.receipt_id = a.receipt_id
         where p.amount_cents is distinct from a.amount_cents
       ) then raise exception 'bank_import_collision'; end if;
    return existing;
  end if;
  perform 1 from public.sales_reps where user_id = p_rep_user_id for update;
  if not found then raise exception 'unknown_representative'; end if;
  -- Lock receipts in stable order, then use the existing payout trigger for all
  -- statement and balance rules. Any failure rolls back every row in this call.
  for item in select a.receipt_id, a.amount_cents
              from jsonb_to_recordset(p_allocations) as a(receipt_id uuid, amount_cents bigint)
              order by a.receipt_id loop
    perform 1 from public.sales_commission_receipts r where r.id = item.receipt_id and r.rep_user_id = p_rep_user_id for update;
    if not found then raise exception 'bank_allocation_rep_mismatch'; end if;
  end loop;
  insert into public.sales_commission_bank_transactions
    (source_account_fingerprint, ach_trace, value_date, paid_at, amount_cents, rep_user_id,
     counterparty_label, attestation, imported_by_user_id)
  values (p_source_account_fingerprint, p_ach_trace, p_value_date, p_paid_at, p_amount_cents,
          p_rep_user_id, p_counterparty_label, p_attestation, p_imported_by_user_id)
  returning * into imported;
  for item in select a.receipt_id, a.amount_cents
              from jsonb_to_recordset(p_allocations) as a(receipt_id uuid, amount_cents bigint)
              order by a.receipt_id loop
    insert into public.sales_commission_payouts
      (receipt_id, amount_cents, ach_reference, paid_at, evidence_reference, recorded_by_user_id, bank_transaction_id)
    values (item.receipt_id, item.amount_cents, 'mercury:' || imported.id::text || ':' || item.receipt_id::text,
            p_paid_at, 'Mercury ACH trace ' || p_ach_trace, p_imported_by_user_id, imported.id);
  end loop;
  return imported;
end;
$$;

create or replace function public.reverse_sales_commission_bank_transaction(
  p_bank_transaction_id uuid, p_observed_at timestamptz, p_evidence_reference text, p_recorded_by_user_id uuid
) returns public.sales_commission_bank_reversals
language plpgsql security definer set search_path = '' as $$
declare reversed public.sales_commission_bank_reversals;
begin
  if p_observed_at is null or p_observed_at > now() or length(trim(p_evidence_reference)) not between 4 and 300
     or p_recorded_by_user_id is null then raise exception 'invalid_bank_reversal'; end if;
  perform 1 from public.sales_commission_bank_transactions where id = p_bank_transaction_id for update;
  if not found then raise exception 'unknown_bank_transaction'; end if;
  insert into public.sales_commission_bank_reversals
    (bank_transaction_id, observed_at, evidence_reference, recorded_by_user_id)
  values (p_bank_transaction_id, p_observed_at, p_evidence_reference, p_recorded_by_user_id)
  returning * into reversed;
  return reversed;
end;
$$;

create or replace view public.sales_commission_payment_rows
with (security_invoker = true) as
select r.id as receipt_id, r.purchase_intent_id, r.rep_user_id, r.provider_payment_id,
       r.payment_kind, r.net_membership_cents, r.commission_cents,
       r.statement_week_start, r.reviewed_at,
       coalesce(a.adjustment_cents, 0)::bigint as adjustment_cents,
       coalesce(p.paid_cents, 0)::bigint as paid_cents,
       (r.commission_cents + coalesce(a.adjustment_cents, 0) - coalesce(p.paid_cents, 0))::bigint as outstanding_cents,
       coalesce(p.paid_dates, array[]::timestamptz[]) as paid_dates
from public.sales_commission_receipts r
left join lateral (
  select sum(commission_delta_cents) as adjustment_cents
  from public.sales_commission_adjustments where receipt_id = r.id
) a on true
left join lateral (
  select sum(p.amount_cents) as paid_cents, array_agg(p.paid_at order by p.paid_at) as paid_dates
  from public.sales_commission_payouts p
  where p.receipt_id = r.id and (p.bank_transaction_id is null or not exists (
    select 1 from public.sales_commission_bank_reversals rev where rev.bank_transaction_id = p.bank_transaction_id
  ))
) p on true;
create or replace view public.sales_commission_payment_summary
with (security_invoker = true) as
select rep.user_id as rep_user_id, rep.display_name, rep.email,
       count(row.receipt_id)::bigint as receipt_count,
       coalesce(sum(row.net_membership_cents), 0)::bigint as net_membership_cents,
       coalesce(sum(row.adjustment_cents), 0)::bigint as adjustment_cents,
       coalesce(sum(row.commission_cents + row.adjustment_cents), 0)::bigint as earned_cents,
       coalesce(sum(row.paid_cents), 0)::bigint as paid_cents,
       coalesce(sum(row.outstanding_cents), 0)::bigint as outstanding_cents
from public.sales_reps rep
left join public.sales_commission_payment_rows row on row.rep_user_id = rep.user_id
group by rep.user_id, rep.display_name, rep.email;
revoke all on public.sales_commission_payment_rows, public.sales_commission_payment_summary from public, anon, authenticated;
grant select on public.sales_commission_payment_rows, public.sales_commission_payment_summary to service_role;

alter table public.sales_commission_bank_transactions enable row level security;
alter table public.sales_commission_bank_reversals enable row level security;
alter table public.sales_commission_bank_api_bindings enable row level security;
revoke all on public.sales_commission_bank_transactions, public.sales_commission_bank_reversals,
  public.sales_commission_bank_api_bindings from public, anon, authenticated;
grant select on public.sales_commission_bank_transactions, public.sales_commission_bank_reversals,
  public.sales_commission_bank_api_bindings to service_role;
revoke all on function public.import_sales_commission_bank_transaction(text, text, date, timestamptz, bigint, uuid, text, text, uuid, jsonb)
  from public, anon, authenticated;
revoke all on function public.reverse_sales_commission_bank_transaction(uuid, timestamptz, text, uuid)
  from public, anon, authenticated;
revoke all on function public.sales_commission_effective_paid(uuid) from public, anon, authenticated;
grant execute on function public.import_sales_commission_bank_transaction(text, text, date, timestamptz, bigint, uuid, text, text, uuid, jsonb) to service_role;
grant execute on function public.reverse_sales_commission_bank_transaction(uuid, timestamptz, text, uuid) to service_role;
grant execute on function public.sales_commission_effective_paid(uuid) to service_role;
