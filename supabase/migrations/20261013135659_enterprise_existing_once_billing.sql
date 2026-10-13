-- LOCAL, UNMOUNTED once-only billing on existing client/settings.
-- Not provider authentication, Auth delivery, agreement paid or pool release.
begin;
set local lock_timeout='10s';
do $baseline$
declare spec text[]; p record; x record;
begin
 foreach spec slice 1 in array array[
  array['enterprise_existing_funding_receipt_valid(jsonb,jsonb,jsonb)','0737dfd61db15300e835cabe44cf885b'],
  array['enterprise_existing_funding_context(public.membership_agreements)','84c7a3ff1fe1a4c08e2fb17983ed0c76'],
  array['enterprise_existing_funding_guard()','25d107b108fe853330325257fa2870d1'],
  array['record_enterprise_existing_funding(uuid,uuid,jsonb,jsonb,jsonb)','ab9fac2b59b65ea884c221f3a73d94f8'],
  array['enterprise_existing_pending_material(jsonb,jsonb,jsonb)','2b81b06a731c0711ad382c66c1e520c1'],
  array['enterprise_existing_pending_agreement_guard()','3b66f33ed9b06c128256eb5e7dea7ac7'],
  array['enterprise_existing_pending_pool_guard()','baeb4233953221be03c32114eb2c7ee6'],
  array['enterprise_existing_pending_pair_guard()','4e81301443662fc1f5bef56966b866e0'],
  array['enterprise_pool_v2_guard_pool()','5ec10701ca59c0c9fd6735a6f644c1a0'],
  array['enterprise_pool_v2_guard_source()','483cc416ab9ee7e3017f3ee8d0490daa']
 ] loop
  select * into p from pg_proc where oid=to_regprocedure('public.'||spec[1]);
  if not found or p.prosecdef or md5(p.prosrc)<>spec[2]
   or p.proconfig is distinct from(case when spec[1] like 'record_%' then array['search_path=pg_catalog','lock_timeout=10s'] else array['search_path=pg_catalog'] end)
   or has_function_privilege('anon',p.oid,'EXECUTE') or has_function_privilege('authenticated',p.oid,'EXECUTE')
   or not has_function_privilege('service_role',p.oid,'EXECUTE') then raise exception 'enterprise_billing_prerequisite_drift';end if;
 end loop;
 for x in select * from(values
  ('membership_agreements','enterprise_existing_pending_agreement_guard','enterprise_existing_pending_agreement_guard',31,false),
  ('client_interview_pools','enterprise_existing_pending_pool_guard','enterprise_existing_pending_pool_guard',31,false),
  ('membership_agreements','enterprise_existing_pending_agreement_pair','enterprise_existing_pending_pair_guard',21,true),
  ('client_interview_pools','enterprise_existing_pending_pool_pair','enterprise_existing_pending_pair_guard',21,true),
  ('client_interview_pools','enterprise_pool_v2_guard_pool','enterprise_pool_v2_guard_pool',31,false),
  ('membership_agreements','enterprise_pool_v2_guard_source','enterprise_pool_v2_guard_source',27,false)
 )t(tab,name,func,kind,deferred) loop
  if not exists(select 1 from pg_trigger where tgrelid=to_regclass('public.'||x.tab) and tgname=x.name and tgenabled='O'
   and tgtype=x.kind and tgfoid=to_regprocedure('public.'||x.func||'()') and tgdeferrable=x.deferred and tginitdeferred=x.deferred)
   then raise exception 'enterprise_billing_trigger_drift';end if;
 end loop;
 for x in select * from(values
  ('enterprise_funding_one_checkout','checkout_session_id'),('enterprise_funding_one_subscription','subscription_id'),
  ('enterprise_funding_one_invoice','invoice_id'),('enterprise_funding_one_pi','payment_intent_id'),
  ('enterprise_funding_one_charge','charge_id')
 )t(name,field) loop
  if not exists(select 1 from pg_index i where i.indexrelid=to_regclass('public.'||x.name)
   and i.indrelid='public.membership_agreements'::regclass and i.indisunique and i.indisvalid and i.indisready
   and i.indnkeyatts=3 and i.indnatts=3 and pg_get_expr(i.indpred,i.indrelid)='(enterprise_funding_receipt IS NOT NULL)'
   and regexp_replace(pg_get_expr(i.indexprs,i.indrelid),'[()[:space:]]','','g')=
    'enterprise_funding_receipt->''proof''::text->>''provider_account_id''::text,enterprise_funding_receipt->''proof''::text->>''livemode''::text,enterprise_funding_receipt->''proof''::text->>'''||x.field||'''::text')
   then raise exception 'enterprise_billing_cash_index_drift';end if;
 end loop;
 if exists(select 1 from pg_attribute where attrelid='public.client_plan_settings'::regclass
  and attname in('platform_fee','per_role_fee','additional_interview_fee') and atttypmod<>655366 and not attisdropped)
  then raise exception 'enterprise_billing_column_drift';end if;
 for x in select * from(values
  ('clients','billing_status','text',true),('clients','subscription_status','text',false),
  ('clients','plan_tier','text',false),('clients','billing_interval','text',false),
  ('clients','stripe_customer_id','text',false),('clients','stripe_subscription_id','text',false),
  ('clients','current_term_end','timestamptz',false),('clients','contract_start_at','timestamptz',false),
  ('clients','contract_end_at','timestamptz',false),('clients','auto_renew','boolean',false),
  ('clients','cancel_at_term_end','boolean',true),('clients','cancel_effective_at','timestamptz',false),
  ('membership_agreements','initial_term_start','date',false),('membership_agreements','initial_renewal_date','date',false),
  ('client_plan_settings','client_id','uuid',true),('client_plan_settings','plan_tier','text',true),
  ('client_plan_settings','billing_interval','text',true),('client_plan_settings','platform_fee','numeric',false),
  ('client_plan_settings','per_role_fee','numeric',true),('client_plan_settings','included_interviews_per_role','integer',true),
  ('client_plan_settings','additional_interview_fee','numeric',true),('client_plan_settings','max_interview_minutes','integer',true),
  ('client_plan_settings','scored_question_count','integer',false),('client_plan_settings','billing_model','text',false),
  ('client_plan_settings','usage_interview_fee_cents','integer',false),('client_plan_settings','rollover_days','integer',true)
 )t(tab,name,type,required) loop
  if not exists(select 1 from pg_attribute where attrelid=to_regclass('public.'||x.tab) and attname=x.name
   and atttypid=to_regtype(x.type) and attnotnull=x.required and not attisdropped)
   then raise exception 'enterprise_billing_column_drift';end if;
 end loop;
 foreach spec slice 1 in array array[
  array['client_plan_settings_client_id_key','UNIQUE (client_id)'],
  array['client_plan_settings_rollover_days_check','CHECK ((rollover_days > 0))'],
  array['client_plan_settings_scored_question_count_check','CHECK (((scored_question_count IS NULL) OR (scored_question_count > 0)))'],
  array['client_plan_settings_usage_interview_fee_cents_check','CHECK (((usage_interview_fee_cents IS NULL) OR (usage_interview_fee_cents >= 0)))']
 ] loop
  if not exists(select 1 from pg_constraint where conrelid='public.client_plan_settings'::regclass and conname=spec[1]
   and convalidated and pg_get_constraintdef(oid)=spec[2]) then raise exception 'enterprise_billing_plan_check_drift';end if;
 end loop;
 if not exists(select 1 from pg_attribute a join pg_attrdef d on d.adrelid=a.attrelid and d.adnum=a.attnum
   where a.attrelid='public.client_plan_settings'::regclass and a.attname='rollover_days' and pg_get_expr(d.adbin,d.adrelid)='90')
  or exists(select 1 from pg_attribute a join pg_attrdef d on d.adrelid=a.attrelid and d.adnum=a.attnum
   where a.attrelid='public.client_plan_settings'::regclass and a.attname in('billing_model','scored_question_count'))
  or exists(select 1 from pg_attribute where attrelid='public.membership_agreements'::regclass
   and attname='enterprise_billing_receipt' and not attisdropped)
  or to_regclass('public.clients_stripe_subscription_id_uniq') is not null
  or exists(select 1 from public.clients where stripe_subscription_id is not null group by stripe_subscription_id having count(*)>1)
  then raise exception 'enterprise_billing_schema_drift';end if;
 foreach spec slice 1 in array array[array['clients'],array['membership_agreements'],array['client_interview_pools'],
  array['billing_customers'],array['client_plan_settings']] loop
  if not exists(select 1 from pg_class where oid=to_regclass('public.'||spec[1]) and relrowsecurity)
   or not has_table_privilege('service_role','public.'||spec[1],'SELECT')
   or not has_table_privilege('service_role','public.'||spec[1],'UPDATE') then raise exception 'enterprise_billing_acl_drift';end if;
 end loop;
 if not has_table_privilege('service_role','public.client_plan_settings','INSERT')
  or not exists(select 1 from pg_trigger where tgrelid='public.membership_agreements'::regclass
   and tgname='enterprise_existing_funding_guard' and tgenabled='O' and tgtype=31
   and tgfoid=to_regprocedure('public.enterprise_existing_funding_guard()'))
  then raise exception 'enterprise_billing_acl_drift';end if;
end $baseline$;
alter table public.membership_agreements add column enterprise_billing_receipt jsonb;
-- Global ownership cannot be made race-safe by an unlocked SELECT alone.
-- Existing duplicates stop migration; never backfill or silently merge clients.
create unique index clients_stripe_subscription_id_uniq on public.clients(stripe_subscription_id)
 where stripe_subscription_id is not null;

create function public.enterprise_existing_billing_initial(src jsonb,prices jsonb,funding jsonb,sub jsonb)
returns jsonb language plpgsql immutable security invoker set search_path=pg_catalog as $$
declare v jsonb:=src->'material'->'template_snapshot'->'values'; template jsonb:=src->'material'->'template_snapshot';
 proof jsonb:=funding->'proof'; basis text; start_at timestamptz; end_at timestamptz; period_at timestamptz;
 start_day date; end_day date; duration text; questions text; renew boolean;
begin
 if not coalesce(public.enterprise_existing_funding_receipt_valid(funding,src,prices),false)
  or jsonb_typeof(sub) is distinct from 'object' or(select count(*) from jsonb_object_keys(sub))<>5
  or not(sub ?& array['id','customer','status','current_period_end','cancel_at_period_end'])
  or sub->'id' is distinct from proof->'subscription_id' or sub->'customer' is distinct from proof->'customer_id'
  or sub->'status' is distinct from '"active"'::jsonb or jsonb_typeof(sub->'cancel_at_period_end') is distinct from 'boolean'
  or jsonb_typeof(sub->'current_period_end') is distinct from 'number' or sub->>'current_period_end' !~ '^[0-9]+$'
  or(sub->>'current_period_end')::numeric>253402300799
  or jsonb_typeof(src->'material'->'auto_renew') is distinct from 'boolean'
  then raise exception 'enterprise_billing_projection_denied';end if;
 renew:=(src->'material'->>'auto_renew')::boolean;
 if sub->'cancel_at_period_end' is distinct from to_jsonb(not renew)
  or (v ? 'auto_renew' and v->'auto_renew' is distinct from to_jsonb(renew))
  then raise exception 'enterprise_billing_renewal_denied';end if;
 period_at:=to_timestamp((sub->>'current_period_end')::bigint);
 if period_at<=(proof->>'payment_success_at')::timestamptz then raise exception 'enterprise_billing_period_denied';end if;
 basis:=v->>'term_start_basis';
 if jsonb_typeof(v->'term_start_basis') is distinct from 'string'
  or(template ? 'term_start_basis' and template->'term_start_basis' is distinct from v->'term_start_basis')
  then raise exception 'enterprise_billing_term_denied';end if;
 if basis='agreement_date' then
  if jsonb_typeof(v->'initial_term_start') is distinct from 'string' or jsonb_typeof(v->'initial_renewal_date') is distinct from 'string'
   or v->>'initial_term_start' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' or v->>'initial_renewal_date' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
   then raise exception 'enterprise_billing_term_denied';end if;
  start_day:=(v->>'initial_term_start')::date;end_day:=(v->>'initial_renewal_date')::date;
  if to_char(start_day,'YYYY-MM-DD')<>v->>'initial_term_start' or to_char(end_day,'YYYY-MM-DD')<>v->>'initial_renewal_date'
   or end_day<=start_day then raise exception 'enterprise_billing_term_denied';end if;
  start_at:=start_day::timestamp at time zone 'UTC';end_at:=end_day::timestamp at time zone 'UTC';
 elsif basis='successful_payment' then
  if v->'initial_term_start' is distinct from '""'::jsonb or v->'initial_renewal_date' is distinct from '""'::jsonb
   then raise exception 'enterprise_billing_term_denied';end if;
  start_at:=(proof->>'payment_success_at')::timestamptz;
  -- PostgreSQL clamps civil leap-day/month-end addition. Explicit UTC removes
  -- timezone/DST drift, matching existing anchoredMonthInstant(A,12).
  end_at:=((start_at at time zone 'UTC')+interval '12 months') at time zone 'UTC';
 else raise exception 'enterprise_billing_term_denied';end if;
 if not isfinite(start_at) or not isfinite(end_at) or extract(year from start_at)<1 or extract(year from end_at)>9999
  then raise exception 'enterprise_billing_term_denied';end if;
 duration:=nullif(btrim(v->>'max_interview_minutes'),'');questions:=nullif(btrim(v->>'scored_question_count'),'');
 if (duration is null)<>(questions is null) or(duration is not null and
  (duration !~ '^[0-9]+$' or questions !~ '^[0-9]+$' or duration::numeric not between 5 and 59 or questions::numeric not between 1 and 7))
  or v->>'billing_model' is distinct from 'usage' or nullif(btrim(v->>'rollover_days'),'') is not null
  or coalesce(v->>'per_role_fee','') !~ '^0+(\.0{1,2})?$'
  or coalesce(v->>'additional_interview_fee','') !~ '^0+(\.0{1,2})?$'
  or coalesce(v->>'included_interviews_per_role','') !~ '^0+(\.0{1,2})?$'
  or coalesce(v->>'usage_interview_fee_cents','') !~ '^[0-9]+$'
  or(v->>'usage_interview_fee_cents')::numeric<1 or(v->>'usage_interview_fee_cents')::numeric>2147483647
  then raise exception 'enterprise_billing_settings_denied';end if;
 return jsonb_build_object('client_initial',jsonb_build_object(
  'stripe_customer_id',proof->'customer_id','stripe_subscription_id',proof->'subscription_id',
  'subscription_status','active','billing_status','active','billing_interval',src->'material'->'billing_option','plan_tier','enterprise',
  'current_term_end',to_char(period_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
  'cancel_at_term_end',not renew,'auto_renew',renew,'cancel_effective_at',null,
  'contract_start_at',to_char(start_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
  'contract_end_at',to_char(end_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')),
  'plan_initial',jsonb_build_object('client_id',proof->'client_id','plan_tier','enterprise',
   'billing_interval',src->'material'->'billing_option','platform_fee',(proof->>'platform_nominal_cents')::numeric/100,
   'per_role_fee',(v->>'per_role_fee')::numeric,'included_interviews_per_role',(v->>'included_interviews_per_role')::numeric::integer,
   'additional_interview_fee',(v->>'additional_interview_fee')::numeric,
   'max_interview_minutes',case when duration is null then 15 else duration::integer end,
   'scored_question_count',case when questions is null then null else questions::integer end,
   'billing_model','usage','usage_interview_fee_cents',(v->>'usage_interview_fee_cents')::integer));
end $$;

create function public.enterprise_existing_billing_receipt_valid(w jsonb,src jsonb,prices jsonb)
returns boolean language plpgsql immutable security invoker set search_path=pg_catalog as $$
declare expected jsonb; applied timestamptz;
begin
 if jsonb_typeof(w) is distinct from 'object' or(select count(*) from jsonb_object_keys(w))<>6
  or not(w ?& array['version','funding_receipt','subscription','client_initial','plan_initial','applied_at'])
  or w->>'version' is distinct from 'enterprise_existing_billing_v1' or jsonb_typeof(w->'applied_at') is distinct from 'string'
  or w->>'applied_at' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{6}Z$' then return false;end if;
 expected:=public.enterprise_existing_billing_initial(src,prices,w->'funding_receipt',w->'subscription');
 applied:=(w->>'applied_at')::timestamptz;
 return coalesce(w->'client_initial'=expected->'client_initial' and w->'plan_initial'=expected->'plan_initial'
  and isfinite(applied) and applied>=(w->'funding_receipt'->>'recorded_at')::timestamptz
  and w->>'applied_at'=to_char(applied at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),false);
exception when others then return false;
end $$;

-- Read-only source validation. No hidden reverse row locks and no spoofed
-- client subscription supplied to the original pending funding context.
create function public.enterprise_existing_billing_context(a public.membership_agreements)
returns void language plpgsql security invoker set search_path=pg_catalog as $$
declare c public.clients; p public.client_interview_pools; seal public.enterprise_v2_execution_seals; src jsonb;
begin
 if current_user<>'service_role' or a.id is null or a.status is distinct from 'signed' or a.is_current is distinct from true
  or a.superseded_at is not null or a.superseded_by_agreement_id is not null
  or a.checkout_status is distinct from 'pending_payment' or a.checkout_paid_at is not null
  or a.checkout_attempt_source is not null or a.checkout_embedded is not null
  or not coalesce(public.enterprise_existing_funding_receipt_valid(a.enterprise_funding_receipt,a.enterprise_checkout_source,a.enterprise_checkout_prices),false)
  or exists(select 1 from public.public_purchase_intents where agreement_id=a.id)
  then raise exception 'enterprise_billing_source_denied';end if;
 select * into c from public.clients where id=a.client_id;
 select * into p from public.client_interview_pools where id=a.enterprise_checkout_pool_id;
 select * into seal from public.enterprise_v2_execution_seals where agreement_id=a.id;
 src:=a.enterprise_checkout_source;
 if c.id is null or p.id is null or seal.agreement_id is null
  or c.stripe_customer_id is distinct from a.enterprise_funding_receipt->'proof'->>'customer_id'
  or public.enterprise_existing_pending_material(to_jsonb(a),to_jsonb(c),to_jsonb(seal)) is distinct from src->'material'
  or src->>'pool_id' is distinct from p.id::text or p.client_id is distinct from c.id or p.agreement_id is distinct from a.id
  or p.status is distinct from 'pending' or p.paid_at is not null or p.stripe_payment_intent_id is not null
  or p.stripe_checkout_session_id is distinct from a.checkout_session_id
  or a.enterprise_funding_receipt->'proof'->>'checkout_session_id' is distinct from a.checkout_session_id
  or p.offer_snapshot is distinct from a.template_snapshot->'values'->'pool_offer_snapshot'
  or p.offer_digest is distinct from a.template_snapshot->'values'->>'pool_offer_digest'
  or a.replaces_stripe_subscription_id is distinct from src->>'replacement_id'
  or a.replacement_policy is distinct from(case when src->>'replacement_id' is null then null else 'immediate_cancel' end)
  or (select count(*) from public.billing_customers where stripe_customer_id=c.stripe_customer_id)<>1
  or not exists(select 1 from public.billing_customers where stripe_customer_id=c.stripe_customer_id and client_id=c.id)
  or a.checkout_created_at is distinct from(src->>'created_at')::timestamptz
  or(src->>'expires_at')::timestamptz is distinct from public.enterprise_existing_pending_expiry(a.checkout_created_at,a.agreement_expires_at)
  or(a.enterprise_funding_receipt->'proof'->>'payment_success_at')::timestamptz>clock_timestamp()
  then raise exception 'enterprise_billing_binding_denied';end if;
 if a.template_snapshot->'values'->>'term_start_basis'='agreement_date' then
  if a.initial_term_start is null or a.initial_renewal_date is null
   or to_char(a.initial_term_start,'YYYY-MM-DD') is distinct from a.template_snapshot->'values'->>'initial_term_start'
   or to_char(a.initial_renewal_date,'YYYY-MM-DD') is distinct from a.template_snapshot->'values'->>'initial_renewal_date'
   then raise exception 'enterprise_billing_term_denied';end if;
 elsif a.template_snapshot->'values'->>'term_start_basis'='successful_payment' then
  if a.initial_term_start is not null or a.initial_renewal_date is not null then raise exception 'enterprise_billing_term_denied';end if;
 else raise exception 'enterprise_billing_term_denied';end if;
end $$;

create function public.enterprise_existing_billing_rows_match(a public.membership_agreements,w jsonb)
returns boolean language plpgsql security invoker set search_path=pg_catalog as $$
declare c public.clients; plan public.client_plan_settings; actual jsonb; field text;
begin
 select * into c from public.clients where id=a.client_id;
 select * into plan from public.client_plan_settings where client_id=a.client_id;
 if c.id is null or plan.client_id is null then return false;end if;
 actual:=to_jsonb(c);
 foreach field in array array['current_term_end','contract_start_at','contract_end_at'] loop
  actual:=jsonb_set(actual,array[field],coalesce(to_jsonb(to_char((actual->>field)::timestamptz at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')),'null'::jsonb));
 end loop;
 for field in select jsonb_object_keys(w->'client_initial') loop
  if actual->field is distinct from w->'client_initial'->field then return false;end if;
 end loop;
 actual:=to_jsonb(plan);
 for field in select jsonb_object_keys(w->'plan_initial') loop
  if actual->field is distinct from w->'plan_initial'->field then return false;end if;
 end loop;return true;
end $$;

create function public.enterprise_existing_billing_guard()
returns trigger language plpgsql security invoker set search_path=pg_catalog as $$
declare w jsonb;
begin
 if TG_OP='DELETE' then if old.enterprise_billing_receipt is not null then raise exception 'enterprise_billing_immutable';end if;return old;end if;
 if TG_OP='INSERT' then if new.enterprise_billing_receipt is not null then raise exception 'enterprise_billing_record_required';end if;return new;end if;
 if old.enterprise_billing_receipt is not null then
  if new.enterprise_billing_receipt is distinct from old.enterprise_billing_receipt then raise exception 'enterprise_billing_immutable';end if;return new;
 end if;
 if new.enterprise_billing_receipt is null then return new;end if;
 perform public.enterprise_existing_billing_context(new);
 w:=new.enterprise_billing_receipt;
 if jsonb_typeof(w) is distinct from 'object' or w->'applied_at' is distinct from 'null'::jsonb then raise exception 'enterprise_billing_stamp_required';end if;
 w:=jsonb_set(w,'{applied_at}',to_jsonb(to_char(clock_timestamp() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')));
 if not coalesce(public.enterprise_existing_billing_receipt_valid(w,new.enterprise_checkout_source,new.enterprise_checkout_prices),false)
  or w->'funding_receipt' is distinct from new.enterprise_funding_receipt
  or(w->'subscription'->>'current_period_end')::bigint<=extract(epoch from clock_timestamp())
  or not public.enterprise_existing_billing_rows_match(new,w) then raise exception 'enterprise_billing_first_state_denied';end if;
 new.enterprise_billing_receipt:=w;return new;
end $$;
create trigger enterprise_existing_billing_guard before insert or update or delete on public.membership_agreements
 for each row execute function public.enterprise_existing_billing_guard();
create function public.enterprise_existing_billing_commit_guard()
returns trigger language plpgsql security invoker set search_path=pg_catalog as $$
declare a public.membership_agreements;
begin
 if old.enterprise_billing_receipt is not null or new.enterprise_billing_receipt is null then return null;end if;
 select * into a from public.membership_agreements where id=new.id;
 perform public.enterprise_existing_billing_context(a);
 if a.enterprise_billing_receipt is distinct from new.enterprise_billing_receipt
  or not public.enterprise_existing_billing_rows_match(a,new.enterprise_billing_receipt)
  then raise exception 'enterprise_billing_commit_state_denied';end if;return null;
end $$;
create constraint trigger enterprise_existing_billing_commit_guard after update on public.membership_agreements
 deferrable initially deferred for each row execute function public.enterprise_existing_billing_commit_guard();
alter table public.membership_agreements add constraint enterprise_existing_billing_receipt_check check(
 enterprise_billing_receipt is null or public.enterprise_existing_billing_receipt_valid(enterprise_billing_receipt,enterprise_checkout_source,enterprise_checkout_prices));

create function public.apply_enterprise_existing_billing(p_agreement uuid,p_client uuid,p_source jsonb,p_prices jsonb,p_funding jsonb,p_subscription jsonb)
returns jsonb language plpgsql security invoker set search_path=pg_catalog set lock_timeout='10s' as $$
declare a public.membership_agreements; c public.clients; pool public.client_interview_pools; plan public.client_plan_settings;
 owner_id uuid; expected jsonb; ci jsonb; pi jsonb; w jsonb;
begin
 if current_user<>'service_role' then raise exception 'enterprise_billing_server_only';end if;
 select * into c from public.clients where id=p_client for update;
 if not found then raise exception 'enterprise_billing_parent_denied';end if;
 select * into a from public.membership_agreements where id=p_agreement for update;
 if not found or a.client_id is distinct from c.id or a.enterprise_checkout_source is distinct from p_source
  or a.enterprise_checkout_prices is distinct from p_prices or a.enterprise_funding_receipt is distinct from p_funding
  then raise exception 'enterprise_billing_source_denied';end if;
 select * into pool from public.client_interview_pools where id=a.enterprise_checkout_pool_id for update;
 if not found then raise exception 'enterprise_billing_pool_denied';end if;
 select id into owner_id from public.billing_customers where stripe_customer_id=c.stripe_customer_id for share;
 if not found then raise exception 'enterprise_billing_owner_denied';end if;
 select * into plan from public.client_plan_settings where client_id=c.id for update;
 perform public.enterprise_existing_billing_context(a);
 expected:=public.enterprise_existing_billing_initial(p_source,p_prices,p_funding,p_subscription);
 ci:=expected->'client_initial';pi:=expected->'plan_initial';
 if a.enterprise_billing_receipt is not null then
  if a.enterprise_billing_receipt->'funding_receipt' is distinct from p_funding
   or a.enterprise_billing_receipt->'subscription' is distinct from p_subscription
   or not coalesce(public.enterprise_existing_billing_receipt_valid(a.enterprise_billing_receipt,p_source,p_prices),false)
   or c.stripe_subscription_id is distinct from p_funding->'proof'->>'subscription_id'
   then raise exception 'enterprise_billing_replay_conflict';end if;
  -- No DML, timestamp movement, plan recreation or administrator overwrite.
  return a.enterprise_billing_receipt;
 end if;
 perform public.enterprise_existing_funding_context(a);
 if (plan.billing_model is not null and plan.billing_model<>'usage')
  or(p_subscription->>'current_period_end')::bigint<=extract(epoch from clock_timestamp())
  or exists(select 1 from public.clients where id<>c.id and stripe_subscription_id=p_subscription->>'id')
  then raise exception 'enterprise_billing_first_state_denied';end if;
 update public.clients set stripe_customer_id=ci->>'stripe_customer_id',stripe_subscription_id=ci->>'stripe_subscription_id',
  subscription_status=ci->>'subscription_status',billing_status=ci->>'billing_status',billing_interval=ci->>'billing_interval',
  plan_tier=ci->>'plan_tier',current_term_end=(ci->>'current_term_end')::timestamptz,cancel_at_term_end=(ci->>'cancel_at_term_end')::boolean,
  auto_renew=(ci->>'auto_renew')::boolean,cancel_effective_at=null,contract_start_at=(ci->>'contract_start_at')::timestamptz,
  contract_end_at=(ci->>'contract_end_at')::timestamptz where id=c.id;
 insert into public.client_plan_settings(client_id,plan_tier,billing_interval,platform_fee,per_role_fee,included_interviews_per_role,
  additional_interview_fee,max_interview_minutes,scored_question_count,billing_model,usage_interview_fee_cents)
 values(c.id,pi->>'plan_tier',pi->>'billing_interval',(pi->>'platform_fee')::numeric,(pi->>'per_role_fee')::numeric,
  (pi->>'included_interviews_per_role')::integer,(pi->>'additional_interview_fee')::numeric,(pi->>'max_interview_minutes')::integer,
  (pi->>'scored_question_count')::integer,pi->>'billing_model',(pi->>'usage_interview_fee_cents')::integer)
 on conflict(client_id) do update set plan_tier=excluded.plan_tier,billing_interval=excluded.billing_interval,
  platform_fee=excluded.platform_fee,per_role_fee=excluded.per_role_fee,included_interviews_per_role=excluded.included_interviews_per_role,
  additional_interview_fee=excluded.additional_interview_fee,max_interview_minutes=excluded.max_interview_minutes,
  scored_question_count=excluded.scored_question_count,billing_model=excluded.billing_model,
  usage_interview_fee_cents=excluded.usage_interview_fee_cents,updated_at=clock_timestamp();
 w:=jsonb_build_object('version','enterprise_existing_billing_v1','funding_receipt',p_funding,'subscription',p_subscription,
  'client_initial',ci,'plan_initial',pi,'applied_at',null);
 update public.membership_agreements set enterprise_billing_receipt=w where id=a.id returning enterprise_billing_receipt into w;
 if not found then raise exception 'enterprise_billing_record_failed';end if;return w;
end $$;

revoke all on function public.enterprise_existing_billing_initial(jsonb,jsonb,jsonb,jsonb),
 public.enterprise_existing_billing_receipt_valid(jsonb,jsonb,jsonb),public.enterprise_existing_billing_context(public.membership_agreements),
 public.enterprise_existing_billing_rows_match(public.membership_agreements,jsonb),public.enterprise_existing_billing_guard(),
 public.enterprise_existing_billing_commit_guard(),public.apply_enterprise_existing_billing(uuid,uuid,jsonb,jsonb,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.enterprise_existing_billing_initial(jsonb,jsonb,jsonb,jsonb),
 public.enterprise_existing_billing_receipt_valid(jsonb,jsonb,jsonb),public.enterprise_existing_billing_context(public.membership_agreements),
 public.enterprise_existing_billing_rows_match(public.membership_agreements,jsonb),public.enterprise_existing_billing_guard(),
 public.enterprise_existing_billing_commit_guard(),public.apply_enterprise_existing_billing(uuid,uuid,jsonb,jsonb,jsonb,jsonb) to service_role;
commit;
