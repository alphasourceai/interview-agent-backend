-- LOCAL ONLY successor. Assert existing uniqueness/lock rights, never repair
-- schema or broaden grants. No row DML, paid/access state or provider effects.
begin;
set local lock_timeout='10s';
do $baseline$
declare s text[];p record;
begin
 if to_regprocedure('public.retail_existing_funding_schema_guard()') is not null then
  raise exception 'retail_funding_prerequisite_drift';end if;
 foreach s slice 1 in array array[
  array['retail_existing_funding_context(public.membership_agreements,text)','bc5a40d264f93140015ffe65b3328c86'],
  array['record_retail_existing_funding(uuid,uuid,text,jsonb,jsonb)','c67c2bdc5c8f75e87e14d8e080f7ce25']] loop
  select * into p from pg_proc where oid=to_regprocedure('public.'||s[1]);
  if not found or md5(p.prosrc) is distinct from s[2] or p.prosecdef or p.provolatile<>'v'
   or p.proowner is distinct from (select oid from pg_roles where rolname='postgres')
   or p.proconfig is distinct from (case when s[1] like 'record_%' then array['search_path=pg_catalog','lock_timeout=10s'] else array['search_path=pg_catalog'] end)
   or has_function_privilege('anon',p.oid,'EXECUTE') or has_function_privilege('authenticated',p.oid,'EXECUTE')
   or not has_function_privilege('service_role',p.oid,'EXECUTE')
   or exists(select 1 from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner)))
    where grantee not in(p.proowner,(select oid from pg_roles where rolname='service_role')))
   then raise exception 'retail_funding_prerequisite_drift';end if;
 end loop;
end $baseline$;

create function public.retail_existing_funding_schema_guard()
returns void language plpgsql stable security invoker set search_path=pg_catalog as $$
declare t oid;
begin
 if not exists(select 1 from pg_roles where rolname='service_role' and not rolsuper and rolbypassrls)
  then raise exception 'retail_funding_schema_drift';end if;
 if not exists(select 1 from pg_index where indexrelid=to_regclass('public.billing_customers_stripe_customer_id_uniq')
  and indrelid='public.billing_customers'::regclass and indisunique and indisvalid and indisready and indislive and indimmediate
  and pg_get_indexdef(indexrelid)='CREATE UNIQUE INDEX billing_customers_stripe_customer_id_uniq ON public.billing_customers USING btree (stripe_customer_id) WHERE (stripe_customer_id IS NOT NULL)')
  then raise exception 'retail_funding_schema_drift';end if;
 foreach t in array array['public.membership_agreements'::regclass::oid,'public.public_purchase_intents'::regclass::oid,
  'public.clients'::regclass::oid,'public.billing_customers'::regclass::oid] loop
  -- PostgreSQL comma-separated privilege strings mean ANY, not ALL.
  if not has_table_privilege('service_role',t,'SELECT') or not has_table_privilege('service_role',t,'UPDATE')
   or not exists(select 1 from pg_class where oid=t and relrowsecurity) then raise exception 'retail_funding_schema_drift';end if;
 end loop;
end $$;
revoke all on function public.retail_existing_funding_schema_guard() from public,anon,authenticated;
grant execute on function public.retail_existing_funding_schema_guard() to service_role;
select public.retail_existing_funding_schema_guard();

-- Replace only verified current bodies. Keep original signatures, lock order,
-- volatility, invoker semantics, SET options, owner and existing function ACL.
do $patch$
declare s text;p record;needle text:=E'\nbegin\n';body text;definition text;
begin
 foreach s in array array['retail_existing_funding_context(public.membership_agreements,text)',
  'record_retail_existing_funding(uuid,uuid,text,jsonb,jsonb)'] loop
  select * into p from pg_proc where oid=to_regprocedure('public.'||s);
  if array_length(string_to_array(p.prosrc,needle),1)<>2 then raise exception 'retail_funding_patch_drift';end if;
  body:=replace(p.prosrc,needle,needle||E' perform public.retail_existing_funding_schema_guard();\n');
  definition:=pg_get_functiondef(p.oid);
  if array_length(string_to_array(definition,p.prosrc),1)<>2 then raise exception 'retail_funding_patch_drift';end if;
  execute replace(definition,p.prosrc,body);
 end loop;
end $patch$;
commit;
