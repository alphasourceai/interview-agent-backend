-- LOCAL new-retail first-paid admission only. Existing already-paid historical
-- no-receipt tails and accepted legacy templates stay untouched; no backfill.
begin;
set local lock_timeout='10s';
do $baseline$
declare s text[];p record;
begin
 foreach s slice 1 in array array[
  array['retail_existing_funding_guard()','de60a4c0152c2ce0364999b981f8c5c9'],
  array['retail_existing_funding_intent_clock_guard()','2fcef863c305249d741583e45e8208b1']] loop
  select * into p from pg_proc where oid=to_regprocedure('public.'||s[1]);
  if not found or md5(p.prosrc) is distinct from s[2] or p.prosecdef or p.provolatile<>'v'
   or p.proconfig is distinct from array['search_path=pg_catalog']
   or p.proowner is distinct from (select oid from pg_roles where rolname='postgres')
   or not has_function_privilege('service_role',p.oid,'EXECUTE')
   or exists(select 1 from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner)))
    where grantee not in(p.proowner,(select oid from pg_roles where rolname='service_role')))
   then raise exception 'retail_funding_admission_prerequisite_drift';end if;
 end loop;
 select * into p from pg_proc where oid=to_regprocedure('public.read_retail_existing_funding(uuid,uuid,text,jsonb)');
 if not found or md5(p.prosrc) is distinct from '9b3e6f1279d2473a33296a7f3180e98a' or p.prosecdef or p.provolatile<>'v'
  or p.proconfig is distinct from array['search_path=pg_catalog','lock_timeout=10s']
  or p.proowner is distinct from (select oid from pg_roles where rolname='postgres')
  or not has_function_privilege('service_role',p.oid,'EXECUTE')
  or exists(select 1 from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner)))
   where grantee not in(p.proowner,(select oid from pg_roles where rolname='service_role')))
  then raise exception 'retail_funding_admission_prerequisite_drift';end if;
 if not exists(select 1 from pg_trigger where tgrelid='public.membership_agreements'::regclass
  and tgname='retail_existing_funding_guard' and tgenabled='O' and not tgisinternal
  and tgfoid='public.retail_existing_funding_guard()'::regprocedure and tgtype=31)
  or not exists(select 1 from pg_trigger where tgrelid='public.public_purchase_intents'::regclass
   and tgname='retail_existing_funding_intent_clock_guard' and tgenabled='O' and not tgisinternal
   and tgfoid='public.retail_existing_funding_intent_clock_guard()'::regprocedure and tgtype=23)
  or to_regprocedure('public.read_retail_existing_funding(uuid,uuid,text,jsonb)') is null
  then raise exception 'retail_funding_admission_schema_drift';end if;
 perform public.retail_existing_funding_schema_guard();
end $baseline$;
do $patch$
declare p record;definition text;needle text;body text;
begin
 select * into p from pg_proc where oid='public.retail_existing_funding_guard()'::regprocedure;
 needle:=E' if TG_OP=\'INSERT\' then';
 if array_length(string_to_array(p.prosrc,needle),1)<>2 then raise exception 'retail_funding_admission_patch_drift';end if;
 body:=replace(p.prosrc,needle,$insert$
 if TG_OP='INSERT' then
  if new.template_version='membership_agreement_retail_terms_v2' and new.checkout_paid_at is not null
   then raise exception 'retail_funding_receipt_required';end if;
 elsif old.checkout_paid_at is null and new.checkout_paid_at is not null
  and (old.template_version='membership_agreement_retail_terms_v2' or new.template_version='membership_agreement_retail_terms_v2')
  and old.retail_funding_receipt is null then raise exception 'retail_funding_receipt_required';end if;
$insert$||needle);
 definition:=pg_get_functiondef(p.oid);execute replace(definition,p.prosrc,body);
 select * into p from pg_proc where oid='public.retail_existing_funding_intent_clock_guard()'::regprocedure;
 needle:=E' if new.activated_at is null then return new;end if;';
 if array_length(string_to_array(p.prosrc,needle),1)<>2 then raise exception 'retail_funding_admission_patch_drift';end if;
 body:=replace(p.prosrc,needle,needle||$insert$
 if (TG_OP='INSERT' or old.activated_at is null)
  and exists(select 1 from public.membership_agreements a where a.id=new.agreement_id
   and a.template_version='membership_agreement_retail_terms_v2' and a.retail_funding_receipt is null)
  then raise exception 'retail_funding_receipt_required';end if;
$insert$);
 definition:=pg_get_functiondef(p.oid);execute replace(definition,p.prosrc,body);
end $patch$;
commit;
