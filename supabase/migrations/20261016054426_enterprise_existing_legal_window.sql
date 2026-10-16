-- LOCAL/UNMOUNTED legal calendar on the existing paid-source/coverage kernel.
-- No collection, provider effect, new table, receipt rewrite or access write.
begin;
set local lock_timeout='10s';
do $baseline$
declare r record;p record;
begin
 if exists(select 1 from pg_proc where pronamespace='public'::regnamespace and proname in
  ('enterprise_existing_legal_span','read_enterprise_existing_legal_window','refresh_enterprise_existing_legal_window'))
  then raise exception 'enterprise_legal_schema_drift';end if;
 for r in select * from(values
  ('read_enterprise_existing_billing(uuid)','6f0719620d7073a463b8fc6a6a8b4808',true,'plpgsql','v','jsonb',false,false),
  ('read_enterprise_existing_paid_coverage(uuid,uuid)','e1a325ef638902d552636d73f6ae3460',true,'plpgsql','v','jsonb',false,false),
  ('enterprise_existing_renewal_operation_valid(jsonb,jsonb,integer)','7be847920a26473d7bfd62c05fe448f9',false,'plpgsql','i','boolean',false,false),
  ('enterprise_existing_renewal_guard()','7cdb5c27fc31505935c0d0cd3fa1f097',false,'plpgsql','v','trigger',false,false),
  ('change_enterprise_existing_renewal(uuid,uuid,jsonb,text,boolean)','10c583ec7dec48810943741c58f7eb2f',true,'plpgsql','v','jsonb',false,false),
  ('retail_existing_month_anchor(timestamptz,integer)','215a4af8ed5457b66f11e6234f7f5741',false,'plpgsql','i','timestamptz',true,true)
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
   then raise exception 'enterprise_legal_prerequisite_drift';end if;
 end loop;
 if not exists(select 1 from pg_attribute where attrelid='public.clients'::regclass
   and attname='enterprise_renewal_change' and atttypid='jsonb'::regtype and not attisdropped)
  or not exists(select 1 from pg_class where oid='public.clients'::regclass and relrowsecurity)
  or not exists(select 1 from pg_trigger where tgrelid='public.clients'::regclass and tgname='enterprise_existing_renewal_guard'
   and tgenabled='O' and tgtype=23 and tgfoid='public.enterprise_existing_renewal_guard()'::regprocedure)
  then raise exception 'enterprise_legal_table_drift';end if;
end $baseline$;

-- Calendar helper only, not a legal renewal, funding or access attestation.
-- Every later anniversary is based on ORIGINAL E, never the last clamped end.
create function public.enterprise_existing_legal_span(w jsonb,i integer)
returns jsonb language plpgsql immutable security invoker set search_path=pg_catalog as $$
declare s timestamptz:=(w->'client_initial'->>'contract_start_at')::timestamptz;
 e timestamptz:=(w->'client_initial'->>'contract_end_at')::timestamptz;start_ timestamptz;end_ timestamptz;
begin
 if i is null or i not between 0 and 999 or s is null or e is null or not isfinite(s) or not isfinite(e) or e<=s
  then raise exception 'enterprise_legal_calendar_denied';end if;
 start_:=case when i=0 then s else public.retail_existing_month_anchor(e,12*(i-1)) end;
 end_:=public.retail_existing_month_anchor(e,12*i);
 return jsonb_build_object('start_at',to_char(start_ at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
  'end_at',to_char(end_ at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'));
end $$;

-- Preserve the old function's identity/security/ACL, extend only its anchored
-- term-index validation. No dispatch states become legal in this migration.
do $validator$
declare body text;def text;old text;new text;
begin
 select prosrc,pg_get_functiondef(oid) into body,def from pg_proc
  where oid='public.enterprise_existing_renewal_operation_valid(jsonb,jsonb,integer)'::regprocedure;
 old:='declare at_ timestamptz;end_ timestamptz;cutoff timestamptz;';
 new:='declare at_ timestamptz;end_ timestamptz;cutoff timestamptz;span_ jsonb;i integer;';
 if position(old in body)=0 then raise exception 'enterprise_legal_patch_drift';end if;body:=replace(body,old,new);
 old:=$x$or r->'term_index' is distinct from '0'::jsonb or r->>'status' is distinct from 'waiting'$x$;
 new:=$x$or jsonb_typeof(r->'term_index') is distinct from 'number' or r->>'term_index' !~ '^[0-9]+$'
  or (r->>'term_index')::numeric not between 0 and 999 or r->>'status' is distinct from 'waiting'$x$;
 if position(old in body)=0 then raise exception 'enterprise_legal_patch_drift';end if;body:=replace(body,old,new);
 old:=$x$at_:=(r->>'accepted_at')::timestamptz;end_:=(w->'client_initial'->>'contract_end_at')::timestamptz;$x$;
 new:=$x$at_:=(r->>'accepted_at')::timestamptz;i:=(r->>'term_index')::integer;
 span_:=public.enterprise_existing_legal_span(w,i);end_:=(span_->>'end_at')::timestamptz;$x$;
 if position(old in body)=0 then raise exception 'enterprise_legal_patch_drift';end if;body:=replace(body,old,new);
 old:=$x$and at_<end_ and (r->'requested_auto_renew'='true'::jsonb or at_<cutoff)$x$;
 new:=$x$and (i=0 or at_>=(span_->>'start_at')::timestamptz)
  and at_<end_ and (r->'requested_auto_renew'='true'::jsonb or at_<cutoff)$x$;
 if position(old in body)=0 then raise exception 'enterprise_legal_patch_drift';end if;body:=replace(body,old,new);
 execute replace(def,(select prosrc from pg_proc where oid='public.enterprise_existing_renewal_operation_valid(jsonb,jsonb,integer)'::regprocedure),body);
end $validator$;

create function public.read_enterprise_existing_legal_window(p_agreement uuid,p_client uuid)
returns jsonb language plpgsql volatile security invoker set search_path=pg_catalog set lock_timeout='10s' as $$
declare c public.clients;a public.membership_agreements;w jsonb;r jsonb;v jsonb;coverage jsonb;span_ jsonb;projection_ jsonb;
 clock timestamptz;from_ timestamptz;through_ timestamptz;observed_ timestamptz;end_ timestamptz;cutoff timestamptz;n integer;i integer:=0;j integer;renew boolean;matched boolean:=false;
begin
 if current_user<>'service_role' then raise exception 'enterprise_legal_server_only';end if;
 -- Reuses all original paid source/pool/owner/invoice locks in root-first order.
 coverage:=public.read_enterprise_existing_paid_coverage(p_agreement,p_client);
 select * into strict c from public.clients where id=p_client;
 select * into strict a from public.membership_agreements where id=p_agreement;
 w:=public.read_enterprise_existing_billing(a.id);v:=a.template_snapshot->'values';r:=c.enterprise_renewal_change;clock:=clock_timestamp();
 if coverage->>'version' is distinct from 'enterprise_existing_paid_coverage_v1'
  or coverage->>'agreement_id' is distinct from a.id::text or coverage->>'client_id' is distinct from c.id::text
  or coverage->>'billing_source_digest' is distinct from md5(w::text)
  or coverage->'provider_effect_authorized' is distinct from 'false'::jsonb or coverage->'paid_access_authorized' is distinct from 'false'::jsonb
  or coverage->'payroll_authorized' is distinct from 'false'::jsonb
  or c.plan_tier is distinct from 'enterprise' or c.billing_interval is distinct from w->'client_initial'->>'billing_interval'
  then raise exception 'enterprise_legal_source_denied';end if;
 if jsonb_typeof(v->'notice_deadline_plain') is distinct from 'string' or v->>'notice_deadline_plain' !~ '^[1-9][0-9]{0,3}$'
  then raise exception 'enterprise_renewal_notice_denied';end if;
 n:=(v->>'notice_deadline_plain')::integer;
 if n>3660 or v->>'notice_deadline_days' is distinct from n::text||' Days' or a.notice_deadline_days is distinct from n
  then raise exception 'enterprise_renewal_notice_denied';end if;
 from_:=(coverage->>'funded_from')::timestamptz;through_:=(coverage->>'funded_through')::timestamptz;observed_:=(coverage->>'observed_at')::timestamptz;
 if from_ is null or through_ is null or not isfinite(from_) or not isfinite(through_) or through_<=from_ or from_>clock
  or from_ is distinct from(w->'funding_receipt'->'proof'->>'payment_success_at')::timestamptz
  or observed_ is null or not isfinite(observed_) or observed_>clock or observed_<from_
  then raise exception 'enterprise_legal_coverage_denied';end if;
 if r is null then renew:=(w->'client_initial'->>'auto_renew')::boolean;
 else
  if not coalesce(public.enterprise_existing_renewal_operation_valid(r,w,n),false) or(r->>'accepted_at')::timestamptz>clock
   then raise exception 'enterprise_renewal_operation_drift';end if;
  renew:=(r->>'requested_auto_renew')::boolean;i:=(r->>'term_index')::integer;
 end if;
 if c.auto_renew is distinct from renew then raise exception 'enterprise_renewal_preference_drift';end if;
 span_:=public.enterprise_existing_legal_span(w,i);
 -- A later accepted journal cannot invent the prior funded legal anniversary.
 if i>0 and (clock<(span_->>'start_at')::timestamptz or from_>(span_->>'start_at')::timestamptz
  or through_<=(span_->>'start_at')::timestamptz) then raise exception 'enterprise_legal_prior_window_denied';end if;
 end_:=(span_->>'end_at')::timestamptz;
 while renew and clock>=end_ and from_<=end_ and through_>end_ loop
  if i>=999 then raise exception 'enterprise_legal_calendar_denied';end if;
  i:=i+1;span_:=public.enterprise_existing_legal_span(w,i);end_:=(span_->>'end_at')::timestamptz;
 end loop;
 -- Client dates are only a non-forward projection. They may lag a newly proved
 -- boundary, never create it, leap over it or be silently collapsed backwards.
 for j in 0..i loop
  projection_:=public.enterprise_existing_legal_span(w,j);
  if c.contract_start_at=(projection_->>'start_at')::timestamptz and c.contract_end_at=(projection_->>'end_at')::timestamptz
   then matched:=true;exit;end if;
 end loop;
 if not matched then raise exception 'enterprise_legal_projection_drift';end if;
 cutoff:=((end_ at time zone 'UTC')-make_interval(days=>n)) at time zone 'UTC';
 return jsonb_build_object('version','enterprise_existing_legal_window_v1','agreement_id',a.id,'client_id',c.id,
  'billing_source_digest',md5(w::text),'term_index',i,'initial_term_start',w->'client_initial'->'contract_start_at',
  'original_term_end',w->'client_initial'->'contract_end_at','term_start_at',span_->'start_at','term_end_at',span_->'end_at',
  'notice_cutoff_at',to_char(cutoff at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),'auto_renew',renew,
  'accepted_operation_id',r->'operation_id','funded_from',coverage->'funded_from','funded_through',coverage->'funded_through',
  'observed_at',to_char(clock at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
  'provider_effect_authorized',false,'paid_access_authorized',false,'payroll_authorized',false);
end $$;

do $guard$
declare old text;body text;def text;
begin
 select prosrc,pg_get_functiondef(oid) into body,def from pg_proc where oid='public.enterprise_existing_renewal_guard()'::regprocedure;
 old:=$x$ if current_user='service_role' and new.enterprise_renewal_change is not distinct from old.enterprise_renewal_change$x$;
 if position(old in body)=0 then raise exception 'enterprise_legal_patch_drift';end if;
 body:=replace(body,old,$x$ if current_user='service_role' and current_setting('private_sales.enterprise_legal_writer',true)=new.id::text
  and new.enterprise_renewal_change is not distinct from old.enterprise_renewal_change and new.auto_renew is not distinct from old.auto_renew
  and new.cancel_at_term_end is not distinct from old.cancel_at_term_end and new.cancel_effective_at is not distinct from old.cancel_effective_at
  then return new;end if;
$x$||old);
 execute replace(def,(select prosrc from pg_proc where oid='public.enterprise_existing_renewal_guard()'::regprocedure),body);
end $guard$;

create function public.refresh_enterprise_existing_legal_window(p_agreement uuid,p_client uuid)
returns jsonb language plpgsql volatile security invoker set search_path=pg_catalog set lock_timeout='10s' as $$
declare window_ jsonb;c public.clients;
begin
 if current_user<>'service_role' then raise exception 'enterprise_legal_server_only';end if;
 window_:=public.read_enterprise_existing_legal_window(p_agreement,p_client);
 select * into strict c from public.clients where id=p_client;
 if c.contract_start_at=(window_->>'term_start_at')::timestamptz and c.contract_end_at=(window_->>'term_end_at')::timestamptz
  then return window_||jsonb_build_object('status','unchanged');end if;
 perform set_config('private_sales.enterprise_legal_writer',c.id::text,true);
 update public.clients set contract_start_at=(window_->>'term_start_at')::timestamptz,contract_end_at=(window_->>'term_end_at')::timestamptz where id=c.id;
 perform set_config('private_sales.enterprise_legal_writer','',true);
 return window_||jsonb_build_object('status','refreshed');
end $$;

-- Adapt the SAME read/request control to the proved current legal window.
-- Still no dispatch phases; no direct date write on accepting a preference.
do $request$
declare body text;def text;old text;new text;
begin
 select prosrc,pg_get_functiondef(oid) into body,def from pg_proc where oid='public.change_enterprise_existing_renewal(uuid,uuid,jsonb,text,boolean)'::regprocedure;
 old:=' w jsonb;v jsonb;r jsonb;prior jsonb;';new:=' window_ jsonb;w jsonb;v jsonb;r jsonb;prior jsonb;';
 if position(old in body)=0 then raise exception 'enterprise_legal_patch_drift';end if;body:=replace(body,old,new);
 old:=$x$  or c.contract_start_at is distinct from(w->'client_initial'->>'contract_start_at')::timestamptz
  or c.contract_end_at is distinct from(w->'client_initial'->>'contract_end_at')::timestamptz
$x$;
 if position(old in body)=0 then raise exception 'enterprise_legal_patch_drift';end if;body:=replace(body,old,'');
 old:=$x$ end_:=(w->'client_initial'->>'contract_end_at')::timestamptz;$x$;
 new:=$x$ window_:=public.read_enterprise_existing_legal_window(a.id,c.id);
 clock:=clock_timestamp();end_:=(window_->>'term_end_at')::timestamptz;$x$;
 if position(old in body)=0 then raise exception 'enterprise_legal_patch_drift';end if;body:=replace(body,old,new);
 old:=$x$'notice_cutoff_at',cutoff,'term_index',0,$x$;new:=$x$'notice_cutoff_at',cutoff,'term_index',window_->'term_index',$x$;
 if position(old in body)=0 then raise exception 'enterprise_legal_patch_drift';end if;body:=replace(body,old,new);
 old:=$x$'effective_at',end_,'notice_cutoff_at',cutoff,'term_index',0))$x$;
 new:=$x$'effective_at',end_,'notice_cutoff_at',cutoff,'term_index',window_->'term_index'))$x$;
 if position(old in body)=0 then raise exception 'enterprise_legal_patch_drift';end if;body:=replace(body,old,new);
 execute replace(def,(select prosrc from pg_proc where oid='public.change_enterprise_existing_renewal(uuid,uuid,jsonb,text,boolean)'::regprocedure),body);
end $request$;
revoke all on function public.enterprise_existing_legal_span(jsonb,integer),public.read_enterprise_existing_legal_window(uuid,uuid),
 public.refresh_enterprise_existing_legal_window(uuid,uuid) from public,anon,authenticated;
grant execute on function public.enterprise_existing_legal_span(jsonb,integer),public.read_enterprise_existing_legal_window(uuid,uuid),
 public.refresh_enterprise_existing_legal_window(uuid,uuid) to service_role;
commit;
