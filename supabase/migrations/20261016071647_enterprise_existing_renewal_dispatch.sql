-- LOCAL/UNMOUNTED. Extend the existing consent journal; no provider call,
-- receipt, access, contract, payroll, table or HTTP/worker is added here.
begin;
set local lock_timeout='10s';
do $baseline$
declare r record;p record;
begin
 if to_regprocedure('public.advance_enterprise_existing_renewal(uuid,uuid,jsonb,text,uuid,integer,jsonb)') is not null
  or to_regprocedure('public.enterprise_existing_renewal_observation_valid(jsonb,jsonb,jsonb)') is not null
  then raise exception 'enterprise_renewal_dispatch_schema_drift';end if;
 for r in select * from(values
  ('enterprise_existing_renewal_operation_valid(jsonb,jsonb,integer)','4b0450ecb918b6c2bab8e7d26597700f',false,'i','boolean','plpgsql',false,false),
  ('change_enterprise_existing_renewal(uuid,uuid,jsonb,text,boolean)','62695d61368127bf07c80d721ce57051',true,'v','jsonb','plpgsql',false,false),
  ('read_enterprise_existing_legal_window(uuid,uuid)','5092db76ad6873866402860dc7bec7a3',true,'v','jsonb','plpgsql',false,false),
  ('read_enterprise_existing_billing(uuid)','6f0719620d7073a463b8fc6a6a8b4808',true,'v','jsonb','plpgsql',false,false),
  ('enterprise_existing_renewal_guard()','93f424e1a20f0ca5d76cea57b0f4930a',false,'v','trigger','plpgsql',false,false),
  ('retail_existing_closed_object(jsonb,text[])','db187b3a1816eff7f3c2bac7b739fb60',false,'i','boolean','sql',false,false),
  ('retail_existing_month_anchor(timestamptz,integer)','215a4af8ed5457b66f11e6234f7f5741',false,'i','timestamptz','plpgsql',true,true)
 )v(signature,hash,bounded,volatility,result_type,language,strict_flag,retail) loop
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
   then raise exception 'enterprise_renewal_dispatch_prerequisite_drift';end if;
 end loop;
 if not exists(select 1 from pg_class where oid='public.clients'::regclass and relrowsecurity)
  or not exists(select 1 from pg_class where oid='public.billing_events'::regclass and relrowsecurity)
  or not exists(select 1 from pg_trigger where tgrelid='public.clients'::regclass and tgname='enterprise_existing_renewal_guard'
   and tgenabled='O' and tgtype=23 and tgfoid='public.enterprise_existing_renewal_guard()'::regprocedure)
  then raise exception 'enterprise_renewal_dispatch_table_drift';end if;
end $baseline$;

-- Trusted service observation, NOT a cash receipt. The finalized full nominal
-- platform invoice may be OPEN: an OFF request never forgives owed debt.
create function public.enterprise_existing_renewal_observation_valid(o jsonb,w jsonb,r jsonb)
returns boolean language plpgsql immutable security invoker set search_path=pg_catalog as $$
declare p jsonb:=o->'subscription';i jsonb:=o->'invoice';f jsonb:=w->'funding_receipt'->'proof';
 s bigint;e bigint;anchor bigint;full_end timestamptz;cutoff timestamptz:=(r->>'effective_at')::timestamptz;
 offset_m integer;span integer;k text;owned boolean;
begin
 if not coalesce(public.retail_existing_closed_object(o,array['version','provider_account_id','subscription','invoice','census_digest','observed_at']),false)
  or o->>'version' is distinct from 'enterprise_existing_renewal_observation_v1'
  or o->'provider_account_id' is distinct from f->'provider_account_id'
  or jsonb_typeof(o->'census_digest') is distinct from 'string' or o->>'census_digest' !~ '^[0-9a-f]{64}$'
  or jsonb_typeof(o->'observed_at') is distinct from 'string'
  or o->>'observed_at' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'
  or not coalesce(public.retail_existing_closed_object(p,array['subscription_id','customer_id','livemode','currency','price_id',
   'subscription_item_id','unit_amount','interval','quantity','billing_cycle_anchor','current_period_start','current_period_end',
   'status','cancel_at_period_end','cancel_at','test_clock','schedule','pause_collection','trial_start','trial_end']),false)
  or p->'subscription_id' is distinct from f->'subscription_id' or p->'customer_id' is distinct from f->'customer_id'
  or p->'livemode' is distinct from f->'livemode' or p->'currency' is distinct from f->'currency'
  or p->'price_id' is distinct from f->'platform_price_id' or p->'subscription_item_id' is distinct from f->'platform_item_id'
  or p->'unit_amount' is distinct from f->'platform_nominal_cents' or p->'interval' is distinct from f->'platform_interval'
  or p->'quantity' is distinct from '1'::jsonb or p->'billing_cycle_anchor' is distinct from w->'subscription'->'current_period_end'
  or jsonb_typeof(p->'status') is distinct from 'string' or p->>'status' not in('active','past_due','unpaid','canceled')
  or jsonb_typeof(p->'cancel_at_period_end') is distinct from 'boolean'
  or p->'test_clock' is distinct from 'null'::jsonb or p->'schedule' is distinct from 'null'::jsonb
  or p->'pause_collection' is distinct from 'null'::jsonb or p->'trial_start' is distinct from 'null'::jsonb or p->'trial_end' is distinct from 'null'::jsonb
  then return false;end if;
 foreach k in array array['current_period_start','current_period_end'] loop
  if jsonb_typeof(p->k) is distinct from 'number' or p->>k !~ '^[1-9][0-9]*$' or(p->>k)::numeric>253402300799 then return false;end if;
 end loop;
 s:=(p->>'current_period_start')::bigint;e:=(p->>'current_period_end')::bigint;anchor:=(w->'subscription'->>'current_period_end')::bigint;
 span:=case f->>'platform_interval' when 'month' then 1 when 'year' then 12 else null end;
 offset_m:=(extract(year from to_timestamp(s) at time zone 'UTC')::integer-extract(year from to_timestamp(anchor) at time zone 'UTC')::integer)*12
  +extract(month from to_timestamp(s) at time zone 'UTC')::integer-extract(month from to_timestamp(anchor) at time zone 'UTC')::integer;
 if span is null or s<anchor or offset_m<0 or offset_m%span<>0 or offset_m/span>999
  or public.retail_existing_month_anchor(to_timestamp(anchor),offset_m) is distinct from to_timestamp(s) then return false;end if;
 full_end:=public.retail_existing_month_anchor(to_timestamp(anchor),offset_m+span);
 if to_timestamp(s)>=cutoff or full_end<cutoff or e<=s or to_timestamp(s)>(o->>'observed_at')::timestamptz then return false;end if;
 owned:=r->'requested_auto_renew'='false'::jsonb and r->'sent_at'<>'null'::jsonb
  or r->'requested_auto_renew'='true'::jsonb and r->>'provider_cancel_operation_id' is not null;
 if p->'cancel_at' is distinct from 'null'::jsonb then
  if not coalesce(owned,false) or jsonb_typeof(p->'cancel_at') is distinct from 'number'
   or p->>'cancel_at' !~ '^[1-9][0-9]*$' or(p->>'cancel_at')::numeric>253402300799
   or to_timestamp((p->>'cancel_at')::bigint) is distinct from cutoff
   or to_timestamp(e) is distinct from cutoff then return false;end if;
 elsif to_timestamp(e) is distinct from full_end then return false;end if;
 if not coalesce(public.retail_existing_closed_object(i,array['id','subscription_id','customer_id','livemode','currency','price_id',
  'subscription_item_id','unit_amount','quantity','period_start','period_end','status','finalized_at']),false)
  or jsonb_typeof(i->'id') is distinct from 'string' or i->>'id' !~ '^in_[A-Za-z0-9_]{1,252}$'
  or i->'subscription_id' is distinct from f->'subscription_id' or i->'customer_id' is distinct from f->'customer_id'
  or i->'livemode' is distinct from f->'livemode' or i->'currency' is distinct from f->'currency'
  or i->'price_id' is distinct from f->'platform_price_id' or i->'subscription_item_id' is distinct from f->'platform_item_id'
  or i->'unit_amount' is distinct from f->'platform_nominal_cents' or i->'quantity' is distinct from '1'::jsonb
  or i->'period_start' is distinct from p->'current_period_start' or jsonb_typeof(i->'period_end') is distinct from 'number'
  or i->>'period_end' !~ '^[1-9][0-9]*$' or(i->>'period_end')::numeric>253402300799
  or to_timestamp((i->>'period_end')::bigint) is distinct from full_end
  or i->>'status' is null or i->>'status' not in('open','paid') or jsonb_typeof(i->'finalized_at') is distinct from 'number'
  or i->>'finalized_at' !~ '^[1-9][0-9]*$' or(i->>'finalized_at')::numeric>253402300799
  or to_timestamp((i->>'finalized_at')::bigint)>(o->>'observed_at')::timestamptz then return false;end if;
 return coalesce(isfinite((o->>'observed_at')::timestamptz) and(o->>'observed_at')::timestamptz>=(f->>'payment_success_at')::timestamptz,false);
exception when others then return false;
end $$;

-- Preserve old waiting-v1 rows. Every new request uses v2. These functions are
-- structural trusted-service gates, not protection against malicious service SQL.
do $validator$
declare body text;def text;old text;replacement text;
begin
 select prosrc,pg_get_functiondef(oid) into body,def from pg_proc where oid='public.enterprise_existing_renewal_operation_valid(jsonb,jsonb,integer)'::regprocedure;
 old:=$old$begin
 if not coalesce$old$;
 replacement:=$new$begin
 if r->>'version'='enterprise_existing_renewal_change_v2' then
  if not coalesce(public.retail_existing_closed_object(r,array['version','operation_id','source','source_digest',
   'requested_auto_renew','accepted_at','effective_at','notice_cutoff_at','term_index','status','generation',
   'lease_until','sent_at','observation','completed_at','repair_sent_at','provider_cancel_operation_id']),false)
   or jsonb_typeof(r->'generation') is distinct from 'number' or r->>'generation' !~ '^[0-9]+$'
   or(r->>'generation')::numeric>1000000 or jsonb_typeof(r->'status') is distinct from 'string'
   or r->>'status' not in('waiting','claimed','unknown','applied','held')
   or(r->'provider_cancel_operation_id'<>'null'::jsonb and(jsonb_typeof(r->'provider_cancel_operation_id') is distinct from 'string'
    or r->>'provider_cancel_operation_id' !~ '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$'
    or r->'requested_auto_renew' is distinct from 'true'::jsonb or r->'provider_cancel_operation_id'=r->'operation_id')) then return false;end if;
  foreach k in array array['lease_until','sent_at','completed_at','repair_sent_at'] loop
   if r->k<>'null'::jsonb and(jsonb_typeof(r->k) is distinct from 'string' or not isfinite((r->>k)::timestamptz)
    or(r->>k)::timestamptz<(r->>'accepted_at')::timestamptz) then return false;end if;
  end loop;
  if r->>'status'='waiting' then
   if r->'generation'<>'0'::jsonb or r->'lease_until'<>'null'::jsonb or r->'sent_at'<>'null'::jsonb
    or r->'observation'<>'null'::jsonb or r->'completed_at'<>'null'::jsonb or r->'repair_sent_at'<>'null'::jsonb then return false;end if;
  elsif r->>'status'='held' and r->'generation'='0'::jsonb then
   if r->'lease_until'<>'null'::jsonb or r->'sent_at'<>'null'::jsonb or r->'observation'<>'null'::jsonb
    or r->'completed_at'<>'null'::jsonb or r->'repair_sent_at'<>'null'::jsonb then return false;end if;
  else
   if(r->>'generation')::integer<1 or not coalesce(public.enterprise_existing_renewal_observation_valid(r->'observation',w,r),false)
    or(r->>'status' in('claimed','unknown') and r->'lease_until'='null'::jsonb)
    or(r->>'status'='unknown' and r->'sent_at'='null'::jsonb)
    or(r->>'status'='applied' and(r->'completed_at'='null'::jsonb or r->'lease_until'<>'null'::jsonb))
    or(r->>'status'<>'applied' and r->'completed_at'<>'null'::jsonb)
    or(r->'repair_sent_at'<>'null'::jsonb and(r->'sent_at'='null'::jsonb or r->>'provider_cancel_operation_id' is null)) then return false;end if;
   if r->>'status'='applied' and(case when r->'requested_auto_renew'='true'::jsonb then
    r->'observation'->'subscription'->'cancel_at'<>'null'::jsonb or r->'observation'->'subscription'->'cancel_at_period_end'<>'false'::jsonb
     or r->'observation'->'subscription'->>'status'='canceled'
    else r->'sent_at'='null'::jsonb or r->'observation'->'subscription'->'cancel_at'='null'::jsonb end) then return false;end if;
  end if;
  -- Reuse the original immutable source/calendar/notice acceptance validator.
  return public.enterprise_existing_renewal_operation_valid((r-'repair_sent_at'-'provider_cancel_operation_id')||jsonb_build_object(
   'version','enterprise_existing_renewal_change_v1','status','waiting','generation',0,'lease_until',null,'sent_at',null,'observation',null,'completed_at',null),w,n);
 end if;
 if not coalesce$new$;
 if position(old in body)=0 then raise exception 'enterprise_renewal_dispatch_patch_drift';end if;
 body:=replace(body,'span_ jsonb;i integer;','span_ jsonb;i integer;k text;');
 body:=replace(body,old,replacement);execute replace(def,(select prosrc from pg_proc where oid='public.enterprise_existing_renewal_operation_valid(jsonb,jsonb,integer)'::regprocedure),body);
end $validator$;

-- Keep the existing five-argument preference RPC, its locks, deadlines, audit
-- and legal-window authority. Never replace ambiguous/sent effects blindly.
do $request$
declare body text;def text;old text;
begin
 select prosrc,pg_get_functiondef(oid) into body,def from pg_proc where oid='public.change_enterprise_existing_renewal(uuid,uuid,jsonb,text,boolean)'::regprocedure;
 old:=$x$  if clock>=end_ or (not p_auto_renew and clock>=cutoff) then$x$;
 if position(old in body)=0 then raise exception 'enterprise_renewal_dispatch_patch_drift';end if;
 body:=replace(body,old,$x$  if r is not null and (r->>'status' in('claimed','unknown')
   or(r->'sent_at'<>'null'::jsonb and r->>'status'<>'applied')) then
   return jsonb_build_object('status','busy','operation',r,'legal_term_end',end_,'notice_cutoff_at',cutoff,
    'provider_effect_authorized',false,'paid_access_authorized',false,'payroll_authorized',false);
  end if;
$x$||old);
 body:=replace(body,$x$'version','enterprise_existing_renewal_change_v1','operation_id',operation$x$,
  $x$'version','enterprise_existing_renewal_change_v2','operation_id',operation$x$);
 old:=$x$'status','waiting','generation',0,'lease_until',null,'sent_at',null,'observation',null,'completed_at',null);$x$;
 if position(old in body)=0 then raise exception 'enterprise_renewal_dispatch_patch_drift';end if;
 body:=replace(body,old,$x$'status','waiting','generation',0,'lease_until',null,'sent_at',null,'observation',null,'completed_at',null,
   'repair_sent_at',null,'provider_cancel_operation_id',case
    when p_auto_renew and prior->>'status'='applied' and prior->'requested_auto_renew'='false'::jsonb
     and(prior->>'effective_at')::timestamptz=end_ and prior->'sent_at'<>'null'::jsonb then prior->'operation_id'
    when p_auto_renew then prior->'provider_cancel_operation_id' else null end);$x$);
 execute replace(def,(select prosrc from pg_proc where oid='public.change_enterprise_existing_renewal(uuid,uuid,jsonb,text,boolean)'::regprocedure),body);
end $request$;

create function public.advance_enterprise_existing_renewal(p_agreement uuid,p_client uuid,p_billing jsonb,p_action text,
 p_operation uuid,p_generation integer,p_observation jsonb)
returns jsonb language plpgsql volatile security invoker set search_path=pg_catalog set lock_timeout='10s' as $$
declare c public.clients;state_ jsonb;r jsonb;w jsonb;o jsonb:=p_observation;p jsonb;clock timestamptz;end_ timestamptz;
 status_ text;fact text;matches boolean;now_text text;generation integer;n integer;
begin
 if current_user<>'service_role' then raise exception 'enterprise_renewal_dispatch_server_only';end if;
 if p_action is null or p_action not in('claim','send','repair','unknown','finish','hold','reject')
  then raise exception 'enterprise_renewal_dispatch_action_denied';end if;
 -- SAME root->agreement->pool->owner->coverage locks and accepted preference.
 state_:=public.change_enterprise_existing_renewal(p_agreement,p_client,p_billing,'read',null);
 select * into strict c from public.clients where id=p_client;r:=state_->'operation';
 -- Native jsonb rendering owns the source digest, not JS numeric formatting.
 w:=public.read_enterprise_existing_billing(p_agreement);clock:=clock_timestamp();
 now_text:=to_char(clock at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"');
 if r->>'version'='enterprise_existing_renewal_change_v1' then
  -- Existing accepted waiting consent keeps its original identity and dates.
  r:=r||jsonb_build_object('version','enterprise_existing_renewal_change_v2','repair_sent_at',null,'provider_cancel_operation_id',null);
 end if;
 if r is null or r='null'::jsonb or r->>'version' is distinct from 'enterprise_existing_renewal_change_v2'
  or r->>'operation_id' is distinct from p_operation::text or r->'generation' is distinct from to_jsonb(p_generation)
  then raise exception 'enterprise_renewal_dispatch_identity_denied';end if;
 status_:=r->>'status';generation:=p_generation;end_:=(r->>'effective_at')::timestamptz;
 if status_ in('applied','held') then return state_;end if;
 if p_action='hold' then
  if status_ in('claimed','unknown') or r->'sent_at'<>'null'::jsonb then return state_;end if;
  r:=r||jsonb_build_object('status','held');fact:='held';
 elsif p_action='unknown' then
  if status_<>'claimed' or r->'sent_at'='null'::jsonb or o is distinct from r->'observation'
   then raise exception 'enterprise_renewal_dispatch_unknown_denied';end if;
  r:=r||jsonb_build_object('status','unknown','lease_until',now_text);fact:='unknown-'||generation::text;
 elsif p_action='reject' then
  if status_<>'claimed' or r->'sent_at'='null'::jsonb or(r->>'lease_until')::timestamptz<=clock or o is distinct from r->'observation'
   then raise exception 'enterprise_renewal_dispatch_rejection_denied';end if;
  r:=r||jsonb_build_object('status','held','lease_until',null);fact:='setting-rejected';
 else
  if not coalesce(public.enterprise_existing_renewal_observation_valid(o,w,r),false)
   or(o->>'observed_at')::timestamptz>clock or(o->>'observed_at')::timestamptz<clock-interval '30 seconds'
   then raise exception 'enterprise_renewal_dispatch_observation_denied';end if;
  p:=o->'subscription';
  matches:=case when r->'requested_auto_renew'='true'::jsonb then p->>'status'<>'canceled'
   and p->'cancel_at'='null'::jsonb and p->'cancel_at_period_end'='false'::jsonb
   else p->'cancel_at'<>'null'::jsonb and to_timestamp((p->>'cancel_at')::bigint)=end_ end;
  if p_action='claim' then
   if status_ in('claimed','unknown') and(r->>'lease_until')::timestamptz>clock then
    return state_||jsonb_build_object('status','busy');end if;
   if r->'sent_at'<>'null'::jsonb and not coalesce(matches,false) then
    -- No timeout retry, different body or different idempotency identity.
    return state_||jsonb_build_object('status','unknown');end if;
   if not coalesce(matches,false) and (p->>'status' not in('active','past_due','unpaid') or end_<=clock) then
    return state_||jsonb_build_object('status','waiting');end if;
   if r->'sent_at'<>'null'::jsonb and (o-'observed_at'-'subscription') is distinct from((r->'observation')-'observed_at'-'subscription')
    then raise exception 'enterprise_renewal_dispatch_census_changed';end if;
   if generation>=1000000 then raise exception 'enterprise_renewal_dispatch_generation_denied';end if;
   r:=r||jsonb_build_object('status','claimed','generation',generation+1,'lease_until',clock+interval '120 seconds','observation',o);
   fact:='claim-'||(generation+1)::text;
  else
   if status_<>'claimed' or(r->>'lease_until')::timestamptz<=clock or(p_action<>'finish' and end_<=clock)
    then raise exception 'enterprise_renewal_dispatch_claim_expired';end if;
   if(o-'observed_at'-'subscription') is distinct from((r->'observation')-'observed_at'-'subscription')
    or(p-'cancel_at'-'cancel_at_period_end'-'current_period_end') is distinct from((r->'observation'->'subscription')-'cancel_at'-'cancel_at_period_end'-'current_period_end')
    then raise exception 'enterprise_renewal_dispatch_census_changed';end if;
   if p_action='finish' then
    if not coalesce(matches,false) then raise exception 'enterprise_renewal_dispatch_readback_denied';end if;
    r:=r||jsonb_build_object('status','applied','observation',o,'completed_at',now_text,'lease_until',null);fact:='applied';
   elsif p_action='send' then
    if r->'sent_at'<>'null'::jsonb or p->>'status' not in('active','past_due','unpaid') then raise exception 'enterprise_renewal_dispatch_send_denied';end if;
    r:=r||jsonb_build_object('sent_at',now_text);fact:='send-'||generation::text;
   elsif p_action='repair' then
    if r->'requested_auto_renew'<>'true'::jsonb or r->>'provider_cancel_operation_id' is null
     or r->'sent_at'='null'::jsonb or r->'repair_sent_at'<>'null'::jsonb or p->>'status' not in('active','past_due','unpaid')
     or p->'cancel_at_period_end'<>'false'::jsonb or p->'cancel_at'='null'::jsonb
     then raise exception 'enterprise_renewal_dispatch_repair_denied';end if;
    r:=r||jsonb_build_object('repair_sent_at',now_text);fact:='repair-'||generation::text;
   else raise exception 'enterprise_renewal_dispatch_action_denied';end if;
  end if;
 end if;
 select notice_deadline_days into strict n from public.membership_agreements where id=p_agreement;
 if not coalesce(public.enterprise_existing_renewal_operation_valid(r,w,n),false)
  then raise exception 'enterprise_renewal_dispatch_result_denied';end if;
 perform set_config('private_sales.enterprise_renewal_writer',c.id::text,true);
 update public.clients set enterprise_renewal_change=r where id=c.id;
 perform set_config('private_sales.enterprise_renewal_writer','',true);
 insert into public.billing_events(stripe_event_id,type,processed_ok,client_id,payload)
  values('enterprise-renewal:'||p_operation::text||':'||fact,'enterprise.renewal.'||fact,true,c.id,
   jsonb_build_object('operation_id',p_operation,'fact',fact,'requested_auto_renew',r->'requested_auto_renew',
    'effective_at',r->'effective_at','generation',r->'generation','recorded_at',now_text)) on conflict(stripe_event_id) do nothing;
 if p_action in('claim','send','repair') and ((r->>'lease_until')::timestamptz<=clock_timestamp()
  or(p_action<>'claim' and end_<=clock_timestamp())) then raise exception 'enterprise_renewal_dispatch_claim_expired';end if;
 return jsonb_build_object('status',r->>'status','operation',r,'provider_effect_authorized',false,'paid_access_authorized',false,'payroll_authorized',false);
end $$;
revoke all on function public.enterprise_existing_renewal_observation_valid(jsonb,jsonb,jsonb),
 public.advance_enterprise_existing_renewal(uuid,uuid,jsonb,text,uuid,integer,jsonb) from public,anon,authenticated;
grant execute on function public.enterprise_existing_renewal_observation_valid(jsonb,jsonb,jsonb),
 public.advance_enterprise_existing_renewal(uuid,uuid,jsonb,text,uuid,integer,jsonb) to service_role;
commit;
