-- LOCAL UNMOUNTED admin client-write primitive only. Original JS/Auth/settings/
-- credit flow unchanged until the remaining atomic billing tail is reviewed.
begin;
set local lock_timeout='10s';
do $baseline$
declare s text[];p record;
begin
 if exists(select 1 from pg_proc proc join pg_namespace n on n.oid=proc.pronamespace
  where n.nspname='public' and proc.proname='apply_retail_existing_admin_client')
  then raise exception 'retail_admin_client_schema_drift';end if;
 foreach s slice 1 in array array[
  array['retail_existing_funding_schema_guard()','abfab9e6f97d88c8aa940b8a993db42b','s'],
  array['retail_existing_funding_receipt_valid(jsonb,jsonb)','655f4866f0cf52144c3abf76bc02ac94','i'],
  array['retail_existing_checkout_material(jsonb,jsonb,text)','67699a36b8267739c5655764a7c0203f','i'],
  array['retail_existing_checkout_config_valid(jsonb)','c433714eff703c41b1590f890dc8ba7d','i'],
  array['retail_existing_funding_intent_clock_guard()','233e1a57194963359b8644cc86724ffa','v']] loop
  select * into p from pg_proc where oid=to_regprocedure('public.'||s[1]);
  if not found or md5(p.prosrc) is distinct from s[2] or p.prosecdef or p.provolatile::text<>s[3]
   or p.proconfig is distinct from array['search_path=pg_catalog']
   or p.proowner is distinct from (select oid from pg_roles where rolname='postgres')
   or not has_function_privilege('service_role',p.oid,'EXECUTE')
   or exists(select 1 from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner)))
    where grantee not in(p.proowner,(select oid from pg_roles where rolname='service_role')))
   then raise exception 'retail_admin_client_prerequisite_drift';end if;
 end loop;
 select * into p from pg_proc where oid=to_regprocedure('public.retail_existing_month_anchor(timestamptz,integer)');
 if not found or md5(p.prosrc) is distinct from '215a4af8ed5457b66f11e6234f7f5741' or p.prosecdef
  or p.provolatile<>'i' or not p.proisstrict or p.proconfig is distinct from array['search_path=pg_catalog, public']
  or p.proowner is distinct from (select oid from pg_roles where rolname='postgres')
  or not has_function_privilege('service_role',p.oid,'EXECUTE')
  or exists(select 1 from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner)))
   where grantee not in(p.proowner,(select oid from pg_roles where rolname='service_role')))
  then raise exception 'retail_admin_client_anchor_drift';end if;
 if not exists(select 1 from pg_trigger where tgrelid='public.public_purchase_intents'::regclass
  and tgname='retail_existing_funding_intent_clock_guard' and tgfoid='public.retail_existing_funding_intent_clock_guard()'::regprocedure
  and tgenabled='O' and tgtype=23 and not tgisinternal)
  then raise exception 'retail_admin_client_trigger_drift';end if;
 perform public.retail_existing_funding_schema_guard();
end $baseline$;

-- No FK from public_purchase_intents.agreement_id exists in the actual baseline.
-- Protect sealed admin/no-intent source against a concurrent phantom link by
-- using its existing intent BEFORE trigger: intent row -> agreement SHARE.
-- Native admin owns agreement UPDATE, so an insert/link waits then refuses.
do $link_patch$
declare p record;needle text;body text;
begin
 select * into p from pg_proc where oid='public.retail_existing_funding_intent_clock_guard()'::regprocedure;
 needle:=E' if new.activated_at is null then return new;end if;';
 if array_length(string_to_array(p.prosrc,needle),1)<>2 then raise exception 'retail_admin_client_patch_drift';end if;
 body:=replace(p.prosrc,needle,$insert$
 if new.agreement_id is not null and (TG_OP='INSERT' or old.agreement_id is distinct from new.agreement_id) then
  perform 1 from public.membership_agreements where id=new.agreement_id for share;
  if exists(select 1 from public.membership_agreements where id=new.agreement_id
    and template_version='membership_agreement_retail_terms_v2'
    and checkout_attempt_source is not null and checkout_attempt_source->'intent'='null'::jsonb)
    then raise exception 'retail_admin_client_intent_link_denied';end if;
 end if;
$insert$||needle);
 execute replace(pg_get_functiondef(p.oid),p.prosrc,body);
end $link_patch$;

create function public.apply_retail_existing_admin_client(p_agreement uuid,p_client uuid,p_source jsonb,p_funding jsonb,p_initial jsonb,p_subscription jsonb)
returns jsonb language plpgsql volatile security invoker set search_path=pg_catalog set lock_timeout='10s' as $$
declare a public.membership_agreements;c public.clients;proof jsonb;offer jsonb;expected jsonb;actual jsonb;field text;
 clock timestamptz;start_at timestamptz;end_at timestamptz;period_at timestamptz;
begin
 if current_user<>'service_role' then raise exception 'retail_admin_client_server_only';end if;
 if not exists(select 1 from pg_trigger where tgrelid='public.public_purchase_intents'::regclass
  and tgname='retail_existing_funding_intent_clock_guard' and tgfoid='public.retail_existing_funding_intent_clock_guard()'::regprocedure
  and tgenabled='O' and tgtype=23 and not tgisinternal)
  then raise exception 'retail_admin_client_trigger_drift';end if;
 perform public.retail_existing_funding_schema_guard();
 select * into a from public.membership_agreements where id=p_agreement for update;
 if not found or a.client_id is distinct from p_client or a.template_version is distinct from 'membership_agreement_retail_terms_v2'
  or a.retail_funding_receipt is null or a.retail_funding_receipt is distinct from p_funding
  or a.checkout_attempt_source is distinct from p_source or p_source->'intent' is distinct from 'null'::jsonb
  or exists(select 1 from public.public_purchase_intents where agreement_id=a.id)
  then raise exception 'retail_admin_client_source_denied';end if;
 select * into c from public.clients where id=p_client for update;
 perform 1 from public.billing_customers where stripe_customer_id=p_source->>'customer_id' order by id for share;
 perform public.retail_existing_funding_schema_guard();clock:=clock_timestamp();
 proof:=p_funding->'proof';offer:=a.template_snapshot->'package_snapshot'->'membership_terms';
 if a.status is null or a.status not in('signed','active') or a.is_current is distinct from true
  or a.superseded_at is not null or a.superseded_by_agreement_id is not null or a.voided_at is not null
  or a.checkout_status is distinct from 'paid'
  or not coalesce(public.retail_existing_funding_receipt_valid(p_funding,p_source),false)
  or a.checkout_paid_at is distinct from(proof->'period'->>'paid_at')::timestamptz
  or a.checkout_session_id is distinct from proof->'period'->>'checkout_session_id'
  or a.checkout_created_at is null or not isfinite(a.checkout_created_at) or a.checkout_created_at>clock
  or a.checkout_embedded is null or(p_funding->>'recorded_at')::timestamptz>clock
  or public.retail_existing_checkout_material(to_jsonb(a),null,c.stripe_customer_id) is distinct from p_source-'config'
  or not coalesce(public.retail_existing_checkout_config_valid(p_source->'config'),false)
  then raise exception 'retail_admin_client_source_denied';end if;
 if c.id is null or c.parent_client_id is not null or c.archived_at is not null
  or c.stripe_customer_id is distinct from proof->'period'->>'customer_id'
  or(select count(*) from public.billing_customers where stripe_customer_id=c.stripe_customer_id)<>1
  or not exists(select 1 from public.billing_customers where stripe_customer_id=c.stripe_customer_id and client_id=c.id)
  or(c.stripe_subscription_id is not null and c.stripe_subscription_id is distinct from proof->'period'->>'subscription_id')
  then raise exception 'retail_admin_client_owner_denied';end if;
 start_at:=(proof->'period'->>'paid_at')::timestamptz;
 end_at:=public.retail_existing_month_anchor(start_at,(offer->>'commitment_months')::integer);
 period_at:=to_timestamp((proof->'period'->>'provider_period_end')::bigint);
 if start_at is null or end_at is null or period_at is null or not isfinite(start_at) or not isfinite(end_at) or not isfinite(period_at)
  or end_at<=start_at or period_at<=clock then raise exception 'retail_admin_client_paid_period_ended';end if;
 -- A future trusted SDK adapter must pass this explicit current subscription
 -- projection; the old client builder's inactive->active fallback is NOT proof.
 -- Only the original receipt's paid period may initialize this primitive.
 if p_subscription is distinct from jsonb_build_object('id',proof->'period'->'subscription_id','customer',proof->'period'->'customer_id',
  'status','active','current_period_end',(proof->'period'->>'provider_period_end')::bigint,'cancel_at_period_end',false)
  then raise exception 'retail_admin_client_subscription_denied';end if;
 expected:=jsonb_build_object('stripe_customer_id',proof->'period'->'customer_id','stripe_subscription_id',proof->'period'->'subscription_id',
  'subscription_status','active','billing_status','active','billing_interval',a.billing_option,'plan_tier',a.membership_tier,
  'current_term_end',to_char(period_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'cancel_at_term_end',false,'auto_renew',true,'cancel_effective_at',null,
  'contract_start_at',to_char(start_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'contract_end_at',to_char(end_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
 if p_initial is distinct from expected then raise exception 'retail_admin_client_payload_denied';end if;
 actual:=to_jsonb(c);
 foreach field in array array['current_term_end','contract_start_at','contract_end_at'] loop
  actual:=jsonb_set(actual,array[field],coalesce(to_jsonb(to_char((actual->>field)::timestamptz at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),'null'::jsonb));
 end loop;
 if c.contract_start_at is not null or c.contract_end_at is not null or c.stripe_subscription_id is not null then
  for field in select jsonb_object_keys(expected) loop
   if actual->field is distinct from expected->field then raise exception 'retail_admin_client_existing_state_conflict';end if;
  end loop;
  -- CLIENT tuple no-op only, not proof of settings/credit/Auth completion.
  return jsonb_build_object('status','already_applied','client_initial',expected);
 end if;
 update public.clients set stripe_customer_id=expected->>'stripe_customer_id',stripe_subscription_id=expected->>'stripe_subscription_id',
  subscription_status='active',billing_status='active',billing_interval=a.billing_option,plan_tier=a.membership_tier,
  current_term_end=period_at,cancel_at_term_end=false,auto_renew=true,cancel_effective_at=null,
  contract_start_at=start_at,contract_end_at=end_at where id=c.id;
 if not found then raise exception 'retail_admin_client_write_failed';end if;
 return jsonb_build_object('status','applied','client_initial',expected);
end $$;
revoke all on function public.apply_retail_existing_admin_client(uuid,uuid,jsonb,jsonb,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.apply_retail_existing_admin_client(uuid,uuid,jsonb,jsonb,jsonb,jsonb) to service_role;
commit;
