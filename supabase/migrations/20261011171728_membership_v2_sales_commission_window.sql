-- Prospective retail commission eligibility only. No legacy row rewrite,
-- commission automation, provider verification, funds transfer or API enablement.
-- Reviewed manual receipts still require evidence and all existing ledger locks,
-- departure, net-fee, adjustment and payout guards. A future API must obtain these
-- links from trusted server reads, never a browser-supplied policy/window.
begin;

create table public.membership_v2_sales_qualifications (
  contract_id uuid primary key,
  contract_version integer not null,
  purchase_intent_id uuid not null unique references public.public_purchase_intents(id) on delete restrict,
  rep_user_id uuid not null references auth.users(id) on delete restrict,
  original_start_at timestamptz not null check (isfinite(original_start_at)),
  original_term_end_at timestamptz not null check (isfinite(original_term_end_at)),
  commission_window_end_at timestamptz not null check (isfinite(commission_window_end_at)),
  qualification_closed_at timestamptz not null check (isfinite(qualification_closed_at)),
  reviewed_by_user_id uuid not null references auth.users(id) on delete restrict,
  evidence_reference text not null check (length(trim(evidence_reference)) between 4 and 300),
  reviewed_at timestamptz not null default clock_timestamp(),
  foreign key(contract_id,contract_version) references public.membership_v2_contracts(id,contract_version) on delete restrict,
  foreign key(contract_id) references public.membership_v2_initial_receipts(contract_id) on delete restrict,
  unique(contract_id,contract_version,purchase_intent_id,rep_user_id),
  check (qualification_closed_at >= original_start_at and qualification_closed_at < original_term_end_at),
  check (original_term_end_at > original_start_at and commission_window_end_at >= original_term_end_at)
);

create function public.membership_v2_check_sales_qualification()
returns trigger language plpgsql security invoker set search_path = pg_catalog, public as $$
declare
  v_contract public.membership_v2_contracts;
  v_receipt public.membership_v2_initial_receipts;
  v_intent public.public_purchase_intents;
  v_agreement public.membership_agreements;
  v_close timestamptz;
begin
  select * into v_contract from public.membership_v2_contracts where id = new.contract_id;
  select * into v_receipt from public.membership_v2_initial_receipts where contract_id = new.contract_id;
  select * into v_intent from public.public_purchase_intents where id = new.purchase_intent_id;
  select * into v_agreement from public.membership_agreements where id = v_intent.agreement_id;
  if v_contract.id is null or v_receipt.contract_id is null or v_intent.id is null
    or new.contract_version is distinct from v_contract.contract_version
    or v_receipt.contract_version is distinct from v_contract.contract_version
    or new.rep_user_id is distinct from v_contract.original_salesperson_user_id
    or new.rep_user_id is distinct from v_intent.created_by_user_id
    or v_intent.client_id is distinct from v_contract.client_id
    or (v_contract.purchase_intent_id is not null and v_contract.purchase_intent_id <> v_intent.id)
    or (v_contract.agreement_id is not null and v_contract.agreement_id is distinct from v_intent.agreement_id)
    or v_intent.channel is distinct from 'sales_assisted' or v_intent.status is distinct from 'completed'
    or v_intent.activated_at is null or not isfinite(v_intent.activated_at)
    or v_agreement.id is null or v_agreement.client_id is distinct from v_contract.client_id
    or v_agreement.status is distinct from 'signed' or v_agreement.checkout_status is distinct from 'paid'
    or v_agreement.signed_at is null or not isfinite(v_agreement.signed_at)
    or v_agreement.signed_at > v_receipt.paid_at
    or v_agreement.checkout_paid_at is distinct from v_receipt.paid_at
    or not exists (select 1 from public.clients c where c.id = v_contract.client_id
      and c.billing_status = 'active'
      and coalesce(nullif(lower(btrim(c.subscription_status)),''),'active') in ('active','trialing'))
    or not exists (select 1 from public.sales_reps r where r.user_id = new.rep_user_id) then
    raise exception using message = 'membership_sales_qualification_source_conflict', errcode = '23000';
  end if;
  v_close := greatest(v_agreement.signed_at,v_receipt.paid_at,v_intent.activated_at);
  if new.original_start_at is distinct from v_receipt.paid_at
    or new.original_term_end_at is distinct from public.membership_v2_month_anchor(v_receipt.paid_at,
      (v_contract.offer_snapshot->>'commitment_months')::integer)
    or new.commission_window_end_at is distinct from public.membership_v2_month_anchor(v_receipt.paid_at,12)
    or new.qualification_closed_at is distinct from v_close
    or v_close > clock_timestamp() then
    raise exception using message = 'membership_sales_qualification_window_conflict', errcode = '23000';
  end if;
  return new;
end $$;

create trigger membership_v2_sales_qualification_source before insert on public.membership_v2_sales_qualifications
  for each row execute function public.membership_v2_check_sales_qualification();
create trigger membership_v2_sales_qualification_immutable before update or delete on public.membership_v2_sales_qualifications
  for each row execute function public.membership_v2_reject_mutation();
alter table public.membership_v2_sales_qualifications enable row level security;
revoke all on public.membership_v2_sales_qualifications from public, anon, authenticated, service_role;
grant select, insert, references on public.membership_v2_sales_qualifications to service_role;
revoke all on function public.membership_v2_check_sales_qualification() from public, anon, authenticated;
grant execute on function public.membership_v2_check_sales_qualification() to service_role;

alter table public.sales_commission_receipts
  add column membership_terms_protocol text not null default 'legacy_receipt_v1',
  add column membership_contract_id uuid,
  add column membership_contract_version integer;

-- The older migration did not name this CHECK. Locate exactly its expression,
-- failing closed on an unexpected schema instead of dropping unrelated checks.
do $$
declare v_names text[];
begin
  select array_agg(conname) into v_names from pg_constraint
    where conrelid = 'public.sales_commission_receipts'::regclass and contype = 'c'
      and regexp_replace(pg_get_expr(conbin,conrelid),'[[:space:]()]','','g') = 'payment_success_at<first_term_end_at';
  if coalesce(array_length(v_names,1),0) <> 1 then
    raise exception 'unexpected_legacy_commission_payment_window_constraint';
  end if;
  execute format('alter table public.sales_commission_receipts drop constraint %I',v_names[1]);
end $$;

alter table public.sales_commission_receipts
  add constraint sales_commission_receipts_protocol_shape check (
    (membership_terms_protocol = 'legacy_receipt_v1' and membership_contract_id is null and membership_contract_version is null)
    or (membership_terms_protocol = 'retail_terms_v2' and membership_contract_id is not null
      and membership_contract_version is not null and membership_contract_version > 0
      and policy_version = 'retail-terms-v2-commission-v1' and provider = 'stripe')),
  add constraint sales_commission_receipts_versioned_payment_window check (
    (membership_terms_protocol = 'legacy_receipt_v1' and payment_success_at < first_term_end_at)
    or (membership_terms_protocol = 'retail_terms_v2' and isfinite(payment_success_at)
      and isfinite(funds_received_at) and payment_success_at >= first_term_start_at
      and payment_success_at < public.membership_v2_month_anchor(first_term_start_at,12))),
  add constraint sales_commission_receipts_membership_qualification_fk
    foreign key(membership_contract_id,membership_contract_version,purchase_intent_id,rep_user_id)
      references public.membership_v2_sales_qualifications(contract_id,contract_version,purchase_intent_id,rep_user_id)
      on delete restrict;

create function public.membership_v2_check_commission_receipt()
returns trigger language plpgsql security invoker set search_path = pg_catalog, public as $$
declare v_qualification public.membership_v2_sales_qualifications; v_offer jsonb;
begin
  if new.membership_terms_protocol = 'legacy_receipt_v1' then
    -- A prospective sale cannot sidestep its fixed window by masquerading as a
    -- legacy receipt with browser-selected term dates, even before qualification.
    if exists (select 1 from public.membership_v2_contracts c
      join public.public_purchase_intents i on i.id = new.purchase_intent_id
      where c.purchase_intent_id = i.id or c.agreement_id = i.agreement_id) then
      raise exception using message = 'membership_commission_protocol_required', errcode = '23000';
    end if;
    return new;
  end if;
  if new.membership_terms_protocol is distinct from 'retail_terms_v2' then
    raise exception using message = 'unsupported_membership_commission_protocol', errcode = '23000';
  end if;
  select * into v_qualification from public.membership_v2_sales_qualifications
    where contract_id = new.membership_contract_id;
  select offer_snapshot into v_offer from public.membership_v2_contracts where id = new.membership_contract_id;
  if v_qualification.contract_id is null
    or new.membership_contract_version is distinct from v_qualification.contract_version
    or new.purchase_intent_id is distinct from v_qualification.purchase_intent_id
    or new.rep_user_id is distinct from v_qualification.rep_user_id
    or new.first_term_start_at is distinct from v_qualification.original_start_at
    or new.first_term_end_at is distinct from v_qualification.original_term_end_at
    or new.qualification_closed_at is distinct from v_qualification.qualification_closed_at
    or new.payment_success_at < v_qualification.original_start_at
    or new.payment_success_at >= v_qualification.commission_window_end_at
    or new.payment_success_at > clock_timestamp() or new.funds_received_at > clock_timestamp()
    or new.gross_membership_cents > (v_offer->>'platform_payment_cents')::bigint
    or new.payment_kind is distinct from (case when v_offer->>'payment_option' = 'prepaid'
      then 'paid_in_full' else 'monthly' end) then
    raise exception using message = 'membership_commission_receipt_snapshot_conflict', errcode = '23000';
  end if;
  return new;
end $$;
create trigger membership_v2_commission_receipt_snapshot before insert on public.sales_commission_receipts
  for each row execute function public.membership_v2_check_commission_receipt();
revoke all on function public.membership_v2_check_commission_receipt() from public, anon, authenticated;
grant execute on function public.membership_v2_check_commission_receipt() to service_role;

-- V2 attribution is frozen at the original verified sale, not reset by renewal
-- metadata or a later reassignment. Legacy attribution checks remain unchanged.
create or replace function public.require_sales_commission_sales_assisted()
returns trigger language plpgsql security invoker set search_path = '' as $$
declare v_receipt public.sales_commission_receipts; intent_id uuid; representative_id uuid;
begin
  if tg_table_name = 'sales_commission_receipts' then
    v_receipt := new;
  else
    select * into v_receipt from public.sales_commission_receipts where id = new.receipt_id;
  end if;
  if v_receipt.membership_terms_protocol = 'retail_terms_v2' then
    if not exists (select 1 from public.membership_v2_sales_qualifications q
      where q.contract_id = v_receipt.membership_contract_id
        and q.contract_version = v_receipt.membership_contract_version
        and q.purchase_intent_id = v_receipt.purchase_intent_id and q.rep_user_id = v_receipt.rep_user_id) then
      raise exception 'commission_sale_not_sales_assisted';
    end if;
    return new;
  end if;
  intent_id := v_receipt.purchase_intent_id; representative_id := v_receipt.rep_user_id;
  if intent_id is null or not exists (select 1 from public.public_purchase_intents i
    where i.id = intent_id and i.channel = 'sales_assisted' and i.status = 'completed'
      and i.created_by_user_id = representative_id) then
    raise exception 'commission_sale_not_sales_assisted';
  end if;
  return new;
end $$;
revoke all on function public.require_sales_commission_sales_assisted() from public, anon, authenticated;
grant execute on function public.require_sales_commission_sales_assisted() to service_role;
commit;
