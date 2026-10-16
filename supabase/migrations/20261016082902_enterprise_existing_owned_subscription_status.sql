-- LOCAL additive adaptation of the existing four-field provider-status CAS.
-- No provider call, financial/access/consent writer, row backfill or new API.
begin;
set local lock_timeout='10s';
do $baseline$
declare r record;p record;
begin
 for r in select * from(values
  ('record_enterprise_existing_subscription_observation(uuid,uuid,jsonb,jsonb,jsonb)','b6b9079c31c7c64b53d867c6b073af49',true),
  ('change_enterprise_existing_renewal(uuid,uuid,jsonb,text,boolean)','ff5c0dda695ac1c99ee3c7cb5d09e4b2',true),
  ('enterprise_existing_renewal_operation_valid(jsonb,jsonb,integer)','16754eb21b00047f3dcf6143606b3f49',false),
  ('enterprise_existing_renewal_guard()','93f424e1a20f0ca5d76cea57b0f4930a',false),
  ('read_enterprise_existing_billing(uuid)','6f0719620d7073a463b8fc6a6a8b4808',true),
  ('read_enterprise_existing_legal_window(uuid,uuid)','5092db76ad6873866402860dc7bec7a3',true)
 )v(signature,hash,bounded) loop
  select * into p from pg_proc where oid=to_regprocedure('public.'||r.signature);
  if not found or md5(p.prosrc) is distinct from r.hash or p.prosecdef or p.proretset or p.proisstrict
   or p.proparallel<>'u' or p.proleakproof or p.proargdefaults is not null or p.pronargdefaults<>0 or p.provariadic<>0
   or p.prorettype is distinct from(case when r.signature='enterprise_existing_renewal_guard()' then 'trigger'::regtype
    when r.signature='enterprise_existing_renewal_operation_valid(jsonb,jsonb,integer)' then 'boolean'::regtype else 'jsonb'::regtype end)
   or p.provolatile::text is distinct from(case when r.signature='enterprise_existing_renewal_operation_valid(jsonb,jsonb,integer)' then 'i' else 'v' end)
   or p.prolang is distinct from(select oid from pg_language where lanname='plpgsql')
   or p.proowner is distinct from(select oid from pg_roles where rolname='postgres')
   or p.proconfig is distinct from(case when r.bounded then array['search_path=pg_catalog','lock_timeout=10s'] else array['search_path=pg_catalog'] end)
   or has_function_privilege('anon',p.oid,'EXECUTE') or has_function_privilege('authenticated',p.oid,'EXECUTE')
   or not has_function_privilege('service_role',p.oid,'EXECUTE')
   or exists(select 1 from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner)))x
    where x.privilege_type='EXECUTE' and x.grantee not in(p.proowner,(select oid from pg_roles where rolname='service_role')))
   then raise exception 'enterprise_owned_status_prerequisite_drift';end if;
 end loop;
 if not exists(select 1 from pg_class where oid='public.clients'::regclass and relrowsecurity)
  or not has_table_privilege('service_role','public.clients','UPDATE')
  or not exists(select 1 from pg_trigger where tgrelid='public.clients'::regclass and tgname='enterprise_existing_renewal_guard' and tgenabled='O')
  then raise exception 'enterprise_owned_status_schema_drift';end if;
end $baseline$;
do $patch$
declare body text;def text;old text;replacement text;
begin
 select prosrc,pg_get_functiondef(oid) into body,def from pg_proc where oid='public.record_enterprise_existing_subscription_observation(uuid,uuid,jsonb,jsonb,jsonb)'::regprocedure;
 old:='offset_months integer;span integer;k text;';
 if position(old in body)=0 then raise exception 'enterprise_owned_status_patch_drift';end if;
 body:=replace(body,old,old||'explicit_ boolean;state_ jsonb;r jsonb;owned boolean;cutoff timestamptz;');
 old:=$x$ if not coalesce(public.retail_existing_closed_object(p,array['version','agreement_id','client_id','provider_account_id','livemode','currency',$x$;
 replacement:=$x$ explicit_:=coalesce(p->>'version'='enterprise_existing_subscription_status_proof_v2',false);
 if not coalesce(public.retail_existing_closed_object(p,array['version','agreement_id','client_id','provider_account_id','livemode','currency',$x$;
 if position(old in body)=0 then raise exception 'enterprise_owned_status_patch_drift';end if;body:=replace(body,old,replacement);
 old:=$x$'provider_period_start','provider_period_end','subscription_status','cancel_at_term_end','stripe_subscription_schedule_id','observed_at']),false)
  or p->>'version' is distinct from 'enterprise_existing_subscription_status_proof_v1'$x$;
 replacement:=$x$'provider_period_start','provider_period_end','subscription_status','cancel_at_term_end','stripe_subscription_schedule_id','observed_at']
   ||case when explicit_ then array['provider_cancel_at','renewal_operation_id'] else array[]::text[] end),false)
  or p->>'version' is null or p->>'version' not in('enterprise_existing_subscription_status_proof_v1','enterprise_existing_subscription_status_proof_v2')$x$;
 if position(old in body)=0 then raise exception 'enterprise_owned_status_patch_drift';end if;body:=replace(body,old,replacement);
 old:=$x$ if s<anchor then$x$;
 replacement:=$x$ if explicit_ then
  if s<anchor or jsonb_typeof(p->'provider_cancel_at') is distinct from 'number'
   or p->'provider_cancel_at' is distinct from p->'provider_period_end'
   or p->>'subscription_status' not in('active','past_due','unpaid','canceled') then raise exception 'enterprise_status_owned_cancel_denied';end if;
  state_:=public.change_enterprise_existing_renewal(a.id,c.id,w,'read',null);r:=state_->'operation';
  if r is null or r='null'::jsonb or r->>'version' is distinct from 'enterprise_existing_renewal_change_v2'
   or p->'renewal_operation_id' is distinct from r->'operation_id' then raise exception 'enterprise_status_owned_cancel_denied';end if;
  cutoff:=(r->>'effective_at')::timestamptz;
  owned:=r->'requested_auto_renew'='false'::jsonb and
    (r->'sent_at'<>'null'::jsonb or(r->>'status'='applied' and r->>'provider_cancel_operation_id' is not null))
   or r->'requested_auto_renew'='true'::jsonb and r->>'status' in('waiting','held','unknown') and r->>'provider_cancel_operation_id' is not null;
  if not coalesce(owned,false) or to_timestamp(e) is distinct from cutoff or to_timestamp(s)>=cutoff
   then raise exception 'enterprise_status_owned_cancel_denied';end if;
 end if;
 if s<anchor then$x$;
 if position(old in body)=0 then raise exception 'enterprise_owned_status_patch_drift';end if;body:=replace(body,old,replacement);
 old:=$x$   or public.retail_existing_month_anchor(to_timestamp(anchor),offset_months+span) is distinct from to_timestamp(e)$x$;
 replacement:=$x$   or(case when explicit_ then public.retail_existing_month_anchor(to_timestamp(anchor),offset_months+span)<to_timestamp(e)
    else public.retail_existing_month_anchor(to_timestamp(anchor),offset_months+span) is distinct from to_timestamp(e) end)$x$;
 if position(old in body)=0 then raise exception 'enterprise_owned_status_patch_drift';end if;body:=replace(body,old,replacement);
 execute replace(def,(select prosrc from pg_proc where oid='public.record_enterprise_existing_subscription_observation(uuid,uuid,jsonb,jsonb,jsonb)'::regprocedure),body);
end $patch$;
commit;
