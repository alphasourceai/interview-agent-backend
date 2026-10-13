-- LOCAL, UNMOUNTED verified readback. No DML or provider/Auth effects.
begin;
set local lock_timeout='10s';
do $baseline$
declare spec text[]; p record;
begin
 foreach spec slice 1 in array array[
  array['enterprise_existing_billing_initial(jsonb,jsonb,jsonb,jsonb)','3c774bb27bf723a77d1e34301dc36d7d'],
  array['enterprise_existing_billing_receipt_valid(jsonb,jsonb,jsonb)','83d1be66006c96d57912cc7647a25701'],
  array['enterprise_existing_billing_context(public.membership_agreements)','b324f967aec3fc19e526f78a0c506e7c'],
  array['enterprise_existing_billing_guard()','e7fe4203a4f78c0ba1157649cb316887'],
  array['enterprise_existing_billing_commit_guard()','73da67faffb1bfa95ae6da2bb73ca18c'],
  array['apply_enterprise_existing_billing(uuid,uuid,jsonb,jsonb,jsonb,jsonb)','7f8dfb08d8d39b9a2a71f5350e9c7cad'],
  array['enterprise_existing_funding_context(public.membership_agreements)','84c7a3ff1fe1a4c08e2fb17983ed0c76']
 ] loop
  select * into p from pg_proc where oid=to_regprocedure('public.'||spec[1]);
  if not found or p.prosecdef or md5(p.prosrc)<>spec[2]
   or p.proconfig is distinct from(case when spec[1] like 'apply_%' then array['search_path=pg_catalog','lock_timeout=10s'] else array['search_path=pg_catalog'] end)
   or has_function_privilege('anon',p.oid,'EXECUTE') or has_function_privilege('authenticated',p.oid,'EXECUTE')
   or not has_function_privilege('service_role',p.oid,'EXECUTE') then raise exception 'enterprise_billing_readback_prerequisite_drift';end if;
 end loop;
 if not exists(select 1 from pg_attribute where attrelid='public.membership_agreements'::regclass and attname='enterprise_billing_receipt'
   and atttypid='jsonb'::regtype and not attnotnull and not attisdropped)
  or not exists(select 1 from pg_trigger where tgrelid='public.membership_agreements'::regclass and tgname='enterprise_existing_billing_guard'
   and tgenabled='O' and tgtype=31 and tgfoid=to_regprocedure('public.enterprise_existing_billing_guard()'))
  or not exists(select 1 from pg_trigger where tgrelid='public.membership_agreements'::regclass and tgname='enterprise_existing_billing_commit_guard'
   and tgenabled='O' and tgtype=17 and tgdeferrable and tginitdeferred and tgfoid=to_regprocedure('public.enterprise_existing_billing_commit_guard()'))
  or not exists(select 1 from pg_constraint where conrelid='public.membership_agreements'::regclass
   and conname='enterprise_existing_billing_receipt_check' and contype='c' and convalidated)
  or not exists(select 1 from pg_index i join pg_attribute a on a.attrelid=i.indrelid and a.attname='stripe_subscription_id'
   where i.indexrelid=to_regclass('public.clients_stripe_subscription_id_uniq') and i.indrelid='public.clients'::regclass
    and i.indisunique and i.indisvalid and i.indisready and i.indnkeyatts=1 and i.indkey[0]=a.attnum
    and pg_get_expr(i.indpred,i.indrelid)='(stripe_subscription_id IS NOT NULL)')
  or to_regprocedure('public.read_enterprise_existing_billing(uuid)') is not null
  then raise exception 'enterprise_billing_readback_schema_drift';end if;
end $baseline$;

create function public.read_enterprise_existing_billing(p_agreement uuid)
returns jsonb language plpgsql security invoker set search_path=pg_catalog set lock_timeout='10s' as $$
declare a public.membership_agreements; c public.clients; w jsonb;
begin
 if current_user<>'service_role' then raise exception 'enterprise_billing_readback_server_only';end if;
 select * into a from public.membership_agreements where id=p_agreement;
 if not found then raise exception 'enterprise_billing_readback_missing';end if;
 if a.enterprise_billing_receipt is null then return null;end if;
 perform public.enterprise_existing_billing_context(a);
 w:=a.enterprise_billing_receipt;
 select * into c from public.clients where id=a.client_id;
 if not coalesce(public.enterprise_existing_billing_receipt_valid(w,a.enterprise_checkout_source,a.enterprise_checkout_prices),false)
  or w->'funding_receipt' is distinct from a.enterprise_funding_receipt
  or c.stripe_customer_id is distinct from w->'funding_receipt'->'proof'->>'customer_id'
  or c.stripe_subscription_id is distinct from w->'funding_receipt'->'proof'->>'subscription_id'
  or exists(select 1 from public.clients where id<>c.id and stripe_subscription_id=c.stripe_subscription_id)
  then raise exception 'enterprise_billing_readback_conflict';end if;
 return w;
end $$;
revoke all on function public.read_enterprise_existing_billing(uuid) from public,anon,authenticated;
grant execute on function public.read_enterprise_existing_billing(uuid) to service_role;
commit;
