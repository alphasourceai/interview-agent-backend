-- LOCAL UNMOUNTED: reuse original retail client/settings/role-credit structures.
-- A native once receipt is billing completion, NOT Auth/delivery/renewal/access.
begin;
set local lock_timeout='10s';
do $baseline$
begin
 if exists(select 1 from pg_attribute where attrelid='public.membership_agreements'::regclass
  and attname='retail_admin_billing_receipt' and not attisdropped)
  or exists(select 1 from pg_proc proc join pg_namespace ns on ns.oid=proc.pronamespace
   where ns.nspname='public' and proc.proname in('retail_admin_existing_billing_schema_guard',
    'retail_admin_existing_billing_initial','retail_admin_existing_billing_receipt_valid',
    'retail_admin_existing_billing_context','retail_admin_existing_billing_rows_match',
    'retail_admin_existing_billing_guard','retail_admin_existing_billing_commit_guard','apply_retail_existing_admin_billing'))
  or exists(select 1 from pg_trigger where tgrelid='public.membership_agreements'::regclass
   and tgname in('retail_admin_existing_billing_guard','retail_admin_existing_billing_commit_guard'))
  then raise exception 'retail_admin_billing_schema_drift';end if;
end $baseline$;

create function public.retail_admin_existing_billing_schema_guard()
returns void language plpgsql stable security invoker set search_path=pg_catalog as $$
declare spec text[];meta record;tbl oid;
begin
 perform public.retail_existing_funding_schema_guard();
 foreach spec slice 1 in array array[
  array['apply_retail_existing_admin_client(uuid,uuid,jsonb,jsonb,jsonb,jsonb)','f6092d3b6212899ea914d43ff7531047','v','lock'],
  array['read_retail_existing_funding(uuid,uuid,text,jsonb)','9b3e6f1279d2473a33296a7f3180e98a','v','lock'],
  array['retail_existing_funding_schema_guard()','abfab9e6f97d88c8aa940b8a993db42b','s',''],
  array['retail_existing_funding_receipt_valid(jsonb,jsonb)','655f4866f0cf52144c3abf76bc02ac94','i',''],
  array['retail_existing_package(jsonb)','139a00920503f466304e89ac4bb934bb','i','public'],
  array['retail_existing_valid_offer(jsonb)','acd2d5e1e15c32bfb20e4d0f3439ffcb','i','public'],
  array['retail_existing_month_anchor(timestamptz,integer)','215a4af8ed5457b66f11e6234f7f5741','i','public'],
  array['retail_existing_closed_object(jsonb,text[])','db187b3a1816eff7f3c2bac7b739fb60','i',''],
  array['retail_existing_checkout_material(jsonb,jsonb,text)','67699a36b8267739c5655764a7c0203f','i',''],
  array['retail_existing_checkout_config_valid(jsonb)','c433714eff703c41b1590f890dc8ba7d','i',''],
  array['retail_existing_funding_intent_clock_guard()','87aea421d94d5714532486c4b47c7434','v','']] loop
  select * into meta from pg_proc where oid=to_regprocedure('public.'||spec[1]);
  if not found or md5(meta.prosrc) is distinct from spec[2] or meta.prosecdef or meta.provolatile::text<>spec[3]
   or meta.proisstrict is distinct from(spec[1]='retail_existing_month_anchor(timestamptz,integer)')
   or meta.proconfig is distinct from(case when spec[4]='lock' then array['search_path=pg_catalog','lock_timeout=10s']
    when spec[4]='public' then array['search_path=pg_catalog, public'] else array['search_path=pg_catalog'] end)
   or meta.proowner is distinct from(select oid from pg_roles where rolname='postgres')
   or not has_function_privilege('service_role',meta.oid,'EXECUTE')
   or exists(select 1 from aclexplode(coalesce(meta.proacl,acldefault('f',meta.proowner)))
    where grantee not in(meta.proowner,(select oid from pg_roles where rolname='service_role')))
   then raise exception 'retail_admin_billing_prerequisite_drift';end if;
 end loop;
 if not exists(select 1 from pg_trigger where tgrelid='public.public_purchase_intents'::regclass
  and tgname='retail_existing_funding_intent_clock_guard' and not tgisinternal and tgenabled='O' and tgtype=23
  and tgfoid='public.retail_existing_funding_intent_clock_guard()'::regprocedure)
  then raise exception 'retail_admin_billing_trigger_drift';end if;
 foreach tbl in array array['public.client_plan_settings'::regclass::oid,'public.client_role_credits'::regclass::oid] loop
  if not has_table_privilege('service_role',tbl,'SELECT') or not has_table_privilege('service_role',tbl,'UPDATE')
   or not has_table_privilege('service_role',tbl,'INSERT')
   or not exists(select 1 from pg_class where oid=tbl and relrowsecurity)
   then raise exception 'retail_admin_billing_schema_drift';end if;
 end loop;
 if not exists(select 1 from pg_index where indexrelid=to_regclass('public.client_plan_settings_client_id_key')
   and indrelid='public.client_plan_settings'::regclass and indisunique and indisvalid and indisready and indislive and indimmediate
   and pg_get_indexdef(indexrelid)='CREATE UNIQUE INDEX client_plan_settings_client_id_key ON public.client_plan_settings USING btree (client_id)')
  or not exists(select 1 from pg_index where indexrelid=to_regclass('public.client_role_credits_source_stripe_checkout_session_uidx')
   and indrelid='public.client_role_credits'::regclass and indisunique and indisvalid and indisready and indislive and indimmediate
   and pg_get_indexdef(indexrelid)='CREATE UNIQUE INDEX client_role_credits_source_stripe_checkout_session_uidx ON public.client_role_credits USING btree (source_stripe_checkout_session_id) WHERE (source_stripe_checkout_session_id IS NOT NULL)')
  then raise exception 'retail_admin_billing_schema_drift';end if;
end $$;
revoke all on function public.retail_admin_existing_billing_schema_guard() from public,anon,authenticated;
grant execute on function public.retail_admin_existing_billing_schema_guard() to service_role;
select public.retail_admin_existing_billing_schema_guard();

alter table public.membership_agreements add column retail_admin_billing_receipt jsonb;

create function public.retail_admin_existing_billing_initial(src jsonb,funding jsonb,sub jsonb,model text,rollover integer)
returns jsonb language plpgsql immutable security invoker set search_path=pg_catalog as $$
declare pkg jsonb:=src->'template_snapshot'->'package_snapshot';offer jsonb:=pkg->'membership_terms';
 proof jsonb:=funding->'proof';start_at timestamptz;end_at timestamptz;period_at timestamptz;ci jsonb;pi jsonb;ri jsonb;
begin
 if not coalesce(public.retail_existing_funding_receipt_valid(funding,src),false)
  or src->'intent' is distinct from 'null'::jsonb or pkg is distinct from public.retail_existing_package(offer)
  or coalesce(src->'template_snapshot'->>'source','admin')<>'admin'
  or sub is distinct from jsonb_build_object('id',proof->'period'->'subscription_id','customer',proof->'period'->'customer_id',
   'status','active','current_period_end',(proof->'period'->>'provider_period_end')::bigint,'cancel_at_period_end',false)
  or model is null or model not in('fixed','rollover','usage') or rollover is null or rollover<1
  or(offer->>'billing_model'='rollover' and rollover is distinct from(offer->>'rollover_days')::integer)
  then raise exception 'retail_admin_billing_projection_denied';end if;
 start_at:=(proof->'period'->>'paid_at')::timestamptz;
 end_at:=public.retail_existing_month_anchor(start_at,(offer->>'commitment_months')::integer);
 period_at:=to_timestamp((proof->'period'->>'provider_period_end')::bigint);
 ci:=jsonb_build_object('stripe_customer_id',proof->'period'->'customer_id','stripe_subscription_id',proof->'period'->'subscription_id',
  'subscription_status','active','billing_status','active','billing_interval',src->'billing_option','plan_tier',src->'membership_tier',
  'current_term_end',to_char(period_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'cancel_at_term_end',false,'auto_renew',true,'cancel_effective_at',null,
  'contract_start_at',to_char(start_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'contract_end_at',to_char(end_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
 pi:=jsonb_build_object('client_id',src->'client_id','plan_tier',src->'membership_tier','billing_interval',src->'billing_option',
  'platform_fee',pkg->'platform_fee','per_role_fee',pkg->'per_role_fee','included_interviews_per_role',pkg->'included_interviews_per_role',
  'additional_interview_fee',pkg->'additional_interview_fee','max_interview_minutes',pkg->'max_interview_minutes',
  'scored_question_count',pkg->'scored_question_count','billing_model',model,'rollover_days',rollover);
 ri:='null'::jsonb;
 if(offer->'first_role_prepay'->>'selected')::boolean then
  ri:=jsonb_build_object('billing_client_id',src->'client_id','source_client_id',src->'client_id','source_public_purchase_intent_id',null,
   'source_membership_agreement_id',src->'agreement_id','source_stripe_checkout_session_id',proof->'period'->'checkout_session_id',
   'credit_type','first_role_prepay','membership_key',src->'membership_tier','normal_role_fee_cents',pkg->'first_role_prepay'->'normal_role_fee_cents',
   'discounted_credit_amount_cents',pkg->'first_role_prepay'->'discounted_credit_amount_cents','discount_percent',pkg->'first_role_prepay'->'discount_percent',
   'status','unused','used_at',null,'used_by_role_id',null,
   'metadata',jsonb_build_object('source','public_purchase_activation','non_refundable',pkg->'first_role_prepay'->'non_refundable',
    'expires',pkg->'first_role_prepay'->'expires','purchase_intent_id',null,'membership_agreement_id',src->'agreement_id'),
   'created_at',proof->'period'->'paid_at','updated_at',proof->'period'->'paid_at');
 end if;
 return jsonb_build_object('client_initial',ci,'plan_initial',pi,'credit_initial',ri);
end $$;

create function public.retail_admin_existing_billing_receipt_valid(w jsonb,src jsonb,funding jsonb)
returns boolean language plpgsql immutable security invoker set search_path=pg_catalog as $$
declare expected jsonb;stamp timestamptz;
begin
 if not coalesce(public.retail_existing_closed_object(w,array['version','source','funding_receipt','subscription',
  'client_initial','plan_initial','credit_initial','credit_id','applied_at']),false)
  or w->>'version' is distinct from 'retail_admin_existing_billing_v1' or w->'source' is distinct from src
  or w->'funding_receipt' is distinct from funding or jsonb_typeof(w->'applied_at') is distinct from 'string'
  or jsonb_typeof(w->'plan_initial'->'rollover_days') is distinct from 'number'
  or w->'plan_initial'->>'rollover_days' !~ '^[0-9]+$' then return false;end if;
 expected:=public.retail_admin_existing_billing_initial(src,funding,w->'subscription',w->'plan_initial'->>'billing_model',
  (w->'plan_initial'->>'rollover_days')::integer);
 if w->'client_initial' is distinct from expected->'client_initial' or w->'plan_initial' is distinct from expected->'plan_initial'
  or w->'credit_initial' is distinct from expected->'credit_initial' then return false;end if;
 if expected->'credit_initial'='null'::jsonb then
  if w->'credit_id' is distinct from 'null'::jsonb then return false;end if;
 elsif jsonb_typeof(w->'credit_id') is distinct from 'string' or w->>'credit_id' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  then return false;end if;
 stamp:=(w->>'applied_at')::timestamptz;
 return isfinite(stamp) and stamp>=(funding->>'recorded_at')::timestamptz;
exception when others then return false;
end $$;

create function public.retail_admin_existing_billing_context(a public.membership_agreements)
returns void language plpgsql volatile security invoker set search_path=pg_catalog as $$
declare r jsonb;c public.clients;
begin
 perform public.retail_admin_existing_billing_schema_guard();
 if a.id is null or a.template_version is distinct from 'membership_agreement_retail_terms_v2'
  or coalesce(a.template_snapshot->>'source','admin')<>'admin'
  or a.checkout_attempt_source->'intent' is distinct from 'null'::jsonb
  or a.status is null or a.status not in('signed','active') or a.is_current is distinct from true
  or a.superseded_at is not null or a.superseded_by_agreement_id is not null or a.voided_at is not null
  or a.checkout_status is distinct from 'paid' or a.retail_funding_receipt is null
  or exists(select 1 from public.public_purchase_intents where agreement_id=a.id)
  then raise exception 'retail_admin_billing_source_denied';end if;
 r:=public.read_retail_existing_funding(a.id,a.client_id,null,a.checkout_attempt_source);
 if r->>'phase' is distinct from 'paid' or r->'receipt' is distinct from a.retail_funding_receipt
  or a.checkout_paid_at is distinct from(a.retail_funding_receipt->'proof'->'period'->>'paid_at')::timestamptz
  or a.checkout_session_id is distinct from a.retail_funding_receipt->'proof'->'period'->>'checkout_session_id'
  then raise exception 'retail_admin_billing_source_denied';end if;
 select * into c from public.clients where id=a.client_id;
 if public.retail_existing_checkout_material(to_jsonb(a),null,c.stripe_customer_id) is distinct from a.checkout_attempt_source-'config'
  or(a.retail_admin_billing_receipt is not null and c.stripe_subscription_id is distinct from a.retail_funding_receipt->'proof'->'period'->>'subscription_id')
  then raise exception 'retail_admin_billing_owner_denied';end if;
end $$;

create function public.retail_admin_existing_billing_rows_match(a public.membership_agreements,w jsonb)
returns boolean language plpgsql stable security invoker set search_path=pg_catalog as $$
declare actual jsonb;field text;credit public.client_role_credits;
begin
 select to_jsonb(c) into actual from public.clients c where id=a.client_id;
 foreach field in array array['contract_start_at','contract_end_at','current_term_end'] loop
  actual:=jsonb_set(actual,array[field],coalesce(to_jsonb(to_char((actual->>field)::timestamptz at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),'null'::jsonb));
 end loop;
 for field in select jsonb_object_keys(w->'client_initial') loop
  if actual->field is distinct from w->'client_initial'->field then return false;end if;
 end loop;
 select to_jsonb(p) into actual from public.client_plan_settings p where client_id=a.client_id;
 for field in select jsonb_object_keys(w->'plan_initial') loop
  if actual->field is distinct from w->'plan_initial'->field then return false;end if;
 end loop;
 if w->'credit_initial'='null'::jsonb then
  return not exists(select 1 from public.client_role_credits where source_membership_agreement_id=a.id
   or source_stripe_checkout_session_id=a.checkout_session_id);
 end if;
 if(select count(*) from public.client_role_credits where source_membership_agreement_id=a.id
  or source_stripe_checkout_session_id=a.checkout_session_id)<>1 then return false;end if;
 select * into credit from public.client_role_credits where id=(w->>'credit_id')::uuid;
 if not found then return false;end if;actual:=to_jsonb(credit);
 foreach field in array array['created_at','updated_at'] loop
  actual:=jsonb_set(actual,array[field],to_jsonb(to_char((actual->>field)::timestamptz at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')));
 end loop;
 for field in select jsonb_object_keys(w->'credit_initial') loop
  if actual->field is distinct from w->'credit_initial'->field then return false;end if;
 end loop;
 return true;
end $$;

create function public.retail_admin_existing_billing_guard()
returns trigger language plpgsql volatile security invoker set search_path=pg_catalog as $$
declare w jsonb;clock timestamptz;
begin
 if TG_OP='DELETE' then if old.retail_admin_billing_receipt is not null then raise exception 'retail_admin_billing_immutable';end if;return old;end if;
 if TG_OP='INSERT' then if new.retail_admin_billing_receipt is not null then raise exception 'retail_admin_billing_record_required';end if;return new;end if;
 if old.retail_admin_billing_receipt is not null then
  if new.retail_admin_billing_receipt is distinct from old.retail_admin_billing_receipt then raise exception 'retail_admin_billing_immutable';end if;return new;
 end if;
 if new.retail_admin_billing_receipt is null then return new;end if;
 if current_user<>'service_role' or current_setting('private_sales.retail_admin_billing_writer',true) is distinct from new.id::text
  then raise exception 'retail_admin_billing_record_required';end if;
 perform public.retail_admin_existing_billing_context(new);
 w:=new.retail_admin_billing_receipt;
 if w->'applied_at' is distinct from 'null'::jsonb then raise exception 'retail_admin_billing_stamp_required';end if;
 clock:=clock_timestamp();w:=jsonb_set(w,'{applied_at}',to_jsonb(to_char(clock at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')));
 if not coalesce(public.retail_admin_existing_billing_receipt_valid(w,new.checkout_attempt_source,new.retail_funding_receipt),false)
  or(w->'subscription'->>'current_period_end')::bigint<=extract(epoch from clock)
  or not coalesce(public.retail_admin_existing_billing_rows_match(new,w),false)
  then raise exception 'retail_admin_billing_first_state_denied';end if;
 new.retail_admin_billing_receipt:=w;return new;
end $$;
create trigger retail_admin_existing_billing_guard before insert or update or delete on public.membership_agreements
 for each row execute function public.retail_admin_existing_billing_guard();

create function public.retail_admin_existing_billing_commit_guard()
returns trigger language plpgsql volatile security invoker set search_path=pg_catalog as $$
declare a public.membership_agreements;
begin
 if old.retail_admin_billing_receipt is not null or new.retail_admin_billing_receipt is null then return null;end if;
 select * into a from public.membership_agreements where id=new.id;
 perform public.retail_admin_existing_billing_context(a);
 if a.retail_admin_billing_receipt is distinct from new.retail_admin_billing_receipt
  or not coalesce(public.retail_admin_existing_billing_rows_match(a,new.retail_admin_billing_receipt),false)
  or(new.retail_admin_billing_receipt->'subscription'->>'current_period_end')::bigint<=extract(epoch from clock_timestamp())
  then raise exception 'retail_admin_billing_commit_state_denied';end if;return null;
end $$;
create constraint trigger retail_admin_existing_billing_commit_guard after update on public.membership_agreements
 deferrable initially deferred for each row execute function public.retail_admin_existing_billing_commit_guard();
alter table public.membership_agreements add constraint retail_admin_existing_billing_receipt_check check(
 retail_admin_billing_receipt is null or public.retail_admin_existing_billing_receipt_valid(retail_admin_billing_receipt,checkout_attempt_source,retail_funding_receipt));

create function public.apply_retail_existing_admin_billing(p_agreement uuid,p_client uuid,p_source jsonb,p_funding jsonb,p_initial jsonb,p_subscription jsonb)
returns jsonb language plpgsql volatile security invoker set search_path=pg_catalog set lock_timeout='10s' as $$
declare a public.membership_agreements;c public.clients;plan public.client_plan_settings;credit public.client_role_credits;
 expected jsonb;pi jsonb;ri jsonb;w jsonb;ack jsonb;model text;rollover integer;credit_id uuid;credit_count integer;actual jsonb;field text;
begin
 if current_user<>'service_role' then raise exception 'retail_admin_billing_server_only';end if;
 perform public.retail_admin_existing_billing_schema_guard();
 select * into a from public.membership_agreements where id=p_agreement for update;
 if not found or a.client_id is distinct from p_client or a.checkout_attempt_source is distinct from p_source
  or a.retail_funding_receipt is distinct from p_funding then raise exception 'retail_admin_billing_source_denied';end if;
 select * into c from public.clients where id=p_client for update;
 perform 1 from public.billing_customers where stripe_customer_id=p_source->>'customer_id' order by id for share;
 perform public.retail_admin_existing_billing_context(a);
 if a.retail_admin_billing_receipt is not null then
  w:=a.retail_admin_billing_receipt;
  if w->'source' is distinct from p_source or w->'funding_receipt' is distinct from p_funding
   or w->'subscription' is distinct from p_subscription or w->'client_initial' is distinct from p_initial
   or not coalesce(public.retail_admin_existing_billing_receipt_valid(w,p_source,p_funding),false)
   or(w->>'applied_at')::timestamptz>clock_timestamp() then raise exception 'retail_admin_billing_replay_conflict';end if;
  -- Historical billing completion ONLY, not current provider/access proof.
  -- No mutable settings/credit/client tuple checks or DML on this replay.
  return jsonb_build_object('status','already_applied','receipt',w);
 end if;
 select * into plan from public.client_plan_settings where client_id=c.id for update;
 perform 1 from public.client_role_credits where source_membership_agreement_id=a.id
  or source_stripe_checkout_session_id=a.checkout_session_id order by id for update;
 model:=coalesce(plan.billing_model,p_source->'template_snapshot'->'package_snapshot'->'membership_terms'->>'billing_model');
 rollover:=case when p_source->'template_snapshot'->'package_snapshot'->'membership_terms'->>'billing_model'='rollover'
  then(p_source->'template_snapshot'->'package_snapshot'->'membership_terms'->>'rollover_days')::integer else coalesce(plan.rollover_days,90) end;
 expected:=public.retail_admin_existing_billing_initial(p_source,p_funding,p_subscription,model,rollover);
 if expected->'client_initial' is distinct from p_initial then raise exception 'retail_admin_billing_payload_denied';end if;
 pi:=expected->'plan_initial';ri:=expected->'credit_initial';
 select count(*) into credit_count from public.client_role_credits where source_membership_agreement_id=a.id or source_stripe_checkout_session_id=a.checkout_session_id;
 if ri='null'::jsonb then
  if credit_count<>0 then raise exception 'retail_admin_billing_credit_conflict';end if;
 elsif credit_count>1 then raise exception 'retail_admin_billing_credit_conflict';
 elsif credit_count=1 then
  select * into credit from public.client_role_credits where source_membership_agreement_id=a.id or source_stripe_checkout_session_id=a.checkout_session_id;
  actual:=to_jsonb(credit);
  foreach field in array array['created_at','updated_at'] loop
   actual:=jsonb_set(actual,array[field],to_jsonb(to_char((actual->>field)::timestamptz at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')));
  end loop;
  for field in select jsonb_object_keys(ri) loop
   if actual->field is distinct from ri->field then raise exception 'retail_admin_billing_credit_conflict';end if;
  end loop;
  credit_id:=credit.id;
 end if;
 -- SAME original client primitive inside this transaction, after ALL waits.
 -- Its fresh native clock, owner/source/current-sub and exact tuple fence run
 -- before first DML. A later failure rolls this and all settings/credit back.
 ack:=public.apply_retail_existing_admin_client(p_agreement,p_client,p_source,p_funding,p_initial,p_subscription);
 if ack->>'status' not in('applied','already_applied') or ack->'client_initial' is distinct from p_initial
  then raise exception 'retail_admin_billing_client_ack_denied';end if;
 insert into public.client_plan_settings(client_id,plan_tier,billing_interval,platform_fee,per_role_fee,included_interviews_per_role,
  additional_interview_fee,max_interview_minutes,scored_question_count,billing_model,rollover_days)
 values(c.id,pi->>'plan_tier',pi->>'billing_interval',(pi->>'platform_fee')::numeric,(pi->>'per_role_fee')::numeric,
  (pi->>'included_interviews_per_role')::integer,(pi->>'additional_interview_fee')::numeric,(pi->>'max_interview_minutes')::integer,
  (pi->>'scored_question_count')::integer,pi->>'billing_model',(pi->>'rollover_days')::integer)
 on conflict(client_id) do update set plan_tier=excluded.plan_tier,billing_interval=excluded.billing_interval,
  platform_fee=excluded.platform_fee,per_role_fee=excluded.per_role_fee,included_interviews_per_role=excluded.included_interviews_per_role,
  additional_interview_fee=excluded.additional_interview_fee,max_interview_minutes=excluded.max_interview_minutes,
  scored_question_count=excluded.scored_question_count,billing_model=excluded.billing_model,rollover_days=excluded.rollover_days,updated_at=clock_timestamp();
 if ri<>'null'::jsonb and credit_id is null then
  insert into public.client_role_credits(billing_client_id,source_client_id,source_public_purchase_intent_id,source_membership_agreement_id,
   source_stripe_checkout_session_id,credit_type,membership_key,normal_role_fee_cents,discounted_credit_amount_cents,discount_percent,
   status,metadata,created_at,updated_at)
  values(c.id,c.id,null,a.id,a.checkout_session_id,ri->>'credit_type',ri->>'membership_key',(ri->>'normal_role_fee_cents')::integer,
   (ri->>'discounted_credit_amount_cents')::integer,(ri->>'discount_percent')::integer,'unused',ri->'metadata',
   (ri->>'created_at')::timestamptz,(ri->>'updated_at')::timestamptz) returning id into credit_id;
 end if;
 w:=jsonb_build_object('version','retail_admin_existing_billing_v1','source',p_source,'funding_receipt',p_funding,
  'subscription',p_subscription,'client_initial',p_initial,'plan_initial',pi,'credit_initial',ri,'credit_id',credit_id,'applied_at',null);
 perform set_config('private_sales.retail_admin_billing_writer',a.id::text,true);
 update public.membership_agreements set retail_admin_billing_receipt=w where id=a.id returning retail_admin_billing_receipt into w;
 if not found then raise exception 'retail_admin_billing_record_failed';end if;
 perform set_config('private_sales.retail_admin_billing_writer','',true);
 return jsonb_build_object('status','applied','receipt',w);
end $$;

revoke all on function public.retail_admin_existing_billing_initial(jsonb,jsonb,jsonb,text,integer),
 public.retail_admin_existing_billing_receipt_valid(jsonb,jsonb,jsonb),public.retail_admin_existing_billing_context(public.membership_agreements),
 public.retail_admin_existing_billing_rows_match(public.membership_agreements,jsonb),public.retail_admin_existing_billing_guard(),
 public.retail_admin_existing_billing_commit_guard(),public.apply_retail_existing_admin_billing(uuid,uuid,jsonb,jsonb,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.retail_admin_existing_billing_initial(jsonb,jsonb,jsonb,text,integer),
 public.retail_admin_existing_billing_receipt_valid(jsonb,jsonb,jsonb),public.retail_admin_existing_billing_context(public.membership_agreements),
 public.retail_admin_existing_billing_rows_match(public.membership_agreements,jsonb),public.retail_admin_existing_billing_guard(),
 public.retail_admin_existing_billing_commit_guard(),public.apply_retail_existing_admin_billing(uuid,uuid,jsonb,jsonb,jsonb,jsonb) to service_role;
commit;
