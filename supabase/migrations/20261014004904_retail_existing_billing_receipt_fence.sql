-- LOCAL ONLY. Guard the original 28-argument writer; no protocol/Auth changes,
-- new functions, grants, row backfill, or altered historical no-receipt path.
begin;
set local lock_timeout='10s';
do $patch$
declare p record;s text[];body text;definition text;needle text;
 signature text:='public.apply_public_purchase_billing(uuid,text,uuid,uuid,text,text,text,text,text,text,timestamptz,boolean,boolean,timestamptz,timestamptz,timestamptz,numeric,numeric,integer,numeric,integer,boolean,text,integer,integer,integer,boolean,boolean)';
begin
 select * into p from pg_proc where oid=to_regprocedure(signature);
 if not found or md5(p.prosrc) is distinct from 'ace97c3a8b16ff4a1cd669a7fb42c3d6'
  or p.prosecdef is distinct from true or p.provolatile<>'v'
  or p.proconfig is distinct from array['search_path=""']
  or p.proowner is distinct from (select oid from pg_roles where rolname='postgres')
  or not has_function_privilege('service_role',p.oid,'EXECUTE')
  or exists(select 1 from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner)))
   where grantee not in(p.proowner,(select oid from pg_roles where rolname='service_role')))
  then raise exception 'retail_funding_billing_prerequisite_drift';end if;
 foreach s slice 1 in array array[
  array['retail_existing_funding_schema_guard()','abfab9e6f97d88c8aa940b8a993db42b','s'],
  array['retail_existing_funding_receipt_valid(jsonb,jsonb)','655f4866f0cf52144c3abf76bc02ac94','i'],
  array['retail_existing_checkout_material(jsonb,jsonb,text)','67699a36b8267739c5655764a7c0203f','i'],
  array['retail_existing_checkout_config_valid(jsonb)','c433714eff703c41b1590f890dc8ba7d','i']] loop
  select * into p from pg_proc where oid=to_regprocedure('public.'||s[1]);
  if not found or md5(p.prosrc) is distinct from s[2] or p.prosecdef or p.provolatile::text<>s[3]
   or p.proconfig is distinct from array['search_path=pg_catalog']
   or p.proowner is distinct from (select oid from pg_roles where rolname='postgres')
   or not has_function_privilege('service_role',p.oid,'EXECUTE')
   or exists(select 1 from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner)))
    where grantee not in(p.proowner,(select oid from pg_roles where rolname='service_role')))
   then raise exception 'retail_funding_billing_prerequisite_drift';end if;
 end loop;
 perform public.retail_existing_funding_schema_guard();
 select * into p from pg_proc where oid=to_regprocedure(signature);
 body:=p.prosrc;
 needle:=E'\n  v_retail_months := public.retail_existing_terms_months';
 if array_length(string_to_array(body,needle),1)<>2 then raise exception 'retail_funding_billing_patch_drift';end if;
 body:=replace(body,needle,$insert$
  -- Original intent/agreement/client UPDATE locks are already owned. Take
  -- narrow downstream global profile SHARE locks, never reverse row order.
  -- Do NOT call pending admission or service-only replay reader as postgres.
  if v_agreement.template_version='membership_agreement_retail_terms_v2'
    and v_agreement.retail_funding_receipt is not null then
    perform public.retail_existing_funding_schema_guard();
    perform 1 from public.billing_customers
      where stripe_customer_id=v_agreement.checkout_attempt_source->>'customer_id'
      order by id for share;
    perform public.retail_existing_funding_schema_guard();
    v_now:=clock_timestamp();
    if p_claim_key is null or length(p_claim_key)<32
      or v_intent.activation_claim_key is distinct from p_claim_key
      or v_intent.activation_claimed_at is null
      or v_intent.activation_claimed_at<v_now-interval '5 minutes'
      or v_intent.activation_claimed_at>v_now then
      raise exception using errcode='P0001',message='retail_funding_billing_claim_denied';end if;
    if v_agreement.status is null or v_agreement.status not in('signed','active')
      or v_agreement.is_current is distinct from true or v_agreement.superseded_at is not null
      or v_agreement.superseded_by_agreement_id is not null or v_agreement.voided_at is not null
      or v_agreement.checkout_status is distinct from 'paid'
      or not coalesce(public.retail_existing_funding_receipt_valid(
        v_agreement.retail_funding_receipt,v_agreement.checkout_attempt_source),false)
      or v_agreement.checkout_session_id is distinct from v_agreement.retail_funding_receipt->'proof'->'period'->>'checkout_session_id'
      or v_intent.stripe_checkout_session_id is distinct from v_agreement.checkout_session_id
      or v_agreement.checkout_paid_at is distinct from (v_agreement.retail_funding_receipt->'proof'->'period'->>'paid_at')::timestamptz
      or v_intent.activated_at is distinct from v_agreement.checkout_paid_at
      or p_stripe_customer_id is distinct from v_agreement.retail_funding_receipt->'proof'->'period'->>'customer_id'
      or p_stripe_subscription_id is distinct from v_agreement.retail_funding_receipt->'proof'->'period'->>'subscription_id'
      or (v_agreement.retail_funding_receipt->>'recorded_at')::timestamptz>v_now
      or v_agreement.checkout_created_at is null or not isfinite(v_agreement.checkout_created_at)
      or v_agreement.checkout_created_at>v_now or v_agreement.checkout_embedded is null
      or public.retail_existing_checkout_material(to_jsonb(v_agreement),to_jsonb(v_intent),v_client.stripe_customer_id)
        is distinct from v_agreement.checkout_attempt_source-'config'
      or not coalesce(public.retail_existing_checkout_config_valid(v_agreement.checkout_attempt_source->'config'),false)
      then raise exception using errcode='P0001',message='retail_funding_billing_source_denied';end if;
    if v_client.parent_client_id is not null or v_client.archived_at is not null
      or v_client.stripe_customer_id is distinct from p_stripe_customer_id
      or (select count(*) from public.billing_customers where stripe_customer_id=p_stripe_customer_id)<>1
      or not exists(select 1 from public.billing_customers where stripe_customer_id=p_stripe_customer_id and client_id=v_client.id)
      or (v_intent.billing_applied_at is not null and v_client.stripe_subscription_id is distinct from p_stripe_subscription_id)
      or (v_intent.billing_applied_at is null and v_client.stripe_subscription_id is not null
        and v_client.stripe_subscription_id is distinct from p_stripe_subscription_id
        and v_client.stripe_subscription_id is distinct from v_agreement.replaces_stripe_subscription_id)
      then raise exception using errcode='P0001',message='retail_funding_billing_customer_denied';end if;
  end if;
$insert$||needle);
 needle:=E'\n  update public.clients set';
 if array_length(string_to_array(body,needle),1)<>2 then raise exception 'retail_funding_billing_patch_drift';end if;
 body:=replace(body,needle,$insert$
  -- The original plan/credit locks may have waited. Use a NEW native clock
  -- immediately before the first DML, not the stale pre-wait v_now snapshot.
  if v_agreement.template_version='membership_agreement_retail_terms_v2'
    and v_agreement.retail_funding_receipt is not null then
    v_now:=clock_timestamp();
    if v_intent.activation_claimed_at is null or v_intent.activation_claimed_at>v_now
      or v_intent.activation_claimed_at<v_now-interval '5 minutes' then
      raise exception using errcode='P0001',message='retail_funding_billing_claim_denied';end if;
  end if;
$insert$||needle);
 -- Replace only the body of the SAME existing function/signature. PostgreSQL
 -- preserves its original owner/ACL/definer/config; never DROP/recreate.
 definition:=pg_get_functiondef(p.oid);execute replace(definition,p.prosrc,body);
end $patch$;
commit;
