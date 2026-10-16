-- Compatibility read of the existing producer's immutable notice snapshot.
-- No signed snapshot, financial receipt, client preference or date backfill.
begin;
set local lock_timeout='10s';
do $baseline$
declare p record;r record;
begin
 if to_regprocedure('public.enterprise_existing_notice_days(public.membership_agreements)') is not null
  then raise exception 'enterprise_notice_schema_drift';end if;
 for r in select * from(values
  ('read_enterprise_existing_legal_window(uuid,uuid)','5092db76ad6873866402860dc7bec7a3'),
  ('change_enterprise_existing_renewal(uuid,uuid,jsonb,text,boolean)','ff5c0dda695ac1c99ee3c7cb5d09e4b2')
 )v(sig,hash) loop
  select * into p from pg_proc where oid=to_regprocedure('public.'||r.sig);
  if not found or md5(p.prosrc) is distinct from r.hash or p.prosecdef or p.proretset or p.proisstrict
   or p.proowner is distinct from(select oid from pg_roles where rolname='postgres')
   or p.prolang is distinct from(select oid from pg_language where lanname='plpgsql')
   or p.provolatile<>'v' or p.prorettype<>'jsonb'::regtype
   or p.proconfig is distinct from array['search_path=pg_catalog','lock_timeout=10s']
   or has_function_privilege('anon',p.oid,'EXECUTE') or has_function_privilege('authenticated',p.oid,'EXECUTE')
   or not has_function_privilege('service_role',p.oid,'EXECUTE')
   or exists(select 1 from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) x
    where x.privilege_type='EXECUTE' and x.grantee not in(p.proowner,(select oid from pg_roles where rolname='service_role')))
   then raise exception 'enterprise_notice_prerequisite_drift';end if;
 end loop;
end $baseline$;

create function public.enterprise_existing_notice_days(a public.membership_agreements)
returns integer language plpgsql immutable security invoker set search_path=pg_catalog as $$
declare v jsonb:=a.enterprise_checkout_source->'material'->'template_snapshot'->'values';raw_ text;n integer;numeric_ boolean;
begin
 if jsonb_typeof(v) is distinct from 'object' then raise exception 'enterprise_renewal_notice_denied';end if;
 numeric_:=not(v?'notice_deadline_plain');
 if jsonb_typeof(v->'notice_deadline_days') is distinct from 'string'
  or(not numeric_ and jsonb_typeof(v->'notice_deadline_plain') is distinct from 'string')
  then raise exception 'enterprise_renewal_notice_denied';end if;
 raw_:=case when numeric_ then v->>'notice_deadline_days' else v->>'notice_deadline_plain' end;
 if raw_ is null or raw_ !~ '^[1-9][0-9]{0,3}$' then raise exception 'enterprise_renewal_notice_denied';end if;
 n:=raw_::integer;
 if n>3660 or a.notice_deadline_days is distinct from n
  or v->>'notice_deadline_days' is distinct from(case when numeric_ then n::text else n::text||' Days' end)
  then raise exception 'enterprise_renewal_notice_denied';end if;
 return n;
end $$;
revoke all on function public.enterprise_existing_notice_days(public.membership_agreements) from public,anon,authenticated;
grant execute on function public.enterprise_existing_notice_days(public.membership_agreements) to service_role;

do $patch$
declare sig text;body_ text;def_ text;p record;before_ jsonb;after_ jsonb;
 needle text:=$n$ if jsonb_typeof(v->'notice_deadline_plain') is distinct from 'string' or v->>'notice_deadline_plain' !~ '^[1-9][0-9]{0,3}$'
  then raise exception 'enterprise_renewal_notice_denied';end if;
 n:=(v->>'notice_deadline_plain')::integer;
 if n>3660 or v->>'notice_deadline_days' is distinct from n::text||' Days'
  or a.notice_deadline_days is distinct from n then raise exception 'enterprise_renewal_notice_denied';end if;$n$;
 compact text:=$n$ if jsonb_typeof(v->'notice_deadline_plain') is distinct from 'string' or v->>'notice_deadline_plain' !~ '^[1-9][0-9]{0,3}$'
  then raise exception 'enterprise_renewal_notice_denied';end if;
 n:=(v->>'notice_deadline_plain')::integer;
 if n>3660 or v->>'notice_deadline_days' is distinct from n::text||' Days' or a.notice_deadline_days is distinct from n
  then raise exception 'enterprise_renewal_notice_denied';end if;$n$;
 old_ text;
begin
 foreach sig in array array['read_enterprise_existing_legal_window(uuid,uuid)',
  'change_enterprise_existing_renewal(uuid,uuid,jsonb,text,boolean)'] loop
  select *,pg_get_functiondef(oid) into p from pg_proc where oid=to_regprocedure('public.'||sig);
  before_:=to_jsonb(p)-'prosrc'-'pg_get_functiondef';body_:=p.prosrc;def_:=p.pg_get_functiondef;
  old_:=case when sig like 'read_%' then compact else needle end;
  if(length(body_)-length(replace(body_,old_,'')))/length(old_)<>1
   then raise exception 'enterprise_notice_patch_drift';end if;
  execute replace(def_,body_,replace(body_,old_,' n:=public.enterprise_existing_notice_days(a);'));
  select to_jsonb(x)-'prosrc' into after_ from pg_proc x where oid=p.oid;
  if after_ is distinct from before_ then raise exception 'enterprise_notice_metadata_drift';end if;
 end loop;
end $patch$;
commit;
