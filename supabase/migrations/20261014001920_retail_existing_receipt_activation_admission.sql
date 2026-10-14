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

-- Existing definer completion executes bookkeeping as postgres. Never invoke
-- the service-only reader/context by forging its executing role. This separate
-- invoker trigger predicate uses the actual row and downstream SHARE locks.
create function public.retail_existing_funding_admission_context(a public.membership_agreements,p_phase text)
returns void language plpgsql volatile security invoker set search_path=pg_catalog set lock_timeout='10s' as $$
declare c public.clients;i public.public_purchase_intents;had_intent boolean;w jsonb:=a.retail_funding_receipt;
 m jsonb;clock timestamptz;
begin
 if current_user not in('service_role','postgres') then raise exception 'retail_funding_admission_server_only';end if;
 perform public.retail_existing_funding_schema_guard();
 if a.id is null or a.status is distinct from 'signed' or a.is_current is distinct from true
  or a.superseded_by_agreement_id is not null or a.superseded_at is not null or a.voided_at is not null
  or a.checkout_attempt_source is null or w is null
  or not coalesce(public.retail_existing_funding_receipt_valid(w,a.checkout_attempt_source),false)
  or w->'proof'->'period'->>'checkout_session_id' is distinct from a.checkout_session_id
  or p_phase not in('paid','activated') or p_phase is null
  or (p_phase='paid' and (a.checkout_paid_at is not null or a.checkout_status is distinct from 'pending_payment'))
  or (p_phase='activated' and (a.checkout_paid_at is distinct from (w->'proof'->'period'->>'paid_at')::timestamptz
   or a.checkout_status is distinct from 'paid')) then raise exception 'retail_funding_admission_source_denied';end if;
 -- Do not lock an intent after an agreement (reverse order). Original native
 -- completion already owns its intent lock; standalone service DML is trusted.
 begin select * into strict i from public.public_purchase_intents where agreement_id=a.id;had_intent:=true;
 exception when no_data_found then had_intent:=false;when too_many_rows then raise exception 'retail_funding_intent_ambiguous';end;
 select * into c from public.clients where id=a.client_id for share;
 perform 1 from public.billing_customers where stripe_customer_id=a.checkout_attempt_source->>'customer_id' order by id for share;
 perform public.retail_existing_funding_schema_guard();clock:=clock_timestamp();
 if had_intent and (i.client_id is distinct from a.client_id or i.status is distinct from 'checkout_pending'
  or i.protocol is distinct from 'fenced_v2' or i.canceled_at is not null or i.activated_at is not null
  or i.stripe_checkout_session_id is distinct from a.checkout_session_id or i.activation_claim_key is null
  or length(i.activation_claim_key)<32 or i.activation_claimed_at is null
  or i.activation_claimed_at<clock-interval '5 minutes' or i.activation_claimed_at>clock)
  then raise exception 'retail_funding_admission_claim_denied';end if;
 if c.id is null or c.parent_client_id is not null or c.archived_at is not null
  or c.stripe_customer_id is distinct from a.checkout_attempt_source->>'customer_id'
  or c.stripe_customer_id is distinct from w->'proof'->'period'->>'customer_id'
  or (c.stripe_subscription_id is not null and c.stripe_subscription_id is distinct from a.replaces_stripe_subscription_id
   and c.stripe_subscription_id is distinct from w->'proof'->'period'->>'subscription_id')
  or (select count(*) from public.billing_customers where stripe_customer_id=c.stripe_customer_id)<>1
  or not exists(select 1 from public.billing_customers where stripe_customer_id=c.stripe_customer_id and client_id=c.id)
  then raise exception 'retail_funding_admission_customer_denied';end if;
 m:=public.retail_existing_checkout_material(to_jsonb(a),case when had_intent then to_jsonb(i) else null end,c.stripe_customer_id);
 if m is distinct from a.checkout_attempt_source-'config'
  or not coalesce(public.retail_existing_checkout_config_valid(a.checkout_attempt_source->'config'),false)
  or a.checkout_embedded is null or a.checkout_created_at is null or not isfinite(a.checkout_created_at)
  or a.checkout_created_at>clock or (w->>'recorded_at')::timestamptz>clock then
  raise exception 'retail_funding_admission_source_denied';end if;
end $$;
revoke all on function public.retail_existing_funding_admission_context(public.membership_agreements,text) from public,anon,authenticated;
grant execute on function public.retail_existing_funding_admission_context(public.membership_agreements,text) to service_role;

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
  and (old.template_version='membership_agreement_retail_terms_v2' or new.template_version='membership_agreement_retail_terms_v2') then
  if old.retail_funding_receipt is null then raise exception 'retail_funding_receipt_required';end if;
  if new.checkout_status is distinct from 'paid' then raise exception 'retail_funding_admission_paid_status_required';end if;
  perform public.retail_existing_funding_admission_context(old,'paid');end if;
$insert$||needle);
 definition:=pg_get_functiondef(p.oid);execute replace(definition,p.prosrc,body);
 select * into p from pg_proc where oid='public.retail_existing_funding_intent_clock_guard()'::regprocedure;
 needle:=E' if new.activated_at is null then return new;end if;';
 if array_length(string_to_array(p.prosrc,needle),1)<>2 then raise exception 'retail_funding_admission_patch_drift';end if;
 body:=replace(p.prosrc,needle,needle||$insert$
 if TG_OP='INSERT' or old.activated_at is null then
  if exists(select 1 from public.membership_agreements a where a.id=new.agreement_id
   and a.template_version='membership_agreement_retail_terms_v2' and a.retail_funding_receipt is null)
   then raise exception 'retail_funding_receipt_required';end if;
  perform public.retail_existing_funding_admission_context(a,'activated') from public.membership_agreements a
   where a.id=new.agreement_id and a.template_version='membership_agreement_retail_terms_v2';end if;
$insert$);
 definition:=pg_get_functiondef(p.oid);execute replace(definition,p.prosrc,body);
end $patch$;
commit;
