-- LOCAL CANDIDATE: pricing compatibility on the existing paid activation path.
-- No legacy backfill, Auth/member redesign, hosted application or release approval.
begin;
set local lock_timeout = '10s';

create or replace function public.retail_existing_month_anchor(p_anchor timestamptz, p_months integer)
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
create or replace function public.retail_existing_valid_offer(p_offer jsonb)
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
    and (p_offer->>'additional_interview_fee_cents')::bigint between 0 and 9007199254740991
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


create or replace function public.retail_existing_closed_object(p_value jsonb, p_keys text[])
returns boolean language sql immutable security invoker set search_path = pg_catalog as $$
  select case when jsonb_typeof(p_value) = 'object' then
    (select coalesce(array_agg(k order by k), '{}'::text[]) from jsonb_object_keys(p_value) as k)
      = (select array_agg(k order by k) from unnest(p_keys) as k)
    else false end
$$;

create or replace function public.retail_existing_package(p_offer jsonb)
returns jsonb language plpgsql immutable security invoker set search_path = pg_catalog, public as $$
declare o jsonb := p_offer; r jsonb := o->'first_role_prepay'; b text;
begin
  if not public.retail_existing_valid_offer(o)
    or not public.retail_existing_closed_object(o, array[
      'schema_version','offer_version','offer_key','plan_key','display_name','currency','commitment_months',
      'term_start_basis','contract_timezone','payment_option','platform_payment_cents','platform_commitment_total_cents',
      'installment_count','stripe_recurrence','initial_payment_cents','per_role_fee_cents','additional_interview_fee_cents',
      'included_interviews_per_role','max_interview_minutes','scored_question_count','billing_model','rollover_days',
      'first_role_prepay','renewal'])
    or not public.retail_existing_closed_object(r,array['selected','amount_cents','normal_role_fee_cents','credit_type','expires','non_refundable'])
    or not public.retail_existing_closed_object(o->'renewal',array['default_auto_renew','commitment_months','retain_accepted_pricing','reminder_days','non_renewal_cutoff','ends_installments_early'])
    or not public.retail_existing_closed_object(o->'stripe_recurrence',array['interval','interval_count'])
    or o->>'offer_version' !~ '^[A-Za-z0-9._-]{1,100}$'
    or o->>'offer_key' is distinct from (o->>'plan_key')||'-'||(o->>'commitment_months')||'-'||(o->>'payment_option')
    or ((r->>'selected')::boolean and (r->>'amount_cents')::bigint >= (r->>'normal_role_fee_cents')::bigint)
  then raise exception using errcode='22023', message='invalid_retail_package_terms'; end if;
  b := case when o->>'payment_option'='prepaid' then 'prepaid' else 'monthly' end;
  return jsonb_build_object(
    'pricing_protocol','retail_package_terms_v2','pricing_version',o->>'offer_version','membership_terms',o,
    'plan_key',o->>'plan_key','display_name',o->>'display_name',
    'platform_fee',(o->>'platform_payment_cents')::numeric/100,'platform_fee_cents',o->'platform_payment_cents',
    'platform_fee_billing_cadence',b,'billing_cadence',b,
    'billing_cadence_display_name',case when b='prepaid' then (o->>'commitment_months')||'-month prepaid'
      else 'Monthly payments; '||(o->>'commitment_months')||'-month commitment' end,
    'commitment_months',o->'commitment_months','payment_option',o->>'payment_option',
    'platform_commitment_total_cents',o->'platform_commitment_total_cents',
    'included_interviews',o->'included_interviews_per_role','included_interviews_per_role',o->'included_interviews_per_role',
    'interview_duration_minutes',o->'max_interview_minutes','max_interview_minutes',o->'max_interview_minutes',
    'scored_question_count',o->'scored_question_count',
    'additional_interview_price',(o->>'additional_interview_fee_cents')::numeric/100,
    'additional_interview_fee',(o->>'additional_interview_fee_cents')::numeric/100,
    'overage_price',(o->>'additional_interview_fee_cents')::numeric/100,'per_role_fee',(o->>'per_role_fee_cents')::numeric/100,
    'first_role_prepay',jsonb_build_object('enabled',true,'selected',r->'selected','credit_type','first_role_prepay',
      'normal_role_fee_cents',r->'normal_role_fee_cents','discounted_credit_amount_cents',r->'amount_cents',
      'discount_percent',10,'non_refundable',true,'expires',false));
end $$;

-- JSON-only validation of rows ALREADY locked intent -> agreement by existing
-- writers. Reads no tables, acquires no locks, and makes no provider/clock calls.
create or replace function public.retail_existing_terms_months(p_agreement jsonb, p_intent jsonb)
returns integer language plpgsql immutable security invoker set search_path = pg_catalog, public as $$
declare a jsonb := p_agreement; i jsonb := p_intent;
  s jsonb := a->'template_snapshot'; p jsonb := s->'package_snapshot'; q jsonb := i->'package_snapshot';
  o jsonb; v jsonb := s->'values'; b text; role jsonb; source text := s->>'source';
begin
  if not (coalesce(p ?| array['pricing_protocol','pricing_version','membership_terms'],false)
    or coalesce(q ?| array['pricing_protocol','pricing_version','membership_terms'],false)
    or lower(btrim(coalesce(a->>'billing_option','')))='prepaid'
    or lower(btrim(coalesce(v->>'billing_option','')))='prepaid'
    or lower(btrim(coalesce(i->>'selected_billing_cadence','')))='prepaid')
  then return 0; end if;
  o := p->'membership_terms'; role := o->'first_role_prepay';
  if p is distinct from q or p is distinct from public.retail_existing_package(o)
    or i->>'protocol' is distinct from 'fenced_v2'
    or s->>'template_version' is distinct from 'membership_agreement_retail_terms_v2'
    or a->>'template_version' is distinct from 'membership_agreement_retail_terms_v2'
    or a->'signer_accepted' is distinct from 'true'::jsonb
    or a->'auto_renew' is distinct from 'true'::jsonb or v->'auto_renew' is distinct from 'true'::jsonb
    or i->>'term_start_basis' is distinct from 'successful_payment'
    or v->>'term_start_basis' is distinct from 'successful_payment'
    or a->>'id' is distinct from i->>'agreement_id'
    or s->'purchase_intent'->>'id' is distinct from i->>'id'
    or coalesce(source,'') not in ('public_purchase_intent','sales_assisted')
    or (source='public_purchase_intent' and o->>'payment_option'<>'prepaid')
    or a->>'membership_tier' is distinct from o->>'plan_key'
    or v->>'membership_tier' is distinct from o->>'plan_key'
    or i->>'selected_plan_key' is distinct from o->>'plan_key'
    or v->'commitment_months' is distinct from o->'commitment_months'
    or v->>'payment_option' is distinct from o->>'payment_option'
    or v->>'pricing_version' is distinct from o->>'offer_version'
  then raise exception using errcode='22023', message='retail_terms_source_mismatch'; end if;
  b := p->>'billing_cadence';
  if a->>'billing_option' is distinct from b or v->>'billing_option' is distinct from b
    or i->>'selected_billing_cadence' is distinct from b
    or (v->>'platform_fee')::numeric is distinct from (p->>'platform_fee')::numeric
    or (v->>'per_role_fee')::numeric is distinct from (p->>'per_role_fee')::numeric
    or (v->>'additional_interview_fee')::numeric is distinct from (p->>'additional_interview_fee')::numeric
    or (v->>'included_interviews_per_role')::numeric is distinct from (p->>'included_interviews_per_role')::numeric
    or (v->>'max_interview_minutes')::numeric is distinct from (p->>'max_interview_minutes')::numeric
    or v->'first_role_prepay'->'selected' is distinct from role->'selected'
    or i->'first_role_prepay_selected' is distinct from role->'selected'
  then raise exception using errcode='22023', message='retail_terms_source_mismatch'; end if;
  if (role->>'selected')::boolean and (
    (v->'first_role_prepay'->>'discounted_credit_amount_cents')::numeric is distinct from (role->>'amount_cents')::numeric
    or (v->'first_role_prepay'->>'normal_role_fee_cents')::numeric is distinct from (role->>'normal_role_fee_cents')::numeric
    or v->'first_role_prepay'->>'credit_type' is distinct from 'first_role_prepay'
    or i->'first_role_prepay_amount_cents' is distinct from role->'amount_cents'
    or i->'first_role_normal_role_fee_cents' is distinct from role->'normal_role_fee_cents'
    or i->'first_role_prepay_discount_percent' is distinct from '10'::jsonb
    or i->>'first_role_prepay_credit_type' is distinct from 'first_role_prepay')
  then raise exception using errcode='22023', message='retail_role_source_mismatch'; end if;
  return (o->>'commitment_months')::integer;
end $$;

revoke all on function public.retail_existing_month_anchor(timestamptz,integer),
  public.retail_existing_valid_offer(jsonb), public.retail_existing_closed_object(jsonb,text[]),
  public.retail_existing_package(jsonb), public.retail_existing_terms_months(jsonb,jsonb)
  from public, anon, authenticated;
grant execute on function public.retail_existing_month_anchor(timestamptz,integer),
  public.retail_existing_valid_offer(jsonb), public.retail_existing_closed_object(jsonb,text[]),
  public.retail_existing_package(jsonb), public.retail_existing_terms_months(jsonb,jsonb)
  to service_role;

-- Assert known CHECK source before changing it. Drift rolls back the ENTIRE
-- migration, including helper DDL. No legacy rows or privileges are changed.
do $migration$
declare spec text[]; specs text[][] := array[
  array['public','client_plan_settings','client_plan_settings_billing_interval_check','billing_interval'],
  array['public','membership_agreements','membership_agreements_billing_option_check','billing_option'],
  array['public','retail_signup_email_verifications','retail_signup_email_verifications_billing_cadence_check','billing_cadence'],
  array['private_auth','retail_signup_sms_verifications','retail_signup_sms_verifications_billing_cadence_check','billing_cadence']];
  definition text; expected text;
begin
  foreach spec slice 1 in array specs loop
    select pg_get_constraintdef(oid) into definition from pg_constraint
      where conrelid=to_regclass(format('%I.%I',spec[1],spec[2])) and conname=spec[3] and contype='c';
    expected := format('CHECK ((%s = ANY (ARRAY[''monthly''::text, ''annual''::text])))',spec[4]);
    if definition is distinct from expected then raise exception 'retail_cadence_constraint_source_drift: %',spec[3]; end if;
    execute format('alter table %I.%I drop constraint %I',spec[1],spec[2],spec[3]);
    execute format('alter table %I.%I add constraint %I %s',spec[1],spec[2],spec[3],
      replace(definition,'ARRAY[''monthly''::text, ''annual''::text]','ARRAY[''monthly''::text, ''annual''::text, ''prepaid''::text]'));
  end loop;
end $migration$;

-- Controlled patches retain each entire existing writer, all lock/protocol/
-- lease/source/digest/fee/role/member/welcome guards and original service grants.
do $migration$
declare signatures text[] := array[
  'public.complete_public_purchase_activation(uuid,text,timestamp with time zone,text,uuid,boolean,text,text,date,date)',
  'public.apply_public_purchase_billing(uuid,text,uuid,uuid,text,text,text,text,text,text,timestamp with time zone,boolean,boolean,timestamp with time zone,timestamp with time zone,timestamp with time zone,numeric,numeric,integer,numeric,integer,boolean,text,integer,integer,integer,boolean,boolean)'];
  sig text; definition text; marker text; addition text; assignment text; assignments text[];
  decl text := '  v_now timestamptz;';
  cadence text := 'or p_billing_interval not in (''monthly'', ''annual'')';
begin
  foreach sig in array signatures loop
    select pg_get_functiondef(to_regprocedure(sig)) into definition;
    if definition is null
      or (length(definition)-length(replace(definition,decl,'')))/length(decl) <> 1
      or (length(definition)-length(replace(definition,cadence,'')))/length(cadence) <> 1
    then raise exception 'retail_activation_writer_source_drift: %',sig; end if;
    if sig like 'public.complete_%' then
      assignments := array[
        'checkout_paid_at = coalesce(checkout_paid_at, p_paid_at),',
        'activated_at = coalesce(activated_at, v_agreement.checkout_paid_at, p_paid_at),',
        E'when checkout_paid_at is null and v_intent.term_start_basis = ''successful_payment''\n        then p_term_start else initial_term_start end,',
        E'when checkout_paid_at is null and v_intent.term_start_basis = ''successful_payment''\n        then p_renewal_date else initial_renewal_date end,'];
    else
      assignments := array['contract_start_at = p_contract_start_at,','contract_end_at = p_contract_end_at',
        'billing_interval = p_billing_interval,',
        E'p_client_id, p_plan_tier, p_billing_interval, p_platform_fee,\n    p_per_role_fee, p_included_interviews_per_role, p_additional_interview_fee,\n    p_max_interview_minutes'];
    end if;
    foreach assignment in array assignments loop
      if (length(definition)-length(replace(definition,assignment,'')))/length(assignment) <> 1
      then raise exception 'retail_activation_assignment_source_drift: %',sig; end if;
    end loop;
    definition := replace(definition,decl,decl||E'\n  v_retail_months integer;\n  v_retail_anchor timestamptz;');
    definition := replace(definition,cadence,'or p_billing_interval not in (''monthly'', ''annual'', ''prepaid'')');
    if sig like 'public.complete_%' then
      marker := '  if p_paid_at is null or not isfinite(p_paid_at)';
      addition := $checks$
  v_retail_months := public.retail_existing_terms_months(to_jsonb(v_agreement),to_jsonb(v_intent));
  if v_retail_months > 0 then
    if (v_agreement.checkout_paid_at is null) <> (v_intent.activated_at is null)
      or v_agreement.checkout_paid_at is distinct from v_intent.activated_at
    then raise exception using errcode='22023', message='retail_original_clock_mismatch'; end if;
    v_retail_anchor := coalesce(v_agreement.checkout_paid_at,p_paid_at);
    -- FIRST completion initializes both clocks only through existing atomic
    -- writes below. Caller must prove first full invoice/charge settlement and
    -- supply invoice.status_transitions.paid_at, NOT event.created/metadata/now.
    if v_retail_anchor is null or not isfinite(v_retail_anchor)
      or p_paid_at is distinct from v_retail_anchor
      or (v_agreement.checkout_paid_at is null and v_intent.status <> 'checkout_pending')
      or v_agreement.signed_at is null or v_retail_anchor < v_agreement.signed_at
      or v_agreement.agreement_expires_at is null or v_retail_anchor >= v_agreement.agreement_expires_at
      or v_intent.expires_at is null or v_retail_anchor >= v_intent.expires_at
      or p_term_start is distinct from (v_retail_anchor at time zone 'UTC')::date
      or p_renewal_date is distinct from (public.retail_existing_month_anchor(v_retail_anchor,v_retail_months) at time zone 'UTC')::date
    then raise exception using errcode='22023', message='retail_original_term_mismatch'; end if;
  end if;
$checks$;
    else
      marker := '  if p_plan_tier not in (''basic'', ''pro'')';
      addition := $checks$
  v_retail_months := public.retail_existing_terms_months(to_jsonb(v_agreement),to_jsonb(v_intent));
  if v_retail_months > 0 then
    if v_agreement.checkout_paid_at is null or v_intent.activated_at is null
      or v_agreement.checkout_paid_at is distinct from v_intent.activated_at
    then raise exception using errcode='22023', message='retail_original_clock_mismatch'; end if;
    v_retail_anchor := v_agreement.checkout_paid_at;
    if p_contract_start_at is distinct from v_retail_anchor
      or p_contract_end_at is distinct from public.retail_existing_month_anchor(v_retail_anchor,v_retail_months)
    then raise exception using errcode='22023', message='retail_original_term_mismatch'; end if;
  end if;
$checks$;
    end if;
    if (length(definition)-length(replace(definition,marker,'')))/length(marker) <> 1
    then raise exception 'retail_activation_writer_source_drift: %',sig; end if;
    definition := replace(definition,marker,addition||marker);
    execute definition;
    -- Existing completion uses p_paid_at/p_term_start/p_renewal_date directly:
    -- checkout_paid_at=coalesce(checkout_paid_at,p_paid_at), intent activated_at
    -- same original value, dates only initial successful_payment. Existing
    -- billing uses the checked p_contract_start/end and exact saved-fee args.
    -- No later now()/12-month/annual-derived overwrite is introduced here.
  end loop;
end $migration$;
commit;

