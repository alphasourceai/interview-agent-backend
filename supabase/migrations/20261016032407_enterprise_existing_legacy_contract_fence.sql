-- LOCAL candidate only. Apply with writers quiesced and in-flight PL/pgSQL
-- drained, under the exact release gate. A table lock is NOT such a drain.
-- No backfill, record update, new authority, route, table or policy.
begin;
set local lock_timeout='10s';
do $fence$
declare p record;r record;before_ jsonb;after_ jsonb;body_ text;needle_ text;
 gate_hash_ text;old_gate_hash_ constant text:='c53a01258e34d249a258e5845b5b4cf1';
 old_markers_ text:='OLD.enterprise_checkout_source is not null or OLD.enterprise_checkout_pool_id is not null or OLD.enterprise_checkout_prices is not null or OLD.enterprise_funding_receipt is not null or OLD.enterprise_billing_receipt is not null';
 new_markers_ text:='NEW.enterprise_checkout_source is not null or NEW.enterprise_checkout_pool_id is not null or NEW.enterprise_checkout_prices is not null or NEW.enterprise_funding_receipt is not null or NEW.enterprise_billing_receipt is not null';
begin
 for r in select * from(values
  ('legacy_contract_projection(public.clients)','a82a07ce95244542d6e2e4a7613f111e','i','jsonb',false),
  ('zz_retail_legacy_cohort_gate()','c53a01258e34d249a258e5845b5b4cf1','v','trigger',true),
  ('legacy_contract_gate_pin()','d1ec15c0ee53136bc10c75b55163853c','v','void',false),
  ('legacy_contract_cohort(public.clients)','ca0030419d7351e87b93b12d1dd0470a','v','text',false),
  ('apply_legacy_contract_action(uuid,jsonb,text)','82de771f1d7b250721611177f7a28d08','v','jsonb',true)
 )v(signature,body_hash,volatility,result_type,bounded) loop
  select * into p from pg_proc where oid=to_regprocedure('public.'||r.signature);
  if not found or md5(p.prosrc) is distinct from r.body_hash or p.prosecdef or p.proretset
   or p.prolang is distinct from(select oid from pg_language where lanname=case when r.volatility='i' then 'sql' else 'plpgsql' end)
   or p.provolatile::text is distinct from r.volatility
   or p.prorettype is distinct from r.result_type::regtype
   or p.proowner is distinct from(select oid from pg_roles where rolname='postgres')
   or p.proconfig is distinct from(case when r.bounded then array['search_path=pg_catalog','lock_timeout=10s'] else array['search_path=pg_catalog'] end)
   or has_function_privilege('anon',p.oid,'EXECUTE') or has_function_privilege('authenticated',p.oid,'EXECUTE')
   or not has_function_privilege('service_role',p.oid,'EXECUTE')
   or exists(select 1 from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
    where a.privilege_type='EXECUTE' and a.grantee not in(p.proowner,(select oid from pg_roles where rolname='service_role')))
   then raise exception 'enterprise_legacy_fence_prerequisite_drift';end if;
 end loop;
 for r in select * from(values('enterprise_checkout_source','jsonb'),('enterprise_checkout_pool_id','uuid'),
  ('enterprise_checkout_prices','jsonb'),('enterprise_funding_receipt','jsonb'),('enterprise_billing_receipt','jsonb'))v(name,type) loop
  if not exists(select 1 from pg_attribute where attrelid='public.membership_agreements'::regclass
   and attname=r.name and not attisdropped and atttypid=r.type::regtype)
   then raise exception 'enterprise_legacy_fence_column_drift';end if;
 end loop;
 perform public.legacy_contract_gate_pin();
 select jsonb_agg(to_jsonb(x)-'prosrc' order by x.oid) into before_ from pg_proc x
  where x.oid in('public.legacy_contract_projection(public.clients)'::regprocedure,
   'public.zz_retail_legacy_cohort_gate()'::regprocedure,'public.legacy_contract_gate_pin()'::regprocedure,
   'public.legacy_contract_cohort(public.clients)'::regprocedure,'public.apply_legacy_contract_action(uuid,jsonb,text)'::regprocedure);

 select * into strict p from pg_proc where oid='public.zz_retail_legacy_cohort_gate()'::regprocedure;
 body_:=p.prosrc;
 needle_:='needed:=NEW.is_current is true or NEW.retail_funding_receipt is not null;';
 if position(needle_ in body_)=0 then raise exception 'enterprise_legacy_fence_patch_drift';end if;
 body_:=replace(body_,needle_,replace(needle_,';',' or '||new_markers_||';'));
 needle_:='needed:=OLD.is_current is true or OLD.retail_funding_receipt is not null;';
 if position(needle_ in body_)=0 then raise exception 'enterprise_legacy_fence_patch_drift';end if;
 body_:=replace(body_,needle_,replace(needle_,';',' or '||old_markers_||';'));
 needle_:='needed:=OLD.is_current is true or NEW.is_current is true or OLD.retail_funding_receipt is not null or NEW.retail_funding_receipt is not null;';
 if position(needle_ in body_)=0 then raise exception 'enterprise_legacy_fence_patch_drift';end if;
 body_:=replace(body_,needle_,replace(needle_,';',' or '||old_markers_||' or '||new_markers_||';'));
 execute replace(pg_get_functiondef(p.oid),p.prosrc,body_);
 select md5(prosrc) into gate_hash_ from pg_proc where oid=p.oid;

 select * into strict p from pg_proc where oid='public.legacy_contract_gate_pin()'::regprocedure;
 if (length(p.prosrc)-length(replace(p.prosrc,old_gate_hash_,'')))/length(old_gate_hash_)<>1
  then raise exception 'enterprise_legacy_fence_pin_drift';end if;
 execute replace(pg_get_functiondef(p.oid),p.prosrc,replace(p.prosrc,old_gate_hash_,gate_hash_));

 select * into strict p from pg_proc where oid='public.legacy_contract_cohort(public.clients)'::regprocedure;
 needle_:=' for a in select * from public.membership_agreements where client_id=c.id loop';
 if position(needle_ in p.prosrc)=0 then raise exception 'enterprise_legacy_fence_patch_drift';end if;
 body_:=replace(p.prosrc,needle_,needle_||E'\n  if a.enterprise_checkout_source is not null or a.enterprise_checkout_pool_id is not null\n   or a.enterprise_checkout_prices is not null or a.enterprise_funding_receipt is not null\n   or a.enterprise_billing_receipt is not null then return ''held'';end if;');
 execute replace(pg_get_functiondef(p.oid),p.prosrc,body_);

 perform public.legacy_contract_gate_pin();
 select jsonb_agg(to_jsonb(x)-'prosrc' order by x.oid) into after_ from pg_proc x
  where x.oid in('public.legacy_contract_projection(public.clients)'::regprocedure,
   'public.zz_retail_legacy_cohort_gate()'::regprocedure,'public.legacy_contract_gate_pin()'::regprocedure,
   'public.legacy_contract_cohort(public.clients)'::regprocedure,'public.apply_legacy_contract_action(uuid,jsonb,text)'::regprocedure);
 if before_ is distinct from after_
  or (select md5(prosrc) from pg_proc where oid='public.legacy_contract_projection(public.clients)'::regprocedure)<>'a82a07ce95244542d6e2e4a7613f111e'
  or (select md5(prosrc) from pg_proc where oid='public.apply_legacy_contract_action(uuid,jsonb,text)'::regprocedure)<>'82de771f1d7b250721611177f7a28d08'
  then raise exception 'enterprise_legacy_fence_metadata_drift';end if;
end $fence$;
commit;
