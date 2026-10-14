-- LOCAL UNMOUNTED: original accepted source/period observation after activation.
-- NO activation-lease bypass, writes, provider calls, access or collection grant.
begin;
set local lock_timeout='10s';
do $baseline$ begin
 if exists(select 1 from pg_proc where pronamespace='public'::regnamespace
  and proname='read_retail_existing_recurring_source')
  then raise exception 'retail_recurring_source_schema_drift';end if;
end $baseline$;

create function public.read_retail_existing_recurring_source(p_agreement uuid,p_client uuid)
returns jsonb language plpgsql volatile security invoker set search_path=pg_catalog set lock_timeout='10s' as $$
declare a public.membership_agreements;i public.public_purchase_intents;c public.clients;
 w jsonb;s jsonb;b jsonb;clock timestamptz;paid timestamptz;had_intent boolean;stage integer;spec text[];meta record;
begin
 if current_user<>'service_role' then raise exception 'retail_recurring_source_server_only';end if;
 -- Same existing order, no upstream lock upgrade. Repeat catalog checks after
 -- any row waits; this is a read-instant snapshot, never a future reservation.
 for stage in 0..1 loop
  select * into meta from pg_proc where oid='public.read_retail_existing_recurring_source(uuid,uuid)'::regprocedure;
  if meta.prosecdef or meta.proisstrict or meta.provolatile<>'v'
   or meta.proconfig is distinct from array['search_path=pg_catalog','lock_timeout=10s']
   or meta.proowner is distinct from(select oid from pg_roles where rolname='postgres')
   or not has_function_privilege('service_role',meta.oid,'EXECUTE')
   or exists(select 1 from aclexplode(coalesce(meta.proacl,acldefault('f',meta.proowner)))
    where grantee not in(meta.proowner,(select oid from pg_roles where rolname='service_role')))
   or(select count(*) from pg_proc where pronamespace=meta.pronamespace and proname=meta.proname)<>1
   then raise exception 'retail_recurring_source_schema_drift';end if;
  foreach spec slice 1 in array array[
   array['retail_existing_funding_schema_guard()','abfab9e6f97d88c8aa940b8a993db42b','s','catalog'],
   array['retail_existing_funding_receipt_valid(jsonb,jsonb)','655f4866f0cf52144c3abf76bc02ac94','i','catalog'],
   array['retail_existing_checkout_material(jsonb,jsonb,text)','67699a36b8267739c5655764a7c0203f','i','catalog'],
   array['retail_existing_checkout_config_valid(jsonb)','c433714eff703c41b1590f890dc8ba7d','i','catalog'],
   array['retail_existing_checkout_attempt_guard()','57ff63cf55a2764173fdf8bb173aca2f','v','catalog'],
   array['retail_existing_funding_guard()','3a6e1e9d7014ad5951dda1686bdfa2d9','v','catalog'],
   array['retail_existing_funding_intent_clock_guard()','87aea421d94d5714532486c4b47c7434','v','catalog'],
   array['retail_existing_closed_object(jsonb,text[])','db187b3a1816eff7f3c2bac7b739fb60','i','catalog'],
   array['retail_existing_valid_offer(jsonb)','acd2d5e1e15c32bfb20e4d0f3439ffcb','i','public'],
   array['retail_existing_package(jsonb)','139a00920503f466304e89ac4bb934bb','i','public'],
   array['retail_existing_terms_months(jsonb,jsonb)','f9040629d7954ff583f68622d327ad2b','i','public']] loop
   select * into meta from pg_proc where oid=to_regprocedure('public.'||spec[1]);
   if not found or md5(meta.prosrc) is distinct from spec[2] or meta.prosecdef or meta.proisstrict
    or meta.provolatile::text<>spec[3]
    or meta.proconfig is distinct from(case spec[4] when 'public' then array['search_path=pg_catalog, public'] else array['search_path=pg_catalog'] end)
    or meta.proowner is distinct from(select oid from pg_roles where rolname='postgres')
    or not has_function_privilege('service_role',meta.oid,'EXECUTE')
    or exists(select 1 from aclexplode(coalesce(meta.proacl,acldefault('f',meta.proowner)))
     where grantee not in(meta.proowner,(select oid from pg_roles where rolname='service_role')))
    or(select count(*) from pg_proc where pronamespace=meta.pronamespace and proname=meta.proname)<>1
    then raise exception 'retail_recurring_source_prerequisite_drift';end if;
  end loop;
  perform public.retail_existing_funding_schema_guard();
  if not exists(select 1 from pg_trigger where tgrelid='public.membership_agreements'::regclass
   and tgname='retail_existing_checkout_attempt_guard' and tgfoid='public.retail_existing_checkout_attempt_guard()'::regprocedure
   and tgtype=31 and tgenabled='O' and not tgisinternal)
   or not exists(select 1 from pg_trigger where tgrelid='public.membership_agreements'::regclass
    and tgname='retail_existing_funding_guard' and tgfoid='public.retail_existing_funding_guard()'::regprocedure
    and tgtype=31 and tgenabled='O' and not tgisinternal)
   or not exists(select 1 from pg_trigger where tgrelid='public.public_purchase_intents'::regclass
    and tgname='retail_existing_funding_intent_clock_guard' and tgfoid='public.retail_existing_funding_intent_clock_guard()'::regprocedure
    and tgtype=23 and tgenabled='O' and not tgisinternal)
   then raise exception 'retail_recurring_source_trigger_drift';end if;
  if stage=0 then
   -- No unique agreement_id index exists here. Lock all current matches in ID
   -- order before strict lookup; a later insert is not reserved by this read.
   perform 1 from public.public_purchase_intents where agreement_id=p_agreement order by id for share;
   begin select * into strict i from public.public_purchase_intents where agreement_id=p_agreement for share;had_intent:=true;
   exception when no_data_found then had_intent:=false;when too_many_rows then raise exception 'retail_recurring_source_intent_ambiguous';end;
   select * into a from public.membership_agreements where id=p_agreement for share;
   if not found or a.client_id is distinct from p_client then raise exception 'retail_recurring_source_denied';end if;
   select * into c from public.clients where id=p_client for share;
   perform 1 from public.billing_customers where stripe_customer_id=a.checkout_attempt_source->>'customer_id' order by id for share;
  end if;
 end loop;
 clock:=clock_timestamp();s:=a.checkout_attempt_source;w:=a.retail_funding_receipt;b:=w->'proof'->'period';
 if a.template_version is distinct from 'membership_agreement_retail_terms_v2'
  or a.status is null or a.status not in('signed','active') or a.is_current is distinct from true
  or a.superseded_at is not null or a.superseded_by_agreement_id is not null or a.voided_at is not null
  or a.checkout_status is distinct from 'paid' or not coalesce(public.retail_existing_funding_receipt_valid(w,s),false)
  or a.checkout_session_id is distinct from b->>'checkout_session_id'
  or a.checkout_created_at is null or not isfinite(a.checkout_created_at) or a.checkout_created_at>clock
  or a.checkout_embedded is null or not coalesce(public.retail_existing_checkout_config_valid(s->'config'),false)
  then raise exception 'retail_recurring_source_denied';end if;
 paid:=(b->>'paid_at')::timestamptz;
 if not isfinite(paid) or paid>clock or a.checkout_paid_at is distinct from paid
  or not isfinite((w->>'recorded_at')::timestamptz) or (w->>'recorded_at')::timestamptz>clock
  then raise exception 'retail_recurring_source_clock_denied';end if;
 if had_intent then
  if a.template_snapshot->>'source' is null or a.template_snapshot->>'source' not in('public_purchase_intent','sales_assisted')
   or i.agreement_id is distinct from a.id or i.client_id is distinct from c.id
   or i.status is distinct from 'completed' or i.protocol is distinct from 'fenced_v2' or i.canceled_at is not null
   or i.activated_at is distinct from paid or i.stripe_checkout_session_id is distinct from a.checkout_session_id
   then raise exception 'retail_recurring_source_intent_denied';end if;
 else
  if coalesce(a.template_snapshot->>'source','admin')<>'admin' or a.template_snapshot->'purchase_intent' is not null
   or s->'intent' is distinct from 'null'::jsonb then raise exception 'retail_recurring_source_admin_denied';end if;
 end if;
 if c.id is null or c.parent_client_id is not null or c.archived_at is not null
  or c.stripe_customer_id is distinct from b->>'customer_id' or c.stripe_customer_id is distinct from s->>'customer_id'
  or c.stripe_subscription_id is distinct from b->>'subscription_id'
  or(select count(*) from public.billing_customers where stripe_customer_id=c.stripe_customer_id)<>1
  or not exists(select 1 from public.billing_customers where stripe_customer_id=c.stripe_customer_id and client_id=c.id)
  then raise exception 'retail_recurring_source_customer_denied';end if;
 if public.retail_existing_checkout_material(to_jsonb(a),case when had_intent then to_jsonb(i) else null end,c.stripe_customer_id)
  is distinct from s-'config' then raise exception 'retail_recurring_source_changed';end if;
 return jsonb_build_object('version','retail_existing_recurring_source_v1','agreement_id',a.id,'client_id',c.id,
  'source_intent_id',case when had_intent then i.id else null end,'package_snapshot',a.template_snapshot->'package_snapshot',
  'original_period',b,'original_provider_account_id',w->'proof'->'provider_account_id',
  'effect_authorized',false,'collection_ready',false,'paid_access_authorized',false,'payroll_authorized',false);
end $$;
revoke all on function public.read_retail_existing_recurring_source(uuid,uuid) from public,anon,authenticated;
grant execute on function public.read_retail_existing_recurring_source(uuid,uuid) to service_role;
-- Exercise catalog/lock privileges at install, with no matching data or DML.
set local role service_role;
do $verify$ begin
 begin perform public.read_retail_existing_recurring_source(null,null);
 exception when raise_exception then
  if SQLERRM<>'retail_recurring_source_denied' then raise;end if;
 end;
end $verify$;
reset role;
commit;
