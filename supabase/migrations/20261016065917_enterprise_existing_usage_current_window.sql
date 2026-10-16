-- LOCAL/UNMOUNTED: current service proof for the existing provider READ only.
-- Original reserved debt, request keys, invoices and mutation phases stay pinned.
begin;
set local lock_timeout='10s';
do $patch$
declare r record;p record;body_ text;def text;old_body text;needle text;
begin
 for r in select * from(values
  ('change_enterprise_existing_usage_provider(uuid,uuid,text,integer,text,uuid,jsonb,jsonb,jsonb)','33b77dc980a6d05f58bd58fe34432265',true),
  ('read_enterprise_existing_legal_window(uuid,uuid)','5092db76ad6873866402860dc7bec7a3',false)
 )v(signature,hash,timed) loop
  select * into p from pg_proc where oid=to_regprocedure('public.'||r.signature);
  if not found or md5(p.prosrc) is distinct from r.hash or p.prosecdef or p.proretset or p.proisstrict
   or p.prolang is distinct from(select oid from pg_language where lanname='plpgsql')
   or p.provolatile<>'v' or p.prorettype<>'jsonb'::regtype
   or p.proowner is distinct from(select oid from pg_roles where rolname='postgres')
   or p.proconfig is distinct from(case when r.timed then array['search_path=pg_catalog','lock_timeout=10s','statement_timeout=2s']
    else array['search_path=pg_catalog','lock_timeout=10s'] end)
   or has_function_privilege('anon',p.oid,'EXECUTE') or has_function_privilege('authenticated',p.oid,'EXECUTE')
   or not has_function_privilege('service_role',p.oid,'EXECUTE')
   or exists(select 1 from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner)))x
    where x.privilege_type='EXECUTE' and x.grantee not in(p.proowner,(select oid from pg_roles where rolname='service_role')))
   then raise exception 'enterprise_usage_current_window_prerequisite_drift';end if;
 end loop;
 select prosrc,pg_get_functiondef(oid) into body_,def from pg_proc
  where oid='public.change_enterprise_existing_usage_provider(uuid,uuid,text,integer,text,uuid,jsonb,jsonb,jsonb)'::regprocedure;
 old_body:=body_;needle:='receipt_ jsonb;';
 if position(needle in body_)=0 then raise exception 'enterprise_usage_current_window_patch_drift';end if;
 body_:=replace(body_,needle,'receipt_ jsonb;window_ jsonb;');
 needle:=$x$ if p_action='read' then return jsonb_build_object('status','read','batch',to_jsonb(b),
  'census',census_,'receipt',receipt_,'observed_at',clock_,'provider_effect_authorized',false,
  'paid_access_authorized',false,'payroll_authorized',false);end if;$x$;
 if position(needle in body_)=0 then raise exception 'enterprise_usage_current_window_patch_drift';end if;
 body_:=replace(body_,needle,$x$ if p_action='read' then
  window_:=public.read_enterprise_existing_legal_window(b.agreement_id,b.owner_id);
  clock_:=clock_timestamp();
  return jsonb_build_object('status','read','batch',to_jsonb(b),'legal_window',window_,
   'census',census_,'receipt',receipt_,'observed_at',clock_,'provider_effect_authorized',false,
   'paid_access_authorized',false,'payroll_authorized',false);end if;$x$);
 execute replace(def,old_body,body_);
end $patch$;
commit;
