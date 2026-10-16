-- LOCAL/UNMOUNTED provider-status CAS on existing clients. Provider status is
-- not cash, legal renewal consent or paid access. No new table or provider call.
begin;
set local lock_timeout='10s';
do $baseline$
declare r record;p record;
begin
 if to_regprocedure('public.record_enterprise_existing_subscription_observation(uuid,uuid,jsonb,jsonb,jsonb)') is not null
  then raise exception 'enterprise_status_schema_drift';end if;
 for r in select * from(values
  ('read_enterprise_existing_billing(uuid)','6f0719620d7073a463b8fc6a6a8b4808',true,'plpgsql','v','jsonb',false,false),
  ('enterprise_existing_billing_context(public.membership_agreements)','fb36dd4af607965a442a1e4fa73017b5',false,'plpgsql','v','void',false,false),
  ('enterprise_existing_paid_agreement_valid(public.membership_agreements)','c46a3752ad53dacc38ed6df1a6fd8f8c',false,'plpgsql','i','boolean',false,false),
  ('enterprise_existing_paid_pool_valid(public.membership_agreements,public.client_interview_pools)','6a7844c82a1a47bf277a017f9269d21a',false,'sql','i','boolean',false,false),
  ('retail_existing_month_anchor(timestamptz,integer)','215a4af8ed5457b66f11e6234f7f5741',false,'plpgsql','i','timestamptz',true,true),
  ('retail_existing_closed_object(jsonb,text[])','db187b3a1816eff7f3c2bac7b739fb60',false,'sql','i','boolean',false,false)
 )v(signature,hash,bounded,language,volatility,result_type,strict_flag,retail) loop
  select * into p from pg_proc where oid=to_regprocedure('public.'||r.signature);
  if not found or md5(p.prosrc) is distinct from r.hash or p.prosecdef or p.proretset or p.proisstrict is distinct from r.strict_flag
   or p.prolang is distinct from(select oid from pg_language where lanname=r.language)
   or p.provolatile::text is distinct from r.volatility or p.prorettype is distinct from r.result_type::regtype
   or p.proowner is distinct from(select oid from pg_roles where rolname='postgres')
   or p.proconfig is distinct from(case when r.retail then array['search_path=pg_catalog, public']
    when r.bounded then array['search_path=pg_catalog','lock_timeout=10s'] else array['search_path=pg_catalog'] end)
   or has_function_privilege('anon',p.oid,'EXECUTE') or has_function_privilege('authenticated',p.oid,'EXECUTE')
   or not has_function_privilege('service_role',p.oid,'EXECUTE')
   or exists(select 1 from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) x
    where x.privilege_type='EXECUTE' and x.grantee not in(p.proowner,(select oid from pg_roles where rolname='service_role')))
   then raise exception 'enterprise_status_prerequisite_drift';end if;
 end loop;
 if not exists(select 1 from pg_class where oid='public.clients'::regclass and relrowsecurity)
  or not has_table_privilege('service_role','public.clients','UPDATE')
  or not exists(select 1 from pg_attribute where attrelid='public.clients'::regclass
   and attname='stripe_subscription_schedule_id' and atttypid='text'::regtype and not attisdropped)
  then raise exception 'enterprise_status_table_drift';end if;
end $baseline$;

create function public.record_enterprise_existing_subscription_observation(p_agreement uuid,p_client uuid,p_billing jsonb,p_expected jsonb,p_proof jsonb)
returns jsonb language plpgsql volatile security invoker set search_path=pg_catalog set lock_timeout='10s' as $$
declare c public.clients;a public.membership_agreements;pool public.client_interview_pools;b public.billing_customers;
 w jsonb;f jsonb;p jsonb:=p_proof;clock timestamptz;anchor bigint;s bigint;e bigint;offset_months integer;span integer;k text;
begin
 if current_user<>'service_role' then raise exception 'enterprise_status_server_only';end if;
 select * into c from public.clients where id=p_client for update;
 if not found or c.parent_client_id is not null or c.archived_at is not null then raise exception 'enterprise_status_client_denied';end if;
 select * into a from public.membership_agreements where id=p_agreement for update;
 if not found or a.client_id is distinct from c.id or a.voided_at is not null then raise exception 'enterprise_status_source_denied';end if;
 select * into pool from public.client_interview_pools where id=a.enterprise_checkout_pool_id for update;
 if not found then raise exception 'enterprise_status_pool_denied';end if;
 select * into strict b from public.billing_customers where stripe_customer_id=c.stripe_customer_id order by id for share;
 w:=public.read_enterprise_existing_billing(a.id);f:=w->'funding_receipt'->'proof';clock:=clock_timestamp();
 if b.client_id is distinct from c.id or w is null or w is distinct from p_billing
  or not coalesce(public.enterprise_existing_paid_agreement_valid(a),false)
  or not coalesce(public.enterprise_existing_paid_pool_valid(a,pool),false)
  then raise exception 'enterprise_status_source_denied';end if;
 if not coalesce(public.retail_existing_closed_object(p_expected,array['subscription_status','current_term_end','stripe_subscription_schedule_id','cancel_at_term_end']),false)
  or p_expected->'subscription_status' is distinct from coalesce(to_jsonb(c.subscription_status),'null'::jsonb)
  or p_expected->'stripe_subscription_schedule_id' is distinct from coalesce(to_jsonb(c.stripe_subscription_schedule_id),'null'::jsonb)
  or p_expected->'cancel_at_term_end' is distinct from coalesce(to_jsonb(c.cancel_at_term_end),'null'::jsonb)
  or(case when p_expected->'current_term_end'='null'::jsonb then null else (p_expected->>'current_term_end')::timestamptz end) is distinct from c.current_term_end
  then raise exception 'enterprise_status_compare_changed';end if;
 if not coalesce(public.retail_existing_closed_object(p,array['version','agreement_id','client_id','provider_account_id','livemode','currency',
  'customer_id','subscription_id','subscription_item_id','price_id','platform_nominal_cents','platform_interval','billing_cycle_anchor',
  'provider_period_start','provider_period_end','subscription_status','cancel_at_term_end','stripe_subscription_schedule_id','observed_at']),false)
  or p->>'version' is distinct from 'enterprise_existing_subscription_status_proof_v1'
  or p->>'agreement_id' is distinct from a.id::text or p->>'client_id' is distinct from c.id::text
  or p->'provider_account_id' is distinct from f->'provider_account_id' or p->'livemode' is distinct from f->'livemode'
  or p->'currency' is distinct from f->'currency' or p->'customer_id' is distinct from f->'customer_id'
  or p->'subscription_id' is distinct from f->'subscription_id' or p->'subscription_item_id' is distinct from f->'platform_item_id'
  or p->'price_id' is distinct from f->'platform_price_id' or p->'platform_nominal_cents' is distinct from f->'platform_nominal_cents'
  or p->'platform_interval' is distinct from f->'platform_interval'
  or p->'billing_cycle_anchor' is distinct from w->'subscription'->'current_period_end'
  or p->>'subscription_status' not in('active','past_due','unpaid','canceled','incomplete','incomplete_expired','paused')
  or jsonb_typeof(p->'subscription_status') is distinct from 'string'
  or jsonb_typeof(p->'cancel_at_term_end') is distinct from 'boolean'
  or p->'stripe_subscription_schedule_id' is distinct from 'null'::jsonb
  or jsonb_typeof(p->'observed_at') is distinct from 'string' or p->>'observed_at' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'
  or not isfinite((p->>'observed_at')::timestamptz) or(p->>'observed_at')::timestamptz>clock
  or(p->>'observed_at')::timestamptz<(f->>'payment_success_at')::timestamptz
  then raise exception 'enterprise_status_proof_denied';end if;
 foreach k in array array['provider_period_start','provider_period_end'] loop
  if jsonb_typeof(p->k) is distinct from 'number' or p->>k !~ '^[1-9][0-9]*$'
   or(p->>k)::numeric>253402300799 then raise exception 'enterprise_status_period_denied';end if;
 end loop;
 s:=(p->>'provider_period_start')::bigint;e:=(p->>'provider_period_end')::bigint;anchor:=(w->'subscription'->>'current_period_end')::bigint;
 span:=case when f->>'platform_interval'='month' then 1 else 12 end;
 if e<=s or to_timestamp(s)>(p->>'observed_at')::timestamptz then raise exception 'enterprise_status_period_denied';end if;
 if s<anchor then
  if e<>anchor or to_timestamp(s)<date_trunc('second',(a.enterprise_checkout_source->>'created_at')::timestamptz)
   or to_timestamp(s)>(f->>'payment_success_at')::timestamptz then raise exception 'enterprise_status_period_denied';end if;
 else
  offset_months:=(extract(year from to_timestamp(s) at time zone 'UTC')::integer-extract(year from to_timestamp(anchor) at time zone 'UTC')::integer)*12
   +extract(month from to_timestamp(s) at time zone 'UTC')::integer-extract(month from to_timestamp(anchor) at time zone 'UTC')::integer;
  if offset_months<0 or offset_months%span<>0 or offset_months/span>999
   or public.retail_existing_month_anchor(to_timestamp(anchor),offset_months) is distinct from to_timestamp(s)
   or public.retail_existing_month_anchor(to_timestamp(anchor),offset_months+span) is distinct from to_timestamp(e)
   then raise exception 'enterprise_status_period_denied';end if;
 end if;
 -- Distinct writer from renewal preference. Later preference guard may permit
 -- this provider mirror only while auto_renew and legal fields stay unchanged.
 perform set_config('private_sales.enterprise_status_writer',c.id::text,true);
 update public.clients set subscription_status=p->>'subscription_status',current_term_end=to_timestamp(e),
  stripe_subscription_schedule_id=null,cancel_at_term_end=(p->>'cancel_at_term_end')::boolean where id=c.id;
 perform set_config('private_sales.enterprise_status_writer','',true);
 return jsonb_build_object('status','observed','agreement_id',a.id,'client_id',c.id,'source_digest',md5(w::text),
  'projection',jsonb_build_object('subscription_status',p->'subscription_status',
   'current_term_end',to_char(to_timestamp(e) at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
   'stripe_subscription_schedule_id',null,'cancel_at_term_end',p->'cancel_at_term_end'),
  'observed_at',to_char(clock at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'));
end $$;
revoke all on function public.record_enterprise_existing_subscription_observation(uuid,uuid,jsonb,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.record_enterprise_existing_subscription_observation(uuid,uuid,jsonb,jsonb,jsonb) to service_role;
commit;
