-- LOCAL trace only. Reuse existing agreement/pool rows; no funded cash, Auth,
-- contract, credit release or old accepted-source backfill.
begin;
set local lock_timeout='10s';
do $baseline$
declare spec text[]; p record; x record;
begin
 foreach spec slice 1 in array array[
  array['enterprise_existing_pending_material(jsonb,jsonb,jsonb)','2b81b06a731c0711ad382c66c1e520c1'],
  array['enterprise_existing_pending_config_valid(jsonb)','9cc98f839fddb9ee2d140608c0b40bf1'],
  array['enterprise_existing_pending_expiry(timestamptz,timestamptz)','f0ad469d7098bf27e6b76c913202d697'],
  array['enterprise_existing_pending_agreement_guard()','0e0e39ba53d5822e5b12dad908d445a8'],
  array['enterprise_existing_pending_pool_guard()','5f5a791d026d1d5fce5e4dca93f6605e'],
  array['enterprise_existing_pending_pair_guard()','64af6412dc06e74323f15dc0e846a8f8'],
  array['claim_enterprise_existing_pending_checkout(uuid,uuid,jsonb,text,boolean,text,jsonb)','081cb824284105a582d792f24eb453aa'],
  array['enterprise_pool_v2_guard_pool()','5ec10701ca59c0c9fd6735a6f644c1a0'],
  array['enterprise_pool_v2_guard_agreement()','f556d965930467187ec3b4de8ee11542'],
  array['enterprise_pool_v2_guard_source()','483cc416ab9ee7e3017f3ee8d0490daa'],
  array['enterprise_v2_signing_requires_seal()','eb87e1661cf367050af8a859340ded6e']] loop
  select * into p from pg_proc where oid=to_regprocedure('public.'||spec[1]);
  if not found or p.prosecdef or md5(p.prosrc)<>spec[2] or p.proconfig is distinct from
   (case when spec[1] like 'claim_%' then array['search_path=pg_catalog','lock_timeout=10s'] else array['search_path=pg_catalog'] end)
   or has_function_privilege('anon',p.oid,'EXECUTE') or has_function_privilege('authenticated',p.oid,'EXECUTE')
   or not has_function_privilege('service_role',p.oid,'EXECUTE') then raise exception 'enterprise_trace_prerequisite_drift';end if;
 end loop;
 for x in select * from(values
  ('membership_agreements','enterprise_existing_pending_agreement_guard','enterprise_existing_pending_agreement_guard',31,false),
  ('client_interview_pools','enterprise_existing_pending_pool_guard','enterprise_existing_pending_pool_guard',31,false),
  ('membership_agreements','enterprise_existing_pending_agreement_pair','enterprise_existing_pending_pair_guard',21,true),
  ('client_interview_pools','enterprise_existing_pending_pool_pair','enterprise_existing_pending_pair_guard',21,true),
  ('client_interview_pools','enterprise_pool_v2_guard_pool','enterprise_pool_v2_guard_pool',31,false),
  ('membership_agreements','enterprise_pool_v2_guard_source','enterprise_pool_v2_guard_source',27,false),
  ('membership_agreements','enterprise_v2_signing_requires_seal','enterprise_v2_signing_requires_seal',19,false)
 )t(tab,name,func,kind,deferred) loop
  if not exists(select 1 from pg_trigger where tgrelid=to_regclass('public.'||x.tab) and tgname=x.name and tgenabled='O'
   and tgtype=x.kind and tgfoid=to_regprocedure('public.'||x.func||'()') and tgdeferrable=x.deferred and tginitdeferred=x.deferred)
   then raise exception 'enterprise_trace_trigger_drift';end if;
 end loop;
 if exists(select 1 from pg_attribute where attrelid='public.membership_agreements'::regclass and attname='enterprise_checkout_prices' and not attisdropped)
  or not exists(select 1 from pg_class where oid='public.client_interview_pools'::regclass and relrowsecurity)
  or not exists(select 1 from pg_class where oid='public.membership_agreements'::regclass and relrowsecurity)
  or not exists(select 1 from pg_class where oid='public.enterprise_v2_execution_seals'::regclass and relrowsecurity)
  or has_table_privilege('anon','public.client_interview_pools','SELECT,INSERT,UPDATE,DELETE')
  or has_table_privilege('authenticated','public.client_interview_pools','SELECT,INSERT,UPDATE,DELETE')
  or not has_table_privilege('service_role','public.client_interview_pools','SELECT,INSERT,UPDATE,DELETE')
  or has_table_privilege('anon','public.enterprise_v2_execution_seals','SELECT,INSERT,UPDATE,DELETE')
  or has_table_privilege('authenticated','public.enterprise_v2_execution_seals','SELECT,INSERT,UPDATE,DELETE')
  or not has_table_privilege('service_role','public.enterprise_v2_execution_seals','SELECT,INSERT')
  or has_table_privilege('service_role','public.enterprise_v2_execution_seals','UPDATE,DELETE,TRUNCATE')
  or exists(select 1 from pg_policies where schemaname='public' and tablename in('client_interview_pools','enterprise_v2_execution_seals'))
  then raise exception 'enterprise_trace_schema_acl_drift';end if;
 foreach spec slice 1 in array array[
  array['enterprise_pool_v2_snapshot_check','207ca2f1615bd52298ca296c582563b6'],
  array['client_interview_pools_total_check','11bf823dae61f175be0a7acf76bacaed'],
  array['client_interview_pools_status_check','6bb064e6f03e464e7a80304b9eaa163a'],
  array['client_interview_pools_discount_check','d6a426fad89ecefcae48770cd15ca656'],
  array['client_interview_pools_quantity_check','70a754901507cc93dbc7d569ab5ac563'],
  array['client_interview_pools_unit_price_check','f611d5276579a2181341465e4b9bce18']] loop
  if not exists(select 1 from pg_constraint where conrelid='public.client_interview_pools'::regclass and conname=spec[1]
   and contype='c' and convalidated and md5(pg_get_constraintdef(oid))=spec[2]) then raise exception 'enterprise_trace_check_drift';end if;
 end loop;
 for x in select * from(values
  ('membership_agreements','enterprise_checkout_source','jsonb'),('membership_agreements','enterprise_checkout_pool_id','uuid'),
  ('membership_agreements','checkout_created_at','timestamptz'),('membership_agreements','checkout_paid_at','timestamptz'),
  ('membership_agreements','checkout_status','text'),('membership_agreements','checkout_session_id','text'),
  ('membership_agreements','checkout_attempt_source','jsonb'),('membership_agreements','checkout_embedded','boolean'),
  ('membership_agreements','replaces_stripe_subscription_id','text'),('membership_agreements','replacement_policy','text'),
  ('client_interview_pools','agreement_id','uuid'),('client_interview_pools','stripe_checkout_session_id','text'),
  ('client_interview_pools','stripe_payment_intent_id','text'),('client_interview_pools','paid_at','timestamptz')
 )t(tab,name,type) loop
  if not exists(select 1 from pg_attribute where attrelid=to_regclass('public.'||x.tab) and attname=x.name and atttypid=to_regtype(x.type)
   and not attnotnull and not attisdropped) then raise exception 'enterprise_trace_column_drift';end if;
 end loop;
 if not exists(select 1 from pg_index i join pg_attribute a on a.attrelid=i.indrelid and a.attname='agreement_id'
  where i.indexrelid=to_regclass('public.enterprise_pool_one_initial_agreement') and i.indisunique and i.indisvalid
   and i.indnkeyatts=1 and i.indkey[0]=a.attnum and pg_get_expr(i.indpred,i.indrelid)='(agreement_id IS NOT NULL)')
  or (select count(*) from pg_constraint where contype='f' and convalidated and confdeltype='r' and
   ((conrelid='public.membership_agreements'::regclass and confrelid='public.client_interview_pools'::regclass
    and conkey=array[(select attnum from pg_attribute where attrelid=conrelid and attname='enterprise_checkout_pool_id')])
   or(conrelid='public.client_interview_pools'::regclass and confrelid='public.membership_agreements'::regclass
    and conkey=array[(select attnum from pg_attribute where attrelid=conrelid and attname='agreement_id')])))<>2
  then raise exception 'enterprise_trace_pair_schema_drift';end if;
end $baseline$;
alter table public.membership_agreements add column enterprise_checkout_prices jsonb;

create function public.enterprise_existing_checkout_prices_valid(p jsonb)
returns boolean language sql immutable security invoker set search_path=pg_catalog as $$
 select case when jsonb_typeof(p)='object' then (select count(*) from jsonb_object_keys(p))=2
  and p ?& array['platform_price_id','pool_price_id'] and jsonb_typeof(p->'platform_price_id')='string'
  and jsonb_typeof(p->'pool_price_id')='string' and p->>'platform_price_id' ~ '^price_[A-Za-z0-9_]+$'
  and p->>'pool_price_id' ~ '^price_[A-Za-z0-9_]+$' and p->>'platform_price_id'<>p->>'pool_price_id' else false end
$$;

create function public.enterprise_existing_checkout_locked(p_agreement uuid,p_client uuid,p_source jsonb)
returns jsonb language plpgsql security invoker set search_path=pg_catalog set lock_timeout='10s' as $$
declare a public.membership_agreements;c public.clients;s public.enterprise_v2_execution_seals;p public.client_interview_pools;src jsonb;material jsonb;b timestamptz;expiry timestamptz;
begin
 if current_user<>'service_role' then raise exception 'enterprise_trace_server_only';end if;
 select * into c from public.clients where id=p_client for update;
 if not found then raise exception 'enterprise_trace_parent_denied';end if;
 select * into a from public.membership_agreements where id=p_agreement for update;
 if not found or a.client_id is distinct from c.id or a.status is distinct from 'signed' or a.is_current is distinct from true
  or a.superseded_at is not null or a.superseded_by_agreement_id is not null or a.checkout_paid_at is not null
  or (a.checkout_status is not null and a.checkout_status<>'pending_payment') or a.enterprise_checkout_source is null
  or a.enterprise_checkout_source is distinct from p_source or exists(select 1 from public.public_purchase_intents where agreement_id=a.id)
  then raise exception 'enterprise_trace_source_denied';end if;
 select * into s from public.enterprise_v2_execution_seals where agreement_id=a.id;
 if not found then raise exception 'enterprise_trace_seal_denied';end if;
 src:=a.enterprise_checkout_source;material:=public.enterprise_existing_pending_material(to_jsonb(a),to_jsonb(c),to_jsonb(s));
 if src->'material' is distinct from material or src->>'pool_id' is distinct from a.enterprise_checkout_pool_id::text
  or src->>'version' is distinct from 'enterprise_existing_pending_v1' then raise exception 'enterprise_trace_source_denied';end if;
 b:=(src->>'created_at')::timestamptz;expiry:=(src->>'expires_at')::timestamptz;
 if not coalesce(isfinite(b),false) or b>clock_timestamp() or expiry is distinct from public.enterprise_existing_pending_expiry(b,a.agreement_expires_at)
  or expiry<clock_timestamp()+interval '30 minutes' or clock_timestamp()>=b+interval '24 hours' then raise exception 'enterprise_trace_window_closed';end if;
 select * into p from public.client_interview_pools where id=a.enterprise_checkout_pool_id and agreement_id=a.id for update;
 if not found or p.client_id is distinct from a.client_id or p.status is distinct from 'pending' or p.paid_at is not null
  or p.stripe_payment_intent_id is not null or p.stripe_checkout_session_id is distinct from a.checkout_session_id
  or p.offer_snapshot is distinct from a.template_snapshot->'values'->'pool_offer_snapshot'
  or p.offer_digest is distinct from a.template_snapshot->'values'->>'pool_offer_digest'
  or (a.enterprise_checkout_prices is not null and not coalesce(public.enterprise_existing_checkout_prices_valid(a.enterprise_checkout_prices),false))
  or (a.checkout_session_id is not null and a.enterprise_checkout_prices is null) then raise exception 'enterprise_trace_pair_denied';end if;
 return jsonb_build_object('source',src,'prices',a.enterprise_checkout_prices,'checkout_session_id',a.checkout_session_id);
end $$;

-- Change only these THREE recent pending guards; prior source/seal/paid guards
-- and old claim remain byte-identical. The new source/B is still immutable.
create or replace function public.enterprise_existing_pending_agreement_guard()
returns trigger language plpgsql security invoker set search_path=pg_catalog as $$
declare src jsonb; b timestamptz;expiry timestamptz;c jsonb;s jsonb;
begin
 if TG_OP='DELETE' then if old.enterprise_checkout_source is not null then raise exception 'enterprise_binding_immutable';end if;return old;end if;
 if TG_OP='INSERT' then
  if new.enterprise_checkout_source is not null or new.enterprise_checkout_pool_id is not null or new.enterprise_checkout_prices is not null then raise exception 'enterprise_binding_claim_required';end if;return new;
 end if;
 if old.enterprise_checkout_source is null and new.enterprise_checkout_source is null then
  if new.enterprise_checkout_pool_id is not null or new.enterprise_checkout_prices is not null then raise exception 'enterprise_binding_claim_required';end if;return new;
 end if;
 if old.enterprise_checkout_source is not null and (new.enterprise_checkout_source is distinct from old.enterprise_checkout_source
  or new.enterprise_checkout_pool_id is distinct from old.enterprise_checkout_pool_id) then raise exception 'enterprise_binding_immutable';end if;
 if old.enterprise_checkout_prices is not null and new.enterprise_checkout_prices is distinct from old.enterprise_checkout_prices then raise exception 'enterprise_trace_prices_immutable';end if;
 if old.checkout_session_id is not null and new.checkout_session_id is distinct from old.checkout_session_id then raise exception 'enterprise_trace_session_immutable';end if;
 if (old.enterprise_checkout_prices is null and new.enterprise_checkout_prices is not null) or(old.checkout_session_id is null and new.checkout_session_id is not null) then
  if current_user<>'service_role' or old.status is distinct from 'signed' or old.is_current is distinct from true
   or old.superseded_at is not null or old.superseded_by_agreement_id is not null then raise exception 'enterprise_trace_server_only';end if;
 end if;
 if new.checkout_attempt_source is not null or new.checkout_embedded is not null or new.checkout_paid_at is not null then raise exception 'enterprise_binding_pending_only';end if;
 src:=new.enterprise_checkout_source;
 if jsonb_typeof(src) is distinct from 'object' or(select count(*) from jsonb_object_keys(src))<>8
  or not(src ?& array['version','material','pool_id','created_at','expires_at','embedded','replacement_id','config'])
  or src->>'version' is distinct from 'enterprise_existing_pending_v1' or src->>'pool_id' is distinct from new.enterprise_checkout_pool_id::text
  or jsonb_typeof(src->'embedded') is distinct from 'boolean' or not coalesce(public.enterprise_existing_pending_config_valid(src->'config'),false)
  or(src->'replacement_id'<>'null'::jsonb and(jsonb_typeof(src->'replacement_id')<>'string' or src->>'replacement_id' !~ '^sub_[A-Za-z0-9_]+$'))
  then raise exception 'enterprise_binding_source_denied';end if;
 select to_jsonb(x) into c from public.clients x where id=new.client_id;
 select to_jsonb(x) into s from public.enterprise_v2_execution_seals x where agreement_id=new.id;
 if public.enterprise_existing_pending_material(to_jsonb(new),c,s) is distinct from src->'material' then raise exception 'enterprise_binding_source_denied';end if;
 b:=(src->>'created_at')::timestamptz;expiry:=(src->>'expires_at')::timestamptz;
 if not coalesce(isfinite(b),false) or src->>'created_at' is distinct from to_char(b at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  or src->>'expires_at' is distinct from to_char(expiry at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
  or expiry is distinct from public.enterprise_existing_pending_expiry(b,new.agreement_expires_at) then raise exception 'enterprise_binding_clock_denied';end if;
 if old.enterprise_checkout_source is null then
  if current_user<>'service_role' or old.enterprise_checkout_pool_id is not null or old.enterprise_checkout_prices is not null
   or old.checkout_created_at is not null or old.checkout_session_id is not null or new.enterprise_checkout_prices is not null or new.checkout_session_id is not null
   or old.status is distinct from 'signed' or old.is_current is distinct from true or old.superseded_at is not null or old.superseded_by_agreement_id is not null
   or b>clock_timestamp() or b<clock_timestamp()-interval '10 seconds' or expiry<clock_timestamp()+interval '30 minutes'
   or exists(select 1 from public.public_purchase_intents where agreement_id=new.id) then raise exception 'enterprise_binding_claim_denied';end if;
 end if;
 if new.enterprise_checkout_prices is not null and not coalesce(public.enterprise_existing_checkout_prices_valid(new.enterprise_checkout_prices),false) then raise exception 'enterprise_trace_prices_denied';end if;
 if (old.enterprise_checkout_prices is null and new.enterprise_checkout_prices is not null) or(old.checkout_session_id is null and new.checkout_session_id is not null) then
  if expiry<clock_timestamp()+interval '30 minutes' then raise exception 'enterprise_trace_window_closed';end if;
 end if;
 if new.checkout_session_id is null then
  if new.checkout_created_at is not null or new.checkout_status is not null or new.replaces_stripe_subscription_id is not null or new.replacement_policy is not null then raise exception 'enterprise_trace_incomplete';end if;
 else
  if new.checkout_session_id !~ '^cs_[A-Za-z0-9_]+$' or new.enterprise_checkout_prices is null or new.checkout_created_at is distinct from b
   or new.checkout_status is distinct from 'pending_payment' or new.replaces_stripe_subscription_id is distinct from src->>'replacement_id'
   or new.replacement_policy is distinct from(case when src->>'replacement_id' is null then null else 'immediate_cancel' end) then raise exception 'enterprise_trace_incomplete';end if;
 end if;return new;
end $$;
create or replace function public.enterprise_existing_pending_pool_guard()
returns trigger language plpgsql security invoker set search_path=pg_catalog as $$
begin
 if TG_OP='DELETE' then if old.agreement_id is not null then raise exception 'enterprise_binding_immutable';end if;return old;end if;
 if TG_OP='UPDATE' then
  if new.agreement_id is distinct from old.agreement_id then raise exception 'enterprise_binding_pool_link_immutable';end if;
  if old.agreement_id is not null and old.stripe_checkout_session_id is not null and new.stripe_checkout_session_id is distinct from old.stripe_checkout_session_id then raise exception 'enterprise_trace_session_immutable';end if;
  if new.agreement_id is null then return new;end if;
 elsif new.agreement_id is null then return new;end if;
 if current_user<>'service_role' or new.offer_snapshot is null or new.status is distinct from 'pending' or new.stripe_payment_intent_id is not null or new.paid_at is not null
  or(TG_OP='INSERT' and new.stripe_checkout_session_id is not null)
  or(new.stripe_checkout_session_id is not null and new.stripe_checkout_session_id !~ '^cs_[A-Za-z0-9_]+$') then raise exception 'enterprise_binding_pending_only';end if;
 return new;
end $$;
create or replace function public.enterprise_existing_pending_pair_guard()
returns trigger language plpgsql security invoker set search_path=pg_catalog as $$
declare aid uuid;a public.membership_agreements;p public.client_interview_pools;
begin
 if TG_TABLE_NAME='membership_agreements' then aid:=new.id;else aid:=new.agreement_id;end if;
 if aid is null then return null;end if;
 select * into a from public.membership_agreements where id=aid;select * into p from public.client_interview_pools where agreement_id=aid;
 if a.enterprise_checkout_source is null and a.enterprise_checkout_pool_id is null and p.agreement_id is null then return null;end if;
 if a.id is null or p.id is null or a.enterprise_checkout_pool_id is distinct from p.id or a.enterprise_checkout_source->>'pool_id' is distinct from p.id::text
  or a.client_id is distinct from p.client_id or p.offer_snapshot is distinct from a.template_snapshot->'values'->'pool_offer_snapshot'
  or p.offer_digest is distinct from a.template_snapshot->'values'->>'pool_offer_digest' or a.checkout_session_id is distinct from p.stripe_checkout_session_id
  then raise exception 'enterprise_binding_pair_denied';end if;return null;
end $$;

create function public.prepare_enterprise_existing_checkout(p_agreement uuid,p_client uuid,p_expected_snapshot jsonb,p_customer text,p_embedded boolean,p_replacement text,p_config jsonb)
returns jsonb language plpgsql security invoker set search_path=pg_catalog set lock_timeout='10s' as $$
declare a public.membership_agreements;src jsonb;
begin
 if current_user<>'service_role' then raise exception 'enterprise_trace_server_only';end if;
 perform 1 from public.clients where id=p_client for update;if not found then raise exception 'enterprise_trace_parent_denied';end if;
 select * into a from public.membership_agreements where id=p_agreement for update;
 if not found or a.client_id is distinct from p_client or a.template_snapshot is distinct from p_expected_snapshot
  or p_embedded is null or not coalesce(public.enterprise_existing_pending_config_valid(p_config),false) then raise exception 'enterprise_trace_source_denied';end if;
 if a.enterprise_checkout_source is null then
  src:=public.claim_enterprise_existing_pending_checkout(p_agreement,p_client,p_expected_snapshot,p_customer,p_embedded,p_replacement,p_config);
 else src:=a.enterprise_checkout_source;end if;
 if src->'embedded' is distinct from to_jsonb(p_embedded) or src->'config' is distinct from p_config or src->'material'->>'customer_id' is distinct from p_customer then raise exception 'enterprise_trace_source_denied';end if;
 return public.enterprise_existing_checkout_locked(p_agreement,p_client,src);
end $$;
create function public.pin_enterprise_existing_checkout_prices(p_agreement uuid,p_client uuid,p_source jsonb,p_prices jsonb)
returns jsonb language plpgsql security invoker set search_path=pg_catalog set lock_timeout='10s' as $$
declare attempt jsonb;
begin
 attempt:=public.enterprise_existing_checkout_locked(p_agreement,p_client,p_source);
 if not coalesce(public.enterprise_existing_checkout_prices_valid(p_prices),false) then raise exception 'enterprise_trace_prices_denied';end if;
 if attempt->'prices'<>'null'::jsonb then
  if attempt->'prices' is distinct from p_prices then raise exception 'enterprise_trace_prices_immutable';end if;
 else
  if attempt->>'checkout_session_id' is not null then raise exception 'enterprise_trace_prices_denied';end if;
  update public.membership_agreements set enterprise_checkout_prices=p_prices where id=p_agreement;
 end if;
 return public.enterprise_existing_checkout_locked(p_agreement,p_client,p_source);
end $$;
create function public.pin_enterprise_existing_checkout_session(p_agreement uuid,p_client uuid,p_source jsonb,p_prices jsonb,p_session text)
returns jsonb language plpgsql security invoker set search_path=pg_catalog set lock_timeout='10s' as $$
declare attempt jsonb;
begin
 attempt:=public.enterprise_existing_checkout_locked(p_agreement,p_client,p_source);
 if p_session is null or p_session !~ '^cs_[A-Za-z0-9_]+$' or attempt->'prices' is distinct from p_prices
  or not coalesce(public.enterprise_existing_checkout_prices_valid(p_prices),false) then raise exception 'enterprise_trace_session_denied';end if;
 if attempt->>'checkout_session_id' is not null then
  if attempt->>'checkout_session_id' is distinct from p_session then raise exception 'enterprise_trace_session_immutable';end if;
 else
  update public.client_interview_pools set stripe_checkout_session_id=p_session where id=(p_source->>'pool_id')::uuid and agreement_id=p_agreement;
  if not found then raise exception 'enterprise_trace_pair_denied';end if;
  update public.membership_agreements set checkout_session_id=p_session,checkout_status='pending_payment',checkout_created_at=(p_source->>'created_at')::timestamptz,
   replaces_stripe_subscription_id=p_source->>'replacement_id',replacement_policy=case when p_source->>'replacement_id' is null then null else 'immediate_cancel' end where id=p_agreement;
 end if;
 return public.enterprise_existing_checkout_locked(p_agreement,p_client,p_source);
end $$;
revoke all on function public.enterprise_existing_checkout_prices_valid(jsonb),public.enterprise_existing_checkout_locked(uuid,uuid,jsonb),
 public.prepare_enterprise_existing_checkout(uuid,uuid,jsonb,text,boolean,text,jsonb),public.pin_enterprise_existing_checkout_prices(uuid,uuid,jsonb,jsonb),
 public.pin_enterprise_existing_checkout_session(uuid,uuid,jsonb,jsonb,text) from public,anon,authenticated;
grant execute on function public.enterprise_existing_checkout_prices_valid(jsonb),public.enterprise_existing_checkout_locked(uuid,uuid,jsonb),
 public.prepare_enterprise_existing_checkout(uuid,uuid,jsonb,text,boolean,text,jsonb),public.pin_enterprise_existing_checkout_prices(uuid,uuid,jsonb,jsonb),
 public.pin_enterprise_existing_checkout_session(uuid,uuid,jsonb,jsonb,text) to service_role;
commit;
