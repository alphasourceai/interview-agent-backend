-- LOCAL/UNMOUNTED consent kernel, not a provider dispatch or renewal engine.
-- Reuses clients + billing_events. The initial legal window is frozen in the
-- original billing receipt. Later-window projection/dispatch are separate gates.
begin;
set local lock_timeout='10s';
do $baseline$
declare r record;p record;
begin
 if exists(select 1 from pg_attribute where attrelid='public.clients'::regclass
  and attname='enterprise_renewal_change' and not attisdropped)
  or exists(select 1 from pg_proc where pronamespace='public'::regnamespace
   and proname in('enterprise_existing_renewal_guard','enterprise_existing_renewal_operation_valid','change_enterprise_existing_renewal'))
  then raise exception 'enterprise_renewal_schema_drift';end if;
 for r in select * from(values
  ('read_enterprise_existing_billing(uuid)','6f0719620d7073a463b8fc6a6a8b4808',true,'plpgsql','v','jsonb'),
  ('enterprise_existing_paid_agreement_valid(public.membership_agreements)','c46a3752ad53dacc38ed6df1a6fd8f8c',false,'plpgsql','i','boolean'),
  ('enterprise_existing_paid_pool_valid(public.membership_agreements,public.client_interview_pools)','6a7844c82a1a47bf277a017f9269d21a',false,'sql','i','boolean'),
  ('retail_existing_closed_object(jsonb,text[])','db187b3a1816eff7f3c2bac7b739fb60',false,'sql','i','boolean')
 )v(signature,hash,bounded,language,volatility,result_type) loop
  select * into p from pg_proc where oid=to_regprocedure('public.'||r.signature);
  if not found or md5(p.prosrc) is distinct from r.hash or p.prosecdef or p.proretset or p.proisstrict
   or p.prolang is distinct from(select oid from pg_language where lanname=r.language)
   or p.provolatile::text is distinct from r.volatility or p.prorettype is distinct from r.result_type::regtype
   or p.proowner is distinct from(select oid from pg_roles where rolname='postgres')
   or p.proconfig is distinct from(case when r.bounded then array['search_path=pg_catalog','lock_timeout=10s'] else array['search_path=pg_catalog'] end)
   or has_function_privilege('anon',p.oid,'EXECUTE') or has_function_privilege('authenticated',p.oid,'EXECUTE')
   or not has_function_privilege('service_role',p.oid,'EXECUTE')
   or exists(select 1 from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) x
    where x.privilege_type='EXECUTE' and x.grantee not in(p.proowner,(select oid from pg_roles where rolname='service_role')))
   then raise exception 'enterprise_renewal_prerequisite_drift';end if;
 end loop;
 if exists(select 1 from pg_class where oid in('public.clients'::regclass,'public.membership_agreements'::regclass,
   'public.client_interview_pools'::regclass,'public.billing_customers'::regclass,'public.billing_events'::regclass) and not relrowsecurity)
  or not has_table_privilege('service_role','public.clients','UPDATE')
  or not has_table_privilege('service_role','public.billing_events','INSERT')
  or not exists(select 1 from pg_attribute where attrelid='public.clients'::regclass
   and attname='retail_renewal_change' and atttypid='jsonb'::regtype and not attisdropped)
  then raise exception 'enterprise_renewal_table_drift';end if;
end $baseline$;
alter table public.clients add column enterprise_renewal_change jsonb;

-- Structural trusted-service attestation, not defense against malicious SQL
-- running as a privileged role. No caller clock, provider proof or effects yet.
create function public.enterprise_existing_renewal_operation_valid(r jsonb,w jsonb,n integer)
returns boolean language plpgsql immutable security invoker set search_path=pg_catalog as $$
declare at_ timestamptz;end_ timestamptz;cutoff timestamptz;
begin
 if not coalesce(public.retail_existing_closed_object(r,array['version','operation_id','source','source_digest',
  'requested_auto_renew','accepted_at','effective_at','notice_cutoff_at','term_index','status','generation',
  'lease_until','sent_at','observation','completed_at']),false)
  or r->>'version' is distinct from 'enterprise_existing_renewal_change_v1'
  or r->'source' is distinct from w or r->>'source_digest' is distinct from md5(w::text)
  or jsonb_typeof(r->'operation_id') is distinct from 'string'
  or r->>'operation_id' !~ '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$'
  or jsonb_typeof(r->'requested_auto_renew') is distinct from 'boolean'
  or r->'term_index' is distinct from '0'::jsonb or r->>'status' is distinct from 'waiting'
  or r->'generation' is distinct from '0'::jsonb or r->'lease_until' is distinct from 'null'::jsonb
  or r->'sent_at' is distinct from 'null'::jsonb or r->'observation' is distinct from 'null'::jsonb
  or r->'completed_at' is distinct from 'null'::jsonb or n is null or n not between 1 and 3660
  then return false;end if;
 if jsonb_typeof(r->'accepted_at') is distinct from 'string'
  or r->>'accepted_at' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{6}Z$'
  or jsonb_typeof(r->'effective_at') is distinct from 'string'
  or jsonb_typeof(r->'notice_cutoff_at') is distinct from 'string' then return false;end if;
 at_:=(r->>'accepted_at')::timestamptz;end_:=(w->'client_initial'->>'contract_end_at')::timestamptz;
 cutoff:=((end_ at time zone 'UTC')-make_interval(days=>n)) at time zone 'UTC';
 return coalesce(isfinite(at_) and at_>=(w->>'applied_at')::timestamptz
  and at_<end_ and (r->'requested_auto_renew'='true'::jsonb or at_<cutoff)
  and (r->>'effective_at')::timestamptz=end_ and (r->>'notice_cutoff_at')::timestamptz=cutoff,false);
exception when others then return false;
end $$;

create function public.enterprise_existing_renewal_guard()
returns trigger language plpgsql volatile security invoker set search_path=pg_catalog as $$
declare paid_marked boolean;
begin
 if TG_OP='INSERT' then
  if new.enterprise_renewal_change is not null then raise exception 'enterprise_renewal_writer_required';end if;
  return new;
 end if;
 if new.enterprise_renewal_change is distinct from old.enterprise_renewal_change then
  if current_user<>'service_role' or current_setting('private_sales.enterprise_renewal_writer',true) is distinct from new.id::text
   then raise exception 'enterprise_renewal_writer_required';end if;
 end if;
 if new.auto_renew is not distinct from old.auto_renew and new.cancel_at_term_end is not distinct from old.cancel_at_term_end
  and new.contract_start_at is not distinct from old.contract_start_at and new.contract_end_at is not distinct from old.contract_end_at
  and new.cancel_effective_at is not distinct from old.cancel_effective_at then return new;end if;
 select exists(select 1 from public.membership_agreements a where a.client_id=old.id and a.is_current is true
  and a.checkout_status='paid' and a.checkout_paid_at is not null
  and (a.enterprise_checkout_source is not null or a.enterprise_checkout_pool_id is not null or a.enterprise_checkout_prices is not null
   or a.enterprise_funding_receipt is not null or a.enterprise_billing_receipt is not null)) into paid_marked;
 -- Unchanged stale journals do not seize a later retail or legacy contract.
 if not paid_marked then return new;end if;
 if current_user='service_role' and new.enterprise_renewal_change is not distinct from old.enterprise_renewal_change
  and new.auto_renew is not distinct from old.auto_renew and new.contract_start_at is not distinct from old.contract_start_at
  and new.contract_end_at is not distinct from old.contract_end_at and new.cancel_effective_at is not distinct from old.cancel_effective_at
  and current_setting('private_sales.enterprise_status_writer',true)=new.id::text then return new;end if;
 if current_user<>'service_role' or current_setting('private_sales.enterprise_renewal_writer',true) is distinct from new.id::text
  then raise exception 'enterprise_renewal_writer_required';end if;
 return new;
end $$;
create trigger enterprise_existing_renewal_guard before insert or update on public.clients
 for each row execute function public.enterprise_existing_renewal_guard();

create function public.change_enterprise_existing_renewal(p_agreement uuid,p_client uuid,p_billing jsonb,p_action text,p_auto_renew boolean)
returns jsonb language plpgsql volatile security invoker set search_path=pg_catalog set lock_timeout='10s' as $$
declare c public.clients;a public.membership_agreements;pool public.client_interview_pools;b public.billing_customers;
 w jsonb;v jsonb;r jsonb;prior jsonb;clock timestamptz;end_ timestamptz;cutoff timestamptz;n integer;at_text text;operation uuid;
begin
 if current_user<>'service_role' then raise exception 'enterprise_renewal_server_only';end if;
 if p_action is null or p_action not in('read','request') or (p_action='read' and p_auto_renew is not null)
  or (p_action='request' and p_auto_renew is null) then raise exception 'enterprise_renewal_action_denied';end if;
 select * into c from public.clients where id=p_client for update;
 if not found or c.parent_client_id is not null or c.archived_at is not null then raise exception 'enterprise_renewal_client_denied';end if;
 select * into a from public.membership_agreements where id=p_agreement for update;
 if not found or a.client_id is distinct from c.id or a.voided_at is not null then raise exception 'enterprise_renewal_source_denied';end if;
 select * into pool from public.client_interview_pools where id=a.enterprise_checkout_pool_id for update;
 if not found then raise exception 'enterprise_renewal_pool_denied';end if;
 select * into strict b from public.billing_customers where stripe_customer_id=c.stripe_customer_id order by id for share;
 w:=public.read_enterprise_existing_billing(a.id);v:=a.template_snapshot->'values';clock:=clock_timestamp();
 if b.client_id is distinct from c.id or w is null or w is distinct from p_billing
  or not coalesce(public.enterprise_existing_paid_agreement_valid(a),false)
  or not coalesce(public.enterprise_existing_paid_pool_valid(a,pool),false)
  or c.plan_tier is distinct from 'enterprise' or c.billing_interval is distinct from w->'client_initial'->>'billing_interval'
  or c.contract_start_at is distinct from(w->'client_initial'->>'contract_start_at')::timestamptz
  or c.contract_end_at is distinct from(w->'client_initial'->>'contract_end_at')::timestamptz
  then raise exception 'enterprise_renewal_source_denied';end if;
 -- No invented reminder/default: the executed text owns the notice period.
 if jsonb_typeof(v->'notice_deadline_plain') is distinct from 'string' or v->>'notice_deadline_plain' !~ '^[1-9][0-9]{0,3}$'
  then raise exception 'enterprise_renewal_notice_denied';end if;
 n:=(v->>'notice_deadline_plain')::integer;
 if n>3660 or v->>'notice_deadline_days' is distinct from n::text||' Days'
  or a.notice_deadline_days is distinct from n then raise exception 'enterprise_renewal_notice_denied';end if;
 end_:=(w->'client_initial'->>'contract_end_at')::timestamptz;
 cutoff:=((end_ at time zone 'UTC')-make_interval(days=>n)) at time zone 'UTC';
 r:=c.enterprise_renewal_change;prior:=r;
 if r is null then
  if c.auto_renew is distinct from(w->'client_initial'->>'auto_renew')::boolean
   then raise exception 'enterprise_renewal_preference_drift';end if;
 elsif not coalesce(public.enterprise_existing_renewal_operation_valid(r,w,n),false)
  or (r->>'accepted_at')::timestamptz>clock or c.auto_renew is distinct from(r->>'requested_auto_renew')::boolean
  then raise exception 'enterprise_renewal_operation_drift';end if;
 if p_action='request' then
  -- Replay retains the timely acceptance even after its notice cutoff/end.
  if r is not null and r->'requested_auto_renew'=to_jsonb(p_auto_renew) then
   return jsonb_build_object('status',r->>'status','operation',r,'legal_term_end',end_,'notice_cutoff_at',cutoff,
    'provider_effect_authorized',false,'paid_access_authorized',false,'payroll_authorized',false);
  end if;
  if clock>=end_ or (not p_auto_renew and clock>=cutoff) then
   return jsonb_build_object('status','held','operation',r,'reason','request_deadline_passed','legal_term_end',end_,
    'notice_cutoff_at',cutoff,'provider_effect_authorized',false,'paid_access_authorized',false,'payroll_authorized',false);
  end if;
  operation:=gen_random_uuid();at_text:=to_char(clock at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"');
  r:=jsonb_build_object('version','enterprise_existing_renewal_change_v1','operation_id',operation,'source',w,'source_digest',md5(w::text),
   'requested_auto_renew',p_auto_renew,'accepted_at',at_text,'effective_at',end_,'notice_cutoff_at',cutoff,'term_index',0,
   'status','waiting','generation',0,'lease_until',null,'sent_at',null,'observation',null,'completed_at',null);
  if not coalesce(public.enterprise_existing_renewal_operation_valid(r,w,n),false) then raise exception 'enterprise_renewal_request_denied';end if;
  perform set_config('private_sales.enterprise_renewal_writer',c.id::text,true);
  update public.clients set enterprise_renewal_change=r,auto_renew=p_auto_renew where id=c.id;
  perform set_config('private_sales.enterprise_renewal_writer','',true);
  insert into public.billing_events(stripe_event_id,type,processed_ok,client_id,payload)
   values('enterprise-renewal:'||operation::text||':accepted','enterprise.renewal.accepted',true,c.id,
    jsonb_build_object('operation_id',operation,'requested_auto_renew',p_auto_renew,'accepted_at',at_text,
     'effective_at',end_,'notice_cutoff_at',cutoff,'term_index',0)) on conflict(stripe_event_id) do nothing;
  if prior is not null then
   insert into public.billing_events(stripe_event_id,type,processed_ok,client_id,payload)
    values('enterprise-renewal:'||(prior->>'operation_id')||':superseded','enterprise.renewal.superseded',true,c.id,
     jsonb_build_object('operation_id',prior->'operation_id','replaced_by_operation_id',operation,'recorded_at',at_text))
    on conflict(stripe_event_id) do nothing;
  end if;
  -- Waiting on audit uniqueness/other locks cannot carry a NEW acceptance
  -- beyond its deadline. Consent and audit roll back atomically on this race.
  if clock_timestamp()>=end_ or (not p_auto_renew and clock_timestamp()>=cutoff)
   then raise exception 'enterprise_renewal_request_deadline_passed';end if;
 end if;
 return jsonb_build_object('status',coalesce(r->>'status','none'),'operation',r,'legal_term_end',end_,'notice_cutoff_at',cutoff,
  'provider_effect_authorized',false,'paid_access_authorized',false,'payroll_authorized',false);
end $$;
revoke all on function public.enterprise_existing_renewal_guard(),public.enterprise_existing_renewal_operation_valid(jsonb,jsonb,integer),
 public.change_enterprise_existing_renewal(uuid,uuid,jsonb,text,boolean) from public,anon,authenticated;
grant execute on function public.enterprise_existing_renewal_guard(),public.enterprise_existing_renewal_operation_valid(jsonb,jsonb,integer),
 public.change_enterprise_existing_renewal(uuid,uuid,jsonb,text,boolean) to service_role;
commit;
