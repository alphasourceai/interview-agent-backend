-- Preserve the existing trigger's exact grants while canonicalizing ACL order.
-- PostgreSQL ACL arrays may order identical grants differently after restore.
-- No function body, effective access, data or application workflow is changed.
begin;
set local lock_timeout='10s';
do $acl_order$
declare
 p record;
 before_definition text;
 before_grants text[];
 expected_grants text[];
 canonical text := '{postgres=X/postgres,=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}';
begin
 if current_user <> 'postgres' then
  raise exception 'member_trigger_acl_order_owner_required';
 end if;
 select f.*,l.lanname into p from pg_proc f join pg_language l on l.oid=f.prolang
 where f.oid=to_regprocedure('public.client_members_sync_user_uuid()');
 if not found or md5(p.prosrc) is distinct from '83ae4c2f6bfa99df42c8371cda6a1c0c'
  or p.proowner is distinct from 'postgres'::regrole::oid or p.prosecdef or p.proisstrict
  or p.provolatile<>'v' or p.proconfig is not null or p.lanname<>'plpgsql'
 then raise exception 'member_trigger_acl_order_function_drift';end if;
 select array_agg(x::text order by x::text) into before_grants from unnest(p.proacl) x;
 select array_agg(x::text order by x::text) into expected_grants from unnest(canonical::aclitem[]) x;
 if before_grants is distinct from expected_grants then
  raise exception 'member_trigger_acl_order_privilege_drift';
 end if;
 if p.proacl::text=canonical then return;end if;
 before_definition:=pg_get_functiondef(p.oid);

 -- Transactional regrant of the SAME owner/grantees/privileges/grantor/options.
 revoke all on function public.client_members_sync_user_uuid()
  from public,anon,authenticated,service_role,postgres;
 grant execute on function public.client_members_sync_user_uuid() to postgres;
 grant execute on function public.client_members_sync_user_uuid() to public;
 grant execute on function public.client_members_sync_user_uuid() to anon;
 grant execute on function public.client_members_sync_user_uuid() to authenticated;
 grant execute on function public.client_members_sync_user_uuid() to service_role;

 select f.* into p from pg_proc f
 where f.oid='public.client_members_sync_user_uuid()'::regprocedure;
 if p.proacl::text is distinct from canonical or pg_get_functiondef(p.oid) is distinct from before_definition
  or (select array_agg(x::text order by x::text) from unnest(p.proacl) x) is distinct from before_grants
 then raise exception 'member_trigger_acl_order_readback_failed';end if;
end $acl_order$;
commit;
