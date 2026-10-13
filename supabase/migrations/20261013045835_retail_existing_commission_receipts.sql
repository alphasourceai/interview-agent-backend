-- Local existing-flow pricing adapter. Manual reviewed receipts only.
-- Apply only with writers quiesced and in-flight calls drained; no backfill.
begin;
set local lock_timeout='10s';

-- Compile the existing ledger's exact baseline for native schema comparisons.
create temporary table retail_expected_baseline_receipts (
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
) on commit drop;

-- Validate only two known ledger shapes. No retired contract stack installation.
do $schema$
declare old_v2 boolean; names text[]; expected text; actual text; key text; p record; expected_checks text[]; actual_checks text[];
  balance_guard record; paid_helper record; bank record; bank_attr smallint; receipt_attr smallint; bank_id_attr smallint;
begin
  if to_regclass('public.retail_existing_sales_qualifications') is null
    or to_regprocedure('public.retail_existing_sales_terms_digest(jsonb)') is null
    or to_regprocedure('public.retail_existing_commission_source(uuid)') is not null
    or exists(select 1 from pg_attribute where attrelid='public.sales_commission_receipts'::regclass
      and attname='sales_qualification_id' and not attisdropped)
  then raise exception 'retail_commission_schema_prerequisite'; end if;
  if not exists(select 1 from pg_class where oid='public.sales_commission_receipts'::regclass and relrowsecurity)
    or has_table_privilege('anon','public.sales_commission_receipts','SELECT,INSERT,UPDATE,DELETE,TRUNCATE')
    or has_table_privilege('authenticated','public.sales_commission_receipts','SELECT,INSERT,UPDATE,DELETE,TRUNCATE')
    or not has_table_privilege('service_role','public.sales_commission_receipts','SELECT')
    or not has_table_privilege('service_role','public.sales_commission_receipts','INSERT')
    -- The existing ledger grants UPDATE but its append-only trigger refuses it.
    -- Preserve that reviewed ACL, not an invented select/insert-only baseline.
    or not has_table_privilege('service_role','public.sales_commission_receipts','UPDATE')
    or has_table_privilege('service_role','public.sales_commission_receipts','DELETE,TRUNCATE')
  then raise exception 'retail_commission_ledger_privilege_drift'; end if;
  -- The existing append-only/departure/week/balance gates must still be the
  -- recognized native bodies. No regrant or weakening of any of them here.
  for p in select * from (values
    ('reject_sales_commission_ledger_mutation','60e25f1abc2aff6f5a02d1ed0b1c40c9'),
    ('check_sales_commission_departure_cutoff','030f985df12a23358849d9343cf70b80'),
    ('check_sales_commission_week_unlocked','10ef36caf48a5cb65f777328d1393767')) as v(name,hash) loop
    if not exists(select 1 from pg_proc where oid=to_regprocedure('public.'||p.name||'()') and md5(prosrc)=p.hash and not prosecdef)
    then raise exception 'retail_commission_existing_guard_drift'; end if;
  end loop;
  -- Preserve either known payroll baseline, including the existing Mercury
  -- reversal-aware successor. Never reinstall the older balance function.
  select * into balance_guard from pg_proc
    where oid=to_regprocedure('public.check_sales_commission_receipt_balance()');
  if balance_guard.oid is null or balance_guard.prosecdef
    or md5(balance_guard.prosrc) not in('c09edf8ee2a7e017179ceaeb36bcac05','9076bbf8ad26c2a27a09e8efef9c584f')
  then raise exception 'retail_commission_existing_guard_drift'; end if;
  if md5(balance_guard.prosrc)='c09edf8ee2a7e017179ceaeb36bcac05' then
    if to_regprocedure('public.sales_commission_effective_paid(uuid)') is not null
      or to_regclass('public.sales_commission_bank_transactions') is not null
      or to_regclass('public.sales_commission_bank_reversals') is not null
      or to_regclass('public.sales_commission_bank_api_bindings') is not null
      or exists(select 1 from pg_attribute where attrelid='public.sales_commission_payouts'::regclass
        and attname='bank_transaction_id' and not attisdropped)
    then raise exception 'retail_commission_existing_guard_drift'; end if;
  else
    if balance_guard.prolang is distinct from(select oid from pg_language where lanname='plpgsql')
      or balance_guard.prorettype<>'trigger'::regtype or balance_guard.provolatile<>'v'
      or balance_guard.proconfig is distinct from array['search_path=""']::text[]
    then raise exception 'retail_commission_existing_guard_drift'; end if;
    select * into paid_helper from pg_proc where oid=to_regprocedure('public.sales_commission_effective_paid(uuid)');
    if paid_helper.oid is null or md5(paid_helper.prosrc) is distinct from '246336636dd04aabc37bbf44e9a8b143'
      or paid_helper.prosecdef or paid_helper.prorettype<>'bigint'::regtype or paid_helper.proretset
      or paid_helper.prolang is distinct from(select oid from pg_language where lanname='sql')
      or paid_helper.provolatile<>'s' or paid_helper.pronargs<>1 or paid_helper.proargtypes[0]<>'uuid'::regtype
      or paid_helper.proargnames is distinct from array['p_receipt_id']::text[]
      or paid_helper.proconfig is distinct from array['search_path=""']::text[]
      or has_function_privilege('anon',paid_helper.oid,'EXECUTE')
      or has_function_privilege('authenticated',paid_helper.oid,'EXECUTE')
      or not has_function_privilege('service_role',paid_helper.oid,'EXECUTE')
      or to_regclass('public.sales_commission_bank_transactions') is null
      or to_regclass('public.sales_commission_bank_reversals') is null
      or to_regclass('public.sales_commission_bank_api_bindings') is null
    then raise exception 'retail_commission_existing_guard_drift'; end if;
    select attnum into bank_id_attr from pg_attribute where attrelid='public.sales_commission_bank_transactions'::regclass
      and attname='id' and not attisdropped and atttypid='uuid'::regtype and attnotnull;
    select attnum into bank_attr from pg_attribute where attrelid='public.sales_commission_payouts'::regclass
      and attname='bank_transaction_id' and not attisdropped and atttypid='uuid'::regtype and not attnotnull;
    select attnum into receipt_attr from pg_attribute where attrelid='public.sales_commission_payouts'::regclass
      and attname='receipt_id' and not attisdropped;
    if bank_id_attr is null or bank_attr is null or receipt_attr is null
      or not exists(select 1 from pg_constraint where conrelid='public.sales_commission_payouts'::regclass and contype='f'
        and convalidated and conkey=array[bank_attr] and confkey=array[bank_id_attr]
        and confrelid='public.sales_commission_bank_transactions'::regclass and confdeltype='r')
      or not exists(select 1 from pg_index where indexrelid=to_regclass('public.sales_commission_payout_bank_receipt_uniq')
        and indrelid='public.sales_commission_payouts'::regclass and indisunique and indisvalid and indisready
        and indnatts=2 and indnkeyatts=2 and indkey[0]=bank_attr and indkey[1]=receipt_attr and indexprs is null
        and pg_get_expr(indpred,indrelid)='(bank_transaction_id IS NOT NULL)')
    then raise exception 'retail_commission_existing_guard_drift'; end if;
    for bank in select * from(values
      ('sales_commission_bank_transactions','sales_commission_bank_transactions_immutable'),
      ('sales_commission_bank_reversals','sales_commission_bank_reversals_immutable'),
      ('sales_commission_bank_api_bindings','sales_commission_bank_api_bindings_immutable')) v(tbl,trg) loop
      if not exists(select 1 from pg_trigger where tgrelid=to_regclass('public.'||bank.tbl)
        and tgname=bank.trg and tgenabled='O' and tgtype=27
        and tgfoid=to_regprocedure('public.reject_sales_commission_ledger_mutation()'))
      then raise exception 'retail_commission_existing_guard_drift'; end if;
      if bank.tbl<>'sales_commission_bank_transactions' then
        select attnum into bank_attr from pg_attribute where attrelid=to_regclass('public.'||bank.tbl)
          and attname='bank_transaction_id' and not attisdropped and atttypid='uuid'::regtype and attnotnull;
        if bank_attr is null or not exists(select 1 from pg_constraint where conrelid=to_regclass('public.'||bank.tbl)
          and contype='p' and convalidated and conkey=array[bank_attr])
          or not exists(select 1 from pg_constraint where conrelid=to_regclass('public.'||bank.tbl)
            and contype='f' and convalidated and conkey=array[bank_attr] and confkey=array[bank_id_attr]
            and confrelid='public.sales_commission_bank_transactions'::regclass and confdeltype='r')
        then raise exception 'retail_commission_existing_guard_drift'; end if;
      end if;
    end loop;
    select attnum into bank_attr from pg_attribute where attrelid='public.sales_commission_bank_api_bindings'::regclass
      and attname='mercury_transaction_id' and not attisdropped and atttypid='uuid'::regtype and attnotnull;
    if bank_attr is null or not exists(select 1 from pg_constraint where conrelid='public.sales_commission_bank_api_bindings'::regclass
      and contype='u' and convalidated and conkey=array[bank_attr])
    then raise exception 'retail_commission_existing_guard_drift'; end if;
  end if;
  if not exists(select 1 from pg_trigger where tgrelid='public.sales_commission_receipts'::regclass
    and tgname='sales_commission_receipts_immutable' and tgenabled='O'
    and tgfoid=to_regprocedure('public.reject_sales_commission_ledger_mutation()'))
  then raise exception 'retail_commission_existing_guard_drift'; end if;
  for p in select * from(values
    ('sales_commission_receipts','sales_commission_receipt_attribution','require_sales_commission_sales_assisted'),
    ('sales_commission_adjustments','sales_commission_adjustment_attribution','require_sales_commission_sales_assisted'),
    ('sales_commission_payouts','sales_commission_payout_attribution','require_sales_commission_sales_assisted'),
    ('sales_commission_receipts','sales_commission_receipt_cutoff_guard','check_sales_commission_departure_cutoff'),
    ('sales_commission_receipts','sales_commission_receipt_week_guard','check_sales_commission_week_unlocked'),
    ('sales_commission_adjustments','sales_commission_adjustment_balance','check_sales_commission_receipt_balance'),
    ('sales_commission_payouts','sales_commission_payout_balance','check_sales_commission_receipt_balance'))as v(tbl,name,fn) loop
    if not exists(select 1 from pg_trigger where tgrelid=to_regclass('public.'||p.tbl)
      and tgname=p.name and tgenabled='O' and tgfoid=to_regprocedure('public.'||p.fn||'()'))
    then raise exception 'retail_commission_existing_trigger_drift'; end if;
  end loop;
  old_v2:=exists(select 1 from pg_attribute where attrelid='public.sales_commission_receipts'::regclass
    and attname='membership_terms_protocol' and not attisdropped);
  for p in select a.attname,a.atttypid,a.attnotnull,a.attgenerated,a.attidentity,
    pg_get_expr(d.adbin,d.adrelid) as expression from pg_attribute a left join pg_attrdef d on d.adrelid=a.attrelid and d.adnum=a.attnum
    where a.attrelid='pg_temp.retail_expected_baseline_receipts'::regclass and a.attnum>0 and not a.attisdropped loop
    if not exists(select 1 from pg_attribute a left join pg_attrdef d on d.adrelid=a.attrelid and d.adnum=a.attnum
      where a.attrelid='public.sales_commission_receipts'::regclass and a.attname=p.attname and not a.attisdropped
      and a.atttypid=p.atttypid and a.attnotnull=p.attnotnull and a.attgenerated=p.attgenerated and a.attidentity=p.attidentity
      and pg_get_expr(d.adbin,d.adrelid) is not distinct from p.expression)
    then raise exception 'retail_commission_baseline_column_drift'; end if;
  end loop;
  select array_agg(pg_get_expr(conbin,conrelid) order by pg_get_expr(conbin,conrelid)) into expected_checks
    from pg_constraint where conrelid='pg_temp.retail_expected_baseline_receipts'::regclass and contype='c'
    and(not old_v2 or regexp_replace(pg_get_expr(conbin,conrelid),'[[:space:]()]','','g')<>'payment_success_at<first_term_end_at');
  select array_agg(pg_get_expr(conbin,conrelid) order by pg_get_expr(conbin,conrelid)) into actual_checks
    from pg_constraint where conrelid='public.sales_commission_receipts'::regclass and contype='c' and convalidated
    and conname not in('sales_commission_receipts_protocol_shape','sales_commission_receipts_versioned_payment_window');
  if actual_checks is distinct from expected_checks then raise exception 'retail_commission_baseline_constraint_drift'; end if;
  select array_agg(pg_get_constraintdef(oid) order by pg_get_constraintdef(oid)) into expected_checks from pg_constraint
    where conrelid='pg_temp.retail_expected_baseline_receipts'::regclass and contype in('p','u');
  select array_agg(pg_get_constraintdef(oid) order by pg_get_constraintdef(oid)) into actual_checks from pg_constraint
    where conrelid='public.sales_commission_receipts'::regclass and contype in('p','u') and convalidated;
  if actual_checks is distinct from expected_checks then raise exception 'retail_commission_baseline_identity_drift'; end if;
  select * into p from pg_proc where oid=to_regprocedure('public.require_sales_commission_sales_assisted()');
  if p.oid is null or p.prosecdef or p.proconfig is distinct from array['search_path=""']::text[]
    or has_function_privilege('anon',p.oid,'EXECUTE') or has_function_privilege('authenticated',p.oid,'EXECUTE')
    or md5(p.prosrc) is distinct from(case when old_v2 then '716df68ae622b9349b62a14929f63b2a' else 'f7f482687118008250aa3404e47cc715' end)
  then raise exception 'retail_commission_attribution_source_drift'; end if;
  if old_v2 then
    foreach key in array array['membership_terms_protocol','membership_contract_id','membership_contract_version'] loop
      if not exists(select 1 from pg_attribute where attrelid='public.sales_commission_receipts'::regclass
        and attname=key and not attisdropped and atttypid=(case key when 'membership_terms_protocol' then 'text'::regtype
          when 'membership_contract_id' then 'uuid'::regtype else 'integer'::regtype end)
        and attnotnull=(key='membership_terms_protocol')) then raise exception 'retail_commission_versioned_schema_drift'; end if;
    end loop;
    if not exists(select 1 from pg_attribute a join pg_attrdef d on d.adrelid=a.attrelid and d.adnum=a.attnum
      where a.attrelid='public.sales_commission_receipts'::regclass and a.attname='membership_terms_protocol'
      and pg_get_expr(d.adbin,d.adrelid)='''legacy_receipt_v1''::text')
    then raise exception 'retail_commission_versioned_schema_drift'; end if;
    if to_regclass('public.membership_v2_sales_qualifications') is null
      or to_regclass('public.membership_v2_contracts') is null
      or not exists(select 1 from pg_constraint where conrelid='public.sales_commission_receipts'::regclass
        and conname='sales_commission_receipts_membership_qualification_fk' and contype='f' and convalidated
        and pg_get_constraintdef(oid)='FOREIGN KEY (membership_contract_id, membership_contract_version, purchase_intent_id, rep_user_id) REFERENCES membership_v2_sales_qualifications(contract_id, contract_version, purchase_intent_id, rep_user_id) ON DELETE RESTRICT')
    then raise exception 'retail_commission_versioned_schema_drift'; end if;
    create temporary table retail_expected_receipt_constraints(
      membership_terms_protocol text,membership_contract_id uuid,membership_contract_version integer,
      policy_version text,provider text,payment_success_at timestamptz,funds_received_at timestamptz,
      first_term_start_at timestamptz,first_term_end_at timestamptz,
      constraint sales_commission_receipts_protocol_shape check(
        (membership_terms_protocol='legacy_receipt_v1' and membership_contract_id is null and membership_contract_version is null)
        or(membership_terms_protocol='retail_terms_v2' and membership_contract_id is not null and membership_contract_version is not null
          and membership_contract_version>0 and policy_version='retail-terms-v2-commission-v1' and provider='stripe')),
      constraint sales_commission_receipts_versioned_payment_window check(
        (membership_terms_protocol='legacy_receipt_v1' and payment_success_at<first_term_end_at)
        or(membership_terms_protocol='retail_terms_v2' and isfinite(payment_success_at) and isfinite(funds_received_at)
          and payment_success_at>=first_term_start_at and payment_success_at<public.membership_v2_month_anchor(first_term_start_at,12)))
    ) on commit drop;
    foreach key in array array['sales_commission_receipts_protocol_shape','sales_commission_receipts_versioned_payment_window'] loop
      select pg_get_expr(conbin,conrelid) into expected from pg_constraint
        where conrelid='pg_temp.retail_expected_receipt_constraints'::regclass and conname=key;
      select pg_get_expr(conbin,conrelid) into actual from pg_constraint
        where conrelid='public.sales_commission_receipts'::regclass and conname=key and contype='c' and convalidated;
      if actual is distinct from expected then raise exception 'retail_commission_versioned_constraint_drift'; end if;
    end loop;
    select * into p from pg_proc where oid=to_regprocedure('public.membership_v2_check_commission_receipt()');
    if p.oid is null or p.prosecdef or p.proconfig is distinct from array['search_path=pg_catalog, public']::text[]
      or has_function_privilege('anon',p.oid,'EXECUTE') or has_function_privilege('authenticated',p.oid,'EXECUTE')
      or md5(p.prosrc) is distinct from '58d5556669717571c7bd9518417673df'
    then raise exception 'retail_commission_versioned_source_drift'; end if;
    if not exists(select 1 from pg_trigger where tgrelid='public.sales_commission_receipts'::regclass
      and tgname='membership_v2_commission_receipt_snapshot' and tgenabled='O' and tgfoid=p.oid)
    then raise exception 'retail_commission_versioned_trigger_drift'; end if;
    alter table public.sales_commission_receipts drop constraint sales_commission_receipts_protocol_shape,
      drop constraint sales_commission_receipts_versioned_payment_window;
  else
    if exists(select 1 from pg_attribute where attrelid='public.sales_commission_receipts'::regclass
      and attname in('membership_contract_id','membership_contract_version') and not attisdropped)
      or to_regprocedure('public.membership_v2_check_commission_receipt()') is not null
    then raise exception 'retail_commission_legacy_schema_drift'; end if;
    select array_agg(conname) into names from pg_constraint where conrelid='public.sales_commission_receipts'::regclass
      and contype='c' and convalidated and regexp_replace(pg_get_expr(conbin,conrelid),'[[:space:]()]','','g')='payment_success_at<first_term_end_at';
    if coalesce(array_length(names,1),0)<>1 then raise exception 'retail_commission_legacy_constraint_drift'; end if;
    execute format('alter table public.sales_commission_receipts drop constraint %I',names[1]);
    alter table public.sales_commission_receipts add column membership_terms_protocol text not null default 'legacy_receipt_v1',
      add column membership_contract_id uuid,add column membership_contract_version integer;
  end if;
  alter table public.sales_commission_receipts add column sales_qualification_id uuid;
  execute 'alter table public.sales_commission_receipts add constraint sales_commission_receipts_protocol_shape check('
    ||'(membership_terms_protocol=''legacy_receipt_v1'' and membership_contract_id is null and membership_contract_version is null and sales_qualification_id is null)'
    ||case when old_v2 then ' or(membership_terms_protocol=''retail_terms_v2'' and membership_contract_id is not null and membership_contract_version is not null and membership_contract_version>0 and policy_version=''retail-terms-v2-commission-v1'' and provider=''stripe'' and sales_qualification_id is null)' else '' end
    ||' or(membership_terms_protocol=''retail_existing_terms_v2'' and membership_contract_id is null and membership_contract_version is null and sales_qualification_id is not null and sales_qualification_id=purchase_intent_id and policy_version=''retail-existing-terms-v2-commission-v1'' and provider=''stripe''))';
  execute 'alter table public.sales_commission_receipts add constraint sales_commission_receipts_versioned_payment_window check('
    ||'(membership_terms_protocol=''legacy_receipt_v1'' and payment_success_at<first_term_end_at)'
    ||case when old_v2 then ' or(membership_terms_protocol=''retail_terms_v2'' and isfinite(payment_success_at) and isfinite(funds_received_at) and payment_success_at>=first_term_start_at and payment_success_at<public.membership_v2_month_anchor(first_term_start_at,12))' else '' end
    ||' or(membership_terms_protocol=''retail_existing_terms_v2'' and isfinite(payment_success_at) and isfinite(funds_received_at) and payment_success_at>=first_term_start_at and payment_success_at<public.retail_existing_month_anchor(first_term_start_at,12)))';
  alter table public.sales_commission_receipts add constraint sales_commission_receipts_existing_qualification_fk
    foreign key(sales_qualification_id) references public.retail_existing_sales_qualifications(purchase_intent_id) on delete restrict;
end $schema$;
create index sales_commission_receipts_existing_qualification_idx on public.sales_commission_receipts(sales_qualification_id)
  where sales_qualification_id is not null;

-- Source classification uses native catalog presence, never catches a failed
-- old-table read as legacy. Only a REAL old contract selects the old-v2 path.
create function public.retail_existing_commission_source(p_intent uuid)
returns text language plpgsql stable security invoker set search_path=pg_catalog as $$
declare i public.public_purchase_intents; a public.membership_agreements; old_contract boolean:=false; qualified boolean; marked boolean;
begin
  select * into i from public.public_purchase_intents where id=p_intent;
  if i.id is null then raise exception 'unverified_qualifying_sale'; end if;
  select * into a from public.membership_agreements where id=i.agreement_id;
  qualified:=exists(select 1 from public.retail_existing_sales_qualifications where purchase_intent_id=i.id);
  if to_regclass('public.membership_v2_contracts') is not null then
    execute 'select exists(select 1 from public.membership_v2_contracts where purchase_intent_id=$1 or agreement_id=$2)'
      into old_contract using i.id,i.agreement_id;
  end if;
  if old_contract and qualified then raise exception 'ambiguous_membership_commission_source'; end if;
  if old_contract then return 'retail_terms_v2'; end if;
  marked:=coalesce(i.package_snapshot ?| array['pricing_protocol','membership_terms','pricing_version'],false)
    or coalesce(a.template_snapshot->'package_snapshot' ?| array['pricing_protocol','membership_terms','pricing_version'],false)
    or a.template_version='membership_agreement_retail_terms_v2'
    or a.template_snapshot->>'template_version'='membership_agreement_retail_terms_v2'
    or i.selected_billing_cadence='prepaid' or a.billing_option='prepaid';
  if qualified or marked then return 'retail_existing_terms_v2'; end if;
  return 'legacy_receipt_v1';
end $$;

-- A stored qualification is necessary, not sufficient. Receipt inserts need
-- completed native billing and a matching signed/paid source. Linked corrections
-- and payouts validate immutable original attribution without requiring today's
-- active client or current creator (refunds may occur after expiry/reassignment).
create function public.retail_existing_assert_commission_receipt(p_receipt jsonb,p_linked boolean)
returns void language plpgsql security invoker set search_path=pg_catalog as $$
declare q public.retail_existing_sales_qualifications; i public.public_purchase_intents; a public.membership_agreements;
  c public.clients; months integer;
begin
  if jsonb_typeof(p_receipt) is distinct from 'object' or p_linked is null
    or p_receipt->>'membership_terms_protocol' is distinct from 'retail_existing_terms_v2'
  then raise exception 'retail_commission_receipt_source_conflict'; end if;
  select * into q from public.retail_existing_sales_qualifications where purchase_intent_id=(p_receipt->>'sales_qualification_id')::uuid;
  if q.purchase_intent_id is null or (p_receipt->>'purchase_intent_id')::uuid is distinct from q.purchase_intent_id
    or (p_receipt->>'rep_user_id')::uuid is distinct from q.rep_user_id
    or p_receipt->>'policy_version' is distinct from 'retail-existing-terms-v2-commission-v1'
    or p_receipt->>'provider' is distinct from 'stripe'
    or p_receipt->>'payment_kind' is distinct from q.payment_kind
    or p_receipt->>'membership_contract_id' is not null or p_receipt->>'membership_contract_version' is not null
    or (p_receipt->>'first_term_start_at')::timestamptz is distinct from q.original_start_at
    or (p_receipt->>'first_term_end_at')::timestamptz is distinct from q.original_term_end_at
    or (p_receipt->>'qualification_closed_at')::timestamptz is distinct from q.qualification_closed_at
    or (p_receipt->>'gross_membership_cents')::bigint is null or (p_receipt->>'gross_membership_cents')::bigint>q.platform_cap_cents
    or (p_receipt->>'payment_success_at')::timestamptz is null or not isfinite((p_receipt->>'payment_success_at')::timestamptz)
    or (p_receipt->>'payment_success_at')::timestamptz<q.original_start_at
    or (p_receipt->>'payment_success_at')::timestamptz>=q.commission_window_end_at
    or (p_receipt->>'payment_success_at')::timestamptz>clock_timestamp()
    or (p_receipt->>'funds_received_at')::timestamptz is null or not isfinite((p_receipt->>'funds_received_at')::timestamptz)
    or (p_receipt->>'funds_received_at')::timestamptz>clock_timestamp()
  then raise exception 'retail_commission_receipt_source_conflict'; end if;
  if p_linked then return; end if;
  select * into i from public.public_purchase_intents where id=q.purchase_intent_id for share;
  select * into a from public.membership_agreements where id=q.agreement_id for share;
  select * into c from public.clients where id=q.client_id for share;
  months:=public.retail_existing_terms_months(to_jsonb(a),to_jsonb(i));
  if months<=0 or i.id is null or a.id is null or c.id is null
    or i.status is distinct from 'completed' or i.billing_applied_at is null or not isfinite(i.billing_applied_at)
    or i.agreement_id is distinct from q.agreement_id or i.client_id is distinct from q.client_id
    or a.client_id is distinct from q.client_id or a.status is distinct from 'signed' or a.checkout_status is distinct from 'paid'
    or a.signed_at is null or a.signed_at>q.original_start_at
    or i.activated_at is distinct from q.original_start_at or a.checkout_paid_at is distinct from q.original_start_at
    or c.billing_status is distinct from 'active'
    or coalesce(nullif(lower(btrim(c.subscription_status)),''),'active') not in('active','trialing')
    or q.terms_digest is distinct from public.retail_existing_sales_terms_digest(i.package_snapshot->'membership_terms')
  then raise exception 'retail_commission_activation_incomplete'; end if;
end $$;

-- Preserve each recognized legacy/v2 body, adding ONLY the new frozen branch.
do $functions$
declare sig text; definition text; source text; original_acl aclitem[]; original_owner oid; original_config text[];
  oid_ oid; injection text; needle text; replacement text; marker text:=E'begin\n';
begin
  foreach sig in array array['public.require_sales_commission_sales_assisted()','public.membership_v2_check_commission_receipt()'] loop
    oid_:=to_regprocedure(sig);
    if oid_ is null then continue; end if;
    select pg_get_functiondef(oid),prosrc,proacl,proowner,proconfig into definition,source,original_acl,original_owner,original_config from pg_proc where oid=oid_;
    if sig='public.require_sales_commission_sales_assisted()' then
      if (length(source)-length(replace(source,marker,'')))/length(marker)<>1
      then raise exception 'retail_commission_attribution_patch_drift'; end if;
      -- Declare a separate receipt variable; do not change old branch variables.
      definition:=replace(definition,E'declare\n',E'declare\n  v_existing_receipt public.sales_commission_receipts;\n');
      if strpos(source,E'declare\n')=0 then
        definition:=replace(definition,'declare v_receipt','declare v_existing_receipt public.sales_commission_receipts; v_receipt');
      end if;
      injection:=$body$
  if tg_table_name='sales_commission_receipts' then v_existing_receipt:=new;
  else select * into v_existing_receipt from public.sales_commission_receipts where id=new.receipt_id; end if;
  if v_existing_receipt.membership_terms_protocol='retail_existing_terms_v2' then
    perform public.retail_existing_assert_commission_receipt(to_jsonb(v_existing_receipt),tg_table_name<>'sales_commission_receipts');
    return new;
  end if;
  if tg_table_name='sales_commission_receipts'
    and public.retail_existing_commission_source(v_existing_receipt.purchase_intent_id) is distinct from v_existing_receipt.membership_terms_protocol
  then raise exception 'membership_commission_protocol_required'; end if;
$body$;
      definition:=replace(definition,marker,marker||injection);
    else
      injection:=$body$
  if new.membership_terms_protocol='retail_existing_terms_v2' then
    perform public.retail_existing_assert_commission_receipt(to_jsonb(new),false); return new;
  end if;
$body$;
      definition:=replace(definition,marker,marker||injection);
      needle:='    if exists (select 1 from public.membership_v2_contracts c';
      replacement:='    if to_regclass(''public.membership_v2_contracts'') is not null then'||E'\n'||needle;
      definition:=replace(definition,needle,replacement);
      needle:=E'    end if;\n    return new;';
      definition:=replace(definition,needle,E'    end if;\n    end if;\n    return new;');
    end if;
    execute definition;
    if not exists(select 1 from pg_proc where oid=oid_ and proacl is not distinct from original_acl
      and proowner=original_owner and not prosecdef and proconfig is not distinct from original_config)
    then raise exception 'retail_commission_function_privilege_drift'; end if;
  end loop;
end $functions$;
revoke all on function public.retail_existing_commission_source(uuid),public.retail_existing_assert_commission_receipt(jsonb,boolean)
  from public,anon,authenticated;
grant execute on function public.retail_existing_commission_source(uuid),public.retail_existing_assert_commission_receipt(jsonb,boolean) to service_role;

-- Keep the existing admin review list useful after reassignment, while never
-- presenting completion-only new sales as qualified for receipt review.
do $view$
declare original_owner oid; original_acl aclitem[]; expected text; actual text;
begin
  create temporary view retail_expected_review_candidates as
    select i.id,i.company_legal_name,i.buyer_email,i.selected_plan_key,i.selected_billing_cadence,i.created_by_user_id,i.activated_at
    from public.public_purchase_intents i join public.membership_agreements a on a.id=i.agreement_id and a.client_id=i.client_id
    join public.clients c on c.id=i.client_id
    where i.status='completed' and i.channel='sales_assisted' and i.activated_at is not null and i.created_by_user_id is not null
      and a.status='signed' and a.checkout_status='paid' and a.signed_at is not null and a.checkout_paid_at is not null
      and c.billing_status='active' and coalesce(nullif(lower(btrim(c.subscription_status)),''),'active') in('active','trialing');
  select pg_get_viewdef('pg_temp.retail_expected_review_candidates'::regclass,false) into expected;
  select pg_get_viewdef(oid,false),relowner,relacl into actual,original_owner,original_acl from pg_class
    where oid='public.sales_commission_review_candidates'::regclass and relkind='v' and reloptions=array['security_invoker=true']::text[];
  if actual is distinct from expected or has_table_privilege('anon','public.sales_commission_review_candidates','SELECT')
    or has_table_privilege('authenticated','public.sales_commission_review_candidates','SELECT')
    or not has_table_privilege('service_role','public.sales_commission_review_candidates','SELECT')
  then raise exception 'retail_commission_review_view_drift'; end if;
  create or replace view public.sales_commission_review_candidates with(security_invoker=true) as
    select i.id,i.company_legal_name,i.buyer_email,i.selected_plan_key,i.selected_billing_cadence,
      coalesce(q.rep_user_id,i.created_by_user_id) as created_by_user_id,coalesce(q.original_start_at,i.activated_at) as activated_at
    from public.public_purchase_intents i join public.membership_agreements a on a.id=i.agreement_id and a.client_id=i.client_id
    join public.clients c on c.id=i.client_id left join public.retail_existing_sales_qualifications q on q.purchase_intent_id=i.id
    where i.status='completed' and i.activated_at is not null
      and((q.purchase_intent_id is not null and i.billing_applied_at is not null and isfinite(i.billing_applied_at))
        or(q.purchase_intent_id is null and i.channel='sales_assisted' and i.created_by_user_id is not null))
      and a.status='signed' and a.checkout_status='paid' and a.signed_at is not null and a.checkout_paid_at is not null
      and c.billing_status='active' and coalesce(nullif(lower(btrim(c.subscription_status)),''),'active') in('active','trialing');
  if not exists(select 1 from pg_class where oid='public.sales_commission_review_candidates'::regclass and relowner=original_owner
    and relacl is not distinct from original_acl and reloptions=array['security_invoker=true']::text[])
  then raise exception 'retail_commission_review_view_privilege_drift'; end if;
  drop view pg_temp.retail_expected_review_candidates;
end $view$;
commit;
