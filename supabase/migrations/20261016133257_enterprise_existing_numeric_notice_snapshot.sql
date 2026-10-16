-- Existing producer stores notice days as a JSON integer as well as text.
-- Read compatibility only; never edit an accepted snapshot or its scalar.
begin;
set local lock_timeout='10s';
do $baseline$
declare p record;
begin
 select * into p from pg_proc where oid=to_regprocedure('public.enterprise_existing_notice_days(public.membership_agreements)');
 if not found or md5(p.prosrc) is distinct from '070fa82b9af7a6900a5bbec66523c404'
  or p.prosecdef or p.proretset or p.proisstrict or p.provolatile<>'i'
  or p.prorettype<>'integer'::regtype or p.proconfig is distinct from array['search_path=pg_catalog']
  or p.proowner is distinct from(select oid from pg_roles where rolname='postgres')
  or p.prolang is distinct from(select oid from pg_language where lanname='plpgsql')
  or has_function_privilege('anon',p.oid,'EXECUTE') or has_function_privilege('authenticated',p.oid,'EXECUTE')
  or not has_function_privilege('service_role',p.oid,'EXECUTE')
  or exists(select 1 from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) x
   where x.privilege_type='EXECUTE' and x.grantee not in(p.proowner,(select oid from pg_roles where rolname='service_role')))
  then raise exception 'enterprise_numeric_notice_prerequisite_drift';end if;
end $baseline$;
do $patch$
declare p record;body_ text;before_ jsonb;after_ jsonb;old_ text;new_ text;
begin
 select * into strict p from pg_proc where oid='public.enterprise_existing_notice_days(public.membership_agreements)'::regprocedure;
 before_:=to_jsonb(p)-'prosrc';body_:=p.prosrc;
 old_:=$n$ if jsonb_typeof(v->'notice_deadline_days') is distinct from 'string'$n$;
 new_:=$n$ if numeric_ and jsonb_typeof(v->'notice_deadline_days')='number' then
  if (v->>'notice_deadline_days')::numeric not between 1 and 3660
   or trunc((v->>'notice_deadline_days')::numeric)<>(v->>'notice_deadline_days')::numeric
   or a.notice_deadline_days is distinct from (v->>'notice_deadline_days')::integer
   then raise exception 'enterprise_renewal_notice_denied';end if;
  return (v->>'notice_deadline_days')::integer;
 end if;
 if jsonb_typeof(v->'notice_deadline_days') is distinct from 'string'$n$;
 if(length(body_)-length(replace(body_,old_,'')))/length(old_)<>1
  then raise exception 'enterprise_numeric_notice_patch_drift';end if;
 execute replace(pg_get_functiondef(p.oid),body_,replace(body_,old_,new_));
 select to_jsonb(x)-'prosrc' into after_ from pg_proc x where oid=p.oid;
 if after_ is distinct from before_ then raise exception 'enterprise_numeric_notice_metadata_drift';end if;
end $patch$;
commit;
