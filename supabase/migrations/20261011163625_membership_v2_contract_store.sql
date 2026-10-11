-- Prospective retail terms only. No legacy backfill, client activation, provider
-- mutation, scheduler, email or browser billing privileges in this migration.
-- The authenticated server must authorize billing-owner scope and prove the
-- Stripe object graph before using the service-only persistence transaction.
begin;

create or replace function public.membership_v2_month_anchor(p_anchor timestamptz, p_months integer)
returns timestamptz language plpgsql immutable strict security invoker
set search_path = pg_catalog, public as $$
declare v_anchor timestamp := p_anchor at time zone 'UTC'; v_month timestamp; v_day integer; v_result timestamp;
begin
  if p_months < 0 or p_months > 12000 or not isfinite(p_anchor)
    or extract(year from v_anchor) not between 1 and 9999 then
    raise exception using message = 'invalid_membership_anchor', errcode = '22023';
  end if;
  v_month := date_trunc('month', v_anchor) + make_interval(months => p_months);
  v_day := least(extract(day from v_anchor)::integer,
    extract(day from v_month + interval '1 month - 1 day')::integer);
  v_result := v_month + make_interval(days => v_day - 1) + (v_anchor - date_trunc('day', v_anchor));
  if extract(year from v_result) not between 1 and 9999 then
    raise exception using message = 'invalid_membership_anchor', errcode = '22023';
  end if;
  return v_result at time zone 'UTC';
end $$;

-- Validates the accepted version, NOT today's catalog price. A future catalog
-- change must never reprice an accepted snapshot. The quote service owns the
-- full commercial/capacity validation; this storage boundary also checks totals.
create or replace function public.membership_v2_valid_offer(p_offer jsonb)
returns boolean language plpgsql immutable security invoker
set search_path = pg_catalog, public as $$
declare v_months integer; v_count integer; v_payment bigint; v_role bigint; v_initial bigint; v_total bigint;
begin
  if jsonb_typeof(p_offer) is distinct from 'object'
    or p_offer->>'schema_version' is distinct from '2' or jsonb_typeof(p_offer->'schema_version') is distinct from 'number'
    or p_offer->>'currency' is distinct from 'usd'
    or p_offer->>'term_start_basis' is distinct from 'first_payment_success'
    or p_offer->>'contract_timezone' is distinct from 'UTC'
    or coalesce(p_offer->>'plan_key','') not in ('basic','pro')
    or coalesce(length(p_offer->>'offer_version'), 0) not between 1 and 100
    or coalesce(p_offer->>'payment_option','') not in ('prepaid','monthly_installments')
    or p_offer->'renewal'->>'default_auto_renew' is distinct from 'true'
    or p_offer->'renewal'->>'retain_accepted_pricing' is distinct from 'true'
    or p_offer->'renewal'->>'non_renewal_cutoff' is distinct from 'before_term_end'
    or p_offer->'renewal'->>'ends_installments_early' is distinct from 'false'
    or p_offer->'renewal'->>'reminder_days' is distinct from '30'
    or p_offer->'stripe_recurrence'->>'interval' is distinct from 'month' then return false; end if;
  if jsonb_typeof(p_offer->'offer_version') is distinct from 'string'
    or jsonb_typeof(p_offer->'display_name') is distinct from 'string'
    or coalesce(length(p_offer->>'display_name'),0) not between 1 and 100
    or jsonb_typeof(p_offer->'offer_key') is distinct from 'string'
    or coalesce(length(p_offer->>'offer_key'),0) not between 1 and 100
    or jsonb_typeof(p_offer->'renewal'->'default_auto_renew') is distinct from 'boolean'
    or jsonb_typeof(p_offer->'renewal'->'retain_accepted_pricing') is distinct from 'boolean'
    or jsonb_typeof(p_offer->'renewal'->'ends_installments_early') is distinct from 'boolean'
    or jsonb_typeof(p_offer->'renewal'->'reminder_days') is distinct from 'number'
    or jsonb_typeof(p_offer->'renewal'->'commitment_months') is distinct from 'number'
    or p_offer->'first_role_prepay'->>'credit_type' is distinct from 'first_role_prepay'
    or p_offer->'first_role_prepay'->'expires' is distinct from 'false'::jsonb
    or p_offer->'first_role_prepay'->'non_refundable' is distinct from 'true'::jsonb
    or coalesce(p_offer->>'billing_model','') not in ('fixed','rollover') then return false; end if;
  -- Explicit numeric JSON types and lexical integers exclude nulls, fractions,
  -- negative values, JSON strings and unsafe JavaScript cents.
  if exists (select 1 from jsonb_each(jsonb_build_object(
      'months',p_offer->'commitment_months','count',p_offer->'installment_count',
      'payment',p_offer->'platform_payment_cents','total',p_offer->'platform_commitment_total_cents',
      'initial',p_offer->'initial_payment_cents','role',p_offer->'first_role_prepay'->'amount_cents',
      'interval',p_offer->'stripe_recurrence'->'interval_count',
      'role_fee',p_offer->'per_role_fee_cents','extra_fee',p_offer->'additional_interview_fee_cents',
      'included',p_offer->'included_interviews_per_role','minutes',p_offer->'max_interview_minutes',
      'questions',p_offer->'scored_question_count','normal_role',p_offer->'first_role_prepay'->'normal_role_fee_cents')) x
    where jsonb_typeof(x.value) is distinct from 'number' or x.value::text !~ '^[0-9]+$'
      or length(x.value::text) > 16) then return false; end if;
  v_months := (p_offer->>'commitment_months')::integer;
  v_count := (p_offer->>'installment_count')::integer;
  v_payment := (p_offer->>'platform_payment_cents')::bigint;
  v_total := (p_offer->>'platform_commitment_total_cents')::bigint;
  v_initial := (p_offer->>'initial_payment_cents')::bigint;
  v_role := (p_offer->'first_role_prepay'->>'amount_cents')::bigint;
  return coalesce(v_months in (3,6,12) and v_payment > 0 and v_total <= 9007199254740991
    and v_initial <= 9007199254740991 and v_initial = v_payment + v_role
    and v_count = case when p_offer->>'payment_option' = 'prepaid' then 1 else v_months end
    and v_total = v_payment * v_count
    and (p_offer->'stripe_recurrence'->>'interval_count')::integer =
      case when p_offer->>'payment_option' = 'prepaid' then v_months else 1 end
    and (p_offer->>'per_role_fee_cents')::bigint between 1 and 9007199254740991
    and (p_offer->>'additional_interview_fee_cents')::bigint between 1 and 9007199254740991
    and p_offer->'first_role_prepay'->>'normal_role_fee_cents' = p_offer->>'per_role_fee_cents'
    and (p_offer->>'included_interviews_per_role')::integer > 0
    and (p_offer->>'max_interview_minutes')::integer between 5 and 59
    and (p_offer->>'scored_question_count')::integer between 1 and 7
    and ((p_offer->>'billing_model' = 'fixed' and p_offer->'rollover_days' = 'null'::jsonb)
      or (p_offer->>'billing_model' = 'rollover' and jsonb_typeof(p_offer->'rollover_days') = 'number'
        and p_offer->>'rollover_days' ~ '^[0-9]+$' and (p_offer->>'rollover_days')::integer between 1 and 3650))
    and p_offer->'renewal'->>'commitment_months' = v_months::text
    and jsonb_typeof(p_offer->'first_role_prepay'->'selected') = 'boolean'
    and ((p_offer->'first_role_prepay'->>'selected' = 'true' and v_role > 0)
      or (p_offer->'first_role_prepay'->>'selected' = 'false' and v_role = 0)), false);
exception when numeric_value_out_of_range or invalid_text_representation then return false;
end $$;

create table public.membership_v2_contracts (
  id uuid primary key,
  contract_version integer not null check (contract_version > 0),
  client_id uuid not null references public.clients(id) on delete restrict,
  billing_owner_user_id uuid not null references auth.users(id) on delete restrict,
  agreement_id uuid references public.membership_agreements(id) on delete restrict,
  purchase_intent_id uuid references public.public_purchase_intents(id) on delete restrict,
  offer_snapshot jsonb not null check (public.membership_v2_valid_offer(offer_snapshot)),
  acceptance_digest text not null check (acceptance_digest ~ '^[0-9a-f]{64}$'),
  accepted_at timestamptz not null check (isfinite(accepted_at)),
  original_salesperson_user_id uuid references auth.users(id) on delete restrict,
  created_at timestamptz not null default clock_timestamp(),
  check (num_nonnulls(agreement_id,purchase_intent_id) = 1),
  unique (id,contract_version), unique (agreement_id,contract_version), unique (purchase_intent_id,contract_version)
);
create index membership_v2_contracts_client_idx on public.membership_v2_contracts(client_id);

create table public.membership_v2_provider_bindings (
  contract_id uuid primary key,
  contract_version integer not null,
  provider_account_id text not null check (provider_account_id ~ '^acct_[A-Za-z0-9_]+$'),
  livemode boolean not null,
  customer_id text not null check (customer_id ~ '^cus_[A-Za-z0-9_]+$'),
  checkout_session_id text not null check (checkout_session_id ~ '^cs_[A-Za-z0-9_]+$'),
  subscription_id text not null check (subscription_id ~ '^sub_[A-Za-z0-9_]+$'),
  platform_price_id text not null check (platform_price_id ~ '^price_[A-Za-z0-9_]+$'),
  platform_item_id text not null check (platform_item_id ~ '^si_[A-Za-z0-9_]+$'),
  first_role_price_id text check (first_role_price_id ~ '^price_[A-Za-z0-9_]+$'),
  created_at timestamptz not null default clock_timestamp(),
  foreign key (contract_id,contract_version) references public.membership_v2_contracts(id,contract_version) on delete restrict,
  unique(provider_account_id,livemode,checkout_session_id), unique(provider_account_id,livemode,subscription_id)
);

create table public.membership_v2_initial_receipts (
  contract_id uuid primary key,
  contract_version integer not null,
  provider_account_id text not null,
  livemode boolean not null,
  identity jsonb not null check (jsonb_typeof(identity) = 'object'),
  checkout_session_id text not null,
  subscription_id text not null,
  invoice_id text not null check (invoice_id ~ '^in_[A-Za-z0-9_]+$'),
  payment_intent_id text not null check (payment_intent_id ~ '^pi_[A-Za-z0-9_]+$'),
  charge_id text not null check (charge_id ~ '^ch_[A-Za-z0-9_]+$'),
  platform_line_id text not null check (platform_line_id ~ '^il_[A-Za-z0-9_]+$'),
  paid_at timestamptz not null check (isfinite(paid_at)),
  collected_cents bigint not null check (collected_cents between 1 and 9007199254740991),
  platform_cents bigint not null check (platform_cents between 1 and 9007199254740991),
  first_role_cents bigint not null check (first_role_cents between 0 and 9007199254740991),
  tax_cents bigint not null check (tax_cents between 0 and 9007199254740991),
  recorded_at timestamptz not null default clock_timestamp(),
  check (collected_cents = platform_cents + first_role_cents + tax_cents),
  foreign key(contract_id,contract_version) references public.membership_v2_contracts(id,contract_version) on delete restrict,
  unique(provider_account_id,livemode,checkout_session_id), unique(provider_account_id,livemode,subscription_id),
  unique(provider_account_id,livemode,invoice_id), unique(provider_account_id,livemode,payment_intent_id),
  unique(provider_account_id,livemode,charge_id)
);

create table public.membership_v2_contract_state (
  contract_id uuid primary key references public.membership_v2_initial_receipts(contract_id) on delete restrict,
  original_paid_at timestamptz not null,
  term_index integer not null default 0 check (term_index between 0 and 3999),
  term_start_at timestamptz not null,
  term_end_at timestamptz not null check (term_end_at > term_start_at),
  auto_renew boolean not null default true,
  preference_version bigint not null default 1 check (preference_version > 0),
  revision bigint not null default 1 check (revision > 0),
  provider_alignment text not null default 'pending' check (provider_alignment in ('pending','verified','exception')),
  renewal_ready boolean not null default false,
  check (not renewal_ready or provider_alignment = 'verified')
);

create table public.membership_v2_paid_periods (
  contract_id uuid not null references public.membership_v2_initial_receipts(contract_id) on delete restrict,
  period_index integer not null check (period_index between 0 and 11999),
  provider_account_id text not null,
  livemode boolean not null,
  invoice_id text not null,
  platform_line_id text not null,
  starts_at timestamptz not null,
  ends_at timestamptz not null check (ends_at > starts_at),
  platform_cents bigint not null check (platform_cents between 1 and 9007199254740991),
  paid_at timestamptz not null,
  primary key(contract_id,period_index),
  unique(provider_account_id,livemode,invoice_id,platform_line_id)
);

create or replace function public.membership_v2_reject_mutation()
returns trigger language plpgsql security invoker set search_path = pg_catalog, public as $$
begin
  raise exception using message = 'immutable_membership_record', errcode = '23000';
end $$;

create trigger membership_v2_contracts_immutable before update or delete on public.membership_v2_contracts
  for each row execute function public.membership_v2_reject_mutation();
create trigger membership_v2_bindings_immutable before update or delete on public.membership_v2_provider_bindings
  for each row execute function public.membership_v2_reject_mutation();
create trigger membership_v2_receipts_immutable before update or delete on public.membership_v2_initial_receipts
  for each row execute function public.membership_v2_reject_mutation();
create trigger membership_v2_periods_immutable before update or delete on public.membership_v2_paid_periods
  for each row execute function public.membership_v2_reject_mutation();

-- Existing source ownership cannot be overwritten by this new protocol.
create or replace function public.membership_v2_check_contract_source()
returns trigger language plpgsql security invoker set search_path = pg_catalog, public as $$
declare v_client uuid;
begin
  if new.agreement_id is not null then
    select client_id into v_client from public.membership_agreements where id = new.agreement_id;
  else
    select client_id into v_client from public.public_purchase_intents where id = new.purchase_intent_id;
  end if;
  if not found or (v_client is not null and v_client <> new.client_id) then
    raise exception using message = 'membership_source_owner_conflict', errcode = '23000';
  end if;
  return new;
end $$;
create trigger membership_v2_contract_source before insert on public.membership_v2_contracts
  for each row execute function public.membership_v2_check_contract_source();

create or replace function public.membership_v2_check_binding()
returns trigger language plpgsql security invoker set search_path = pg_catalog, public as $$
declare v_offer jsonb;
begin
  select offer_snapshot into v_offer from public.membership_v2_contracts
    where id = new.contract_id and contract_version = new.contract_version;
  if not found or ((v_offer->'first_role_prepay'->>'selected')::boolean = (new.first_role_price_id is not null)) is not true then
    raise exception using message = 'membership_binding_offer_conflict', errcode = '23000';
  end if;
  return new;
end $$;
create trigger membership_v2_binding_offer before insert on public.membership_v2_provider_bindings
  for each row execute function public.membership_v2_check_binding();

-- No renewal-period advancement or provider alignment executor ships in this
-- foundation. Keep that path closed until its paid-period/readback gate exists.
create or replace function public.membership_v2_check_state_update()
returns trigger language plpgsql security invoker set search_path = pg_catalog, public as $$
begin
  if new.contract_id is distinct from old.contract_id or new.original_paid_at is distinct from old.original_paid_at
    or new.term_index is distinct from old.term_index or new.term_start_at is distinct from old.term_start_at
    or new.term_end_at is distinct from old.term_end_at or new.provider_alignment is distinct from old.provider_alignment
    or new.renewal_ready is distinct from old.renewal_ready or new.revision <> old.revision + 1
    or new.preference_version <> old.preference_version + (case when new.auto_renew <> old.auto_renew then 1 else 0 end) then
    raise exception using message = 'membership_state_writer_not_ready', errcode = '23000';
  end if;
  return new;
end $$;
create trigger membership_v2_state_update before update on public.membership_v2_contract_state
  for each row execute function public.membership_v2_check_state_update();

-- Input is ONLY a previously verified pure helper receipt, plus the native
-- platform invoice line ID. This transaction does not authenticate Stripe or
-- authorize a caller, update clients, grant access or mark alignment verified.
create or replace function public.membership_v2_reserve_initial_payment(
  p_contract_id uuid, p_contract_version integer, p_client_id uuid, p_billing_owner_user_id uuid,
  p_provider_account_id text, p_receipt jsonb)
returns jsonb language plpgsql security invoker set search_path = pg_catalog, public as $$
declare c public.membership_v2_contracts; b public.membership_v2_provider_bindings;
  r public.membership_v2_initial_receipts; v_identity jsonb; v_paid timestamptz;
  v_months integer; v_access_months integer; v_end timestamptz;
begin
  select * into c from public.membership_v2_contracts where id = p_contract_id for update;
  if not found or (c.contract_version = p_contract_version and c.client_id = p_client_id
      and c.billing_owner_user_id = p_billing_owner_user_id) is not true then
    raise exception using message = 'membership_contract_scope_conflict', errcode = '23000';
  end if;
  select * into b from public.membership_v2_provider_bindings where contract_id = c.id;
  if not found or (b.contract_version = c.contract_version and b.provider_account_id = p_provider_account_id) is not true then
    raise exception using message = 'membership_binding_missing', errcode = '23000';
  end if;
  if (jsonb_typeof(p_receipt) = 'object'
    and p_receipt->>'contract_id' = c.id::text and p_receipt->>'contract_version' = c.contract_version::text
    and p_receipt->>'offer_version' = c.offer_snapshot->>'offer_version'
    and p_receipt->>'customer_id' = b.customer_id and p_receipt->>'checkout_session_id' = b.checkout_session_id
    and p_receipt->>'subscription_id' = b.subscription_id
    and p_receipt->>'platform_price_id' = b.platform_price_id and p_receipt->>'platform_item_id' = b.platform_item_id
    and (p_receipt->>'first_role_price_id') is not distinct from b.first_role_price_id
    and jsonb_typeof(p_receipt->'livemode') = 'boolean' and (p_receipt->>'livemode')::boolean = b.livemode
    and p_receipt->>'currency' = 'usd') is not true then
    raise exception using message = 'membership_receipt_binding_conflict', errcode = '23000';
  end if;
  v_paid := (p_receipt->>'payment_success_at')::timestamptz;
  if v_paid is null or not isfinite(v_paid) or v_paid <> date_trunc('second',v_paid)
    or v_paid < c.accepted_at or v_paid > clock_timestamp() then
    raise exception using message = 'membership_receipt_time_invalid', errcode = '22023';
  end if;
  v_identity := jsonb_build_object('contract_id',c.id,'contract_version',c.contract_version,
    'offer_version',c.offer_snapshot->>'offer_version','provider_account_id',b.provider_account_id,
    'livemode',b.livemode,'currency','usd','customer_id',b.customer_id,
    'checkout_session_id',b.checkout_session_id,'subscription_id',b.subscription_id,
    'invoice_id',p_receipt->>'invoice_id','payment_intent_id',p_receipt->>'payment_intent_id',
    'charge_id',p_receipt->>'charge_id','platform_price_id',b.platform_price_id,
    'platform_item_id',b.platform_item_id,'first_role_price_id',b.first_role_price_id,
    'payment_success_at',to_char(v_paid at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'platform_line_id',p_receipt->>'platform_line_id');
  select * into r from public.membership_v2_initial_receipts where contract_id = c.id;
  if found then
    if r.identity is distinct from v_identity then
      raise exception using message = 'membership_initial_receipt_conflict', errcode = '23000';
    end if;
    -- Matching replay must not reset changed preferences/terms/access. Never
    -- return mutable state as an activation write plan after refund or renewal.
    return jsonb_build_object('action','already_reserved','identity',r.identity);
  end if;
  if exists(select 1 from jsonb_each(jsonb_build_object('collected',p_receipt->'collected_cents',
    'platform',p_receipt->'platform_payment_cents','role',p_receipt->'first_role_payment_cents','tax',p_receipt->'tax_cents')) x
    where jsonb_typeof(x.value) is distinct from 'number' or x.value::text !~ '^[0-9]+$'
      or length(x.value::text) > 16)
    or (p_receipt->>'platform_payment_cents')::bigint <> (c.offer_snapshot->>'platform_payment_cents')::bigint
    or (p_receipt->>'first_role_payment_cents')::bigint <> (c.offer_snapshot->'first_role_prepay'->>'amount_cents')::bigint then
    raise exception using message = 'membership_receipt_amount_invalid', errcode = '23000';
  end if;
  insert into public.membership_v2_initial_receipts(contract_id,contract_version,provider_account_id,livemode,identity,
    checkout_session_id,subscription_id,invoice_id,payment_intent_id,charge_id,platform_line_id,paid_at,
    collected_cents,platform_cents,first_role_cents,tax_cents)
  values(c.id,c.contract_version,b.provider_account_id,b.livemode,v_identity,b.checkout_session_id,b.subscription_id,
    p_receipt->>'invoice_id',p_receipt->>'payment_intent_id',p_receipt->>'charge_id',p_receipt->>'platform_line_id',v_paid,
    (p_receipt->>'collected_cents')::bigint,(p_receipt->>'platform_payment_cents')::bigint,
    (p_receipt->>'first_role_payment_cents')::bigint,(p_receipt->>'tax_cents')::bigint);
  v_months := (c.offer_snapshot->>'commitment_months')::integer;
  v_access_months := case when c.offer_snapshot->>'payment_option' = 'prepaid' then v_months else 1 end;
  v_end := public.membership_v2_month_anchor(v_paid,v_months);
  insert into public.membership_v2_contract_state(contract_id,original_paid_at,term_start_at,term_end_at)
    values(c.id,v_paid,v_paid,v_end);
  insert into public.membership_v2_paid_periods(contract_id,period_index,provider_account_id,livemode,invoice_id,
    platform_line_id,starts_at,ends_at,platform_cents,paid_at)
    values(c.id,0,b.provider_account_id,b.livemode,p_receipt->>'invoice_id',p_receipt->>'platform_line_id',
      v_paid,public.membership_v2_month_anchor(v_paid,v_access_months),(c.offer_snapshot->>'platform_payment_cents')::bigint,v_paid);
  return jsonb_build_object('action','initial_payment_reserved','contract_id',c.id,
    'renewal_ready',false,'provider_alignment','pending');
end $$;

-- Defense in depth: no browser table/RPC access even on projects with permissive
-- automatic grants. No table DELETE or TRUNCATE is granted to the service role.
alter table public.membership_v2_contracts enable row level security;
alter table public.membership_v2_provider_bindings enable row level security;
alter table public.membership_v2_initial_receipts enable row level security;
alter table public.membership_v2_contract_state enable row level security;
alter table public.membership_v2_paid_periods enable row level security;
revoke all on public.membership_v2_contracts,public.membership_v2_provider_bindings,
  public.membership_v2_initial_receipts,public.membership_v2_contract_state,public.membership_v2_paid_periods
  from public,anon,authenticated,service_role;
grant select,insert on public.membership_v2_contracts,public.membership_v2_provider_bindings,
  public.membership_v2_initial_receipts,public.membership_v2_paid_periods to service_role;
-- SELECT FOR UPDATE on the immutable contract needs UPDATE privilege; trigger
-- rejects actual mutations. State will require separate version-locked writers.
grant update on public.membership_v2_contracts to service_role;
grant select,insert,update on public.membership_v2_contract_state to service_role;
revoke all on function public.membership_v2_month_anchor(timestamptz,integer),public.membership_v2_valid_offer(jsonb),
  public.membership_v2_reject_mutation(),public.membership_v2_check_contract_source(),public.membership_v2_check_binding(),public.membership_v2_check_state_update(),
  public.membership_v2_reserve_initial_payment(uuid,integer,uuid,uuid,text,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.membership_v2_month_anchor(timestamptz,integer),public.membership_v2_valid_offer(jsonb),
  public.membership_v2_reject_mutation(),public.membership_v2_check_contract_source(),public.membership_v2_check_binding(),public.membership_v2_check_state_update(),
  public.membership_v2_reserve_initial_payment(uuid,integer,uuid,uuid,text,jsonb) to service_role;
commit;
