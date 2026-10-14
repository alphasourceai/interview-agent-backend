-- LOCAL ONLY. Repair the SAME 28-argument linked retail financial writer.
-- No SDK effects, public cancellation stamps, Auth, access or row backfill.
begin;
set local lock_timeout='10s';
do $baseline$
declare p record;g record;
begin
 perform private_retail_replacement.observation_schema_guard();
 select * into p from pg_proc where pronamespace='public'::regnamespace and proname='apply_public_purchase_billing';
 select * into g from pg_proc where oid='public.retail_linked_existing_member_schema_guard()'::regprocedure;
 if p.oid is null or md5(p.prosrc)<>'6ed48e7c15548a4521417b99ee213bd7'
  or not p.prosecdef or p.provolatile<>'v' or p.proconfig is distinct from array['search_path=""']
  or p.proowner<>(select oid from pg_roles where rolname='postgres')
  or not has_function_privilege('service_role',p.oid,'EXECUTE')
  or exists(select 1 from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner)))
   where grantee not in(p.proowner,(select oid from pg_roles where rolname='service_role')))
  or(select count(*) from pg_proc where pronamespace=p.pronamespace and proname=p.proname)<>1
  or exists(select 1 from pg_proc where position('6ed48e7c15548a4521417b99ee213bd7' in prosrc)>0 and oid<>g.oid)
  or exists(select 1 from pg_proc where pronamespace='private_retail_replacement'::regnamespace and proname='billing_replacement_proof')
  then raise exception 'retail_replacement_billing_prerequisite_drift';end if;
end $baseline$;

-- Owner-only invoker: receives native locked rows from the original definer.
-- NO locks, GUC, live reader or recursive linked/private catalog guard here.
create function private_retail_replacement.billing_replacement_proof(
 p_a public.membership_agreements,p_i public.public_purchase_intents,p_c public.clients,
 p_customer text,p_subscription text,p_clock timestamptz)
returns boolean language plpgsql volatile security invoker set search_path=pg_catalog set lock_timeout='10s' as $$
declare m record;self_pin text:='SELF_MD5:00000000000000000000000000000000';
 r private_retail_replacement.reservations;o private_retail_replacement.cancellations;
 src jsonb;w jsonb;b jsonb;q jsonb;old jsonb;expected jsonb;clock timestamptz;months integer;n bigint;
begin
 select * into m from pg_proc where oid='private_retail_replacement.billing_replacement_proof(public.membership_agreements,public.public_purchase_intents,public.clients,text,text,timestamp with time zone)'::regprocedure;
 if current_user<>'postgres' or current_setting('transaction_isolation')<>'read committed'
  or md5(regexp_replace(m.prosrc,'SELF_MD5:[a-f0-9]{32}','SELF_MD5:00000000000000000000000000000000','g')) is distinct from substring(self_pin from 10)
  or m.prosecdef or m.proisstrict or m.provolatile<>'v' or m.proconfig is distinct from array['search_path=pg_catalog','lock_timeout=10s']
  or m.proowner<>(select oid from pg_roles where rolname='postgres')
  or exists(select 1 from aclexplode(coalesce(m.proacl,acldefault('f',m.proowner))) where grantee<>m.proowner)
  or(select count(*) from pg_proc where pronamespace=m.pronamespace and proname=m.proname)<>1
  then raise exception 'retail_replacement_billing_helper_drift';end if;
 src:=p_a.checkout_attempt_source;w:=p_a.retail_funding_receipt;b:=w->'proof'->'period';clock:=clock_timestamp();
 if p_a.id is null or p_i.id is null or p_c.id is null or p_a.client_id is distinct from p_c.id
  or p_i.client_id is distinct from p_c.id or p_i.agreement_id is distinct from p_a.id
  or p_a.template_version is distinct from 'membership_agreement_retail_terms_v2'
  or p_a.template_snapshot->>'source' is null or p_a.template_snapshot->>'source' not in('sales_assisted','public_purchase_intent')
  or p_a.status is null or p_a.status not in('signed','active') or p_a.is_current is distinct from true
  or p_a.superseded_at is not null or p_a.superseded_by_agreement_id is not null or p_a.voided_at is not null
  or p_a.checkout_status is distinct from 'paid' or p_a.checkout_paid_at is null
  or p_i.protocol is distinct from 'fenced_v2' or p_i.status is distinct from 'completed' or p_i.canceled_at is not null
  or p_i.billing_applied_at is not null or p_i.billing_apply_digest is not null
  or p_i.activation_claim_key is null or length(p_i.activation_claim_key)<32 or p_i.activation_claimed_at is null
  or p_i.activation_claimed_at>clock or p_i.activation_claimed_at<clock-interval '5 minutes'
  or p_c.parent_client_id is not null or p_c.archived_at is not null
  or p_a.replaces_stripe_subscription_id is null or p_a.replaces_stripe_subscription_id !~ '^sub_[A-Za-z0-9_]+$'
  or length(p_a.replaces_stripe_subscription_id)>255 or p_a.replacement_policy is distinct from 'immediate_cancel'
  or p_c.stripe_subscription_id is distinct from p_a.replaces_stripe_subscription_id
  or p_a.replaces_stripe_subscription_id is not distinct from b->>'subscription_id'
  or p_subscription is distinct from b->>'subscription_id' or p_customer is distinct from b->>'customer_id'
  or p_c.stripe_customer_id is distinct from p_customer
  or(select count(*) from public.billing_customers where stripe_customer_id=p_customer)<>1
  or not exists(select 1 from public.billing_customers where stripe_customer_id=p_customer and client_id=p_c.id)
  or(select count(*) from public.public_purchase_intents where agreement_id=p_a.id)<>1
  or not coalesce(public.retail_existing_funding_receipt_valid(w,src),false)
  or p_a.checkout_session_id is distinct from b->>'checkout_session_id'
  or p_i.stripe_checkout_session_id is distinct from p_a.checkout_session_id
  or p_a.checkout_paid_at is distinct from (b->>'paid_at')::timestamptz or p_i.activated_at is distinct from p_a.checkout_paid_at
  or p_a.checkout_created_at is null or not isfinite(p_a.checkout_created_at) or p_a.checkout_created_at>clock
  or p_a.checkout_embedded is null or not coalesce(public.retail_existing_checkout_config_valid(src->'config'),false)
  or public.retail_existing_checkout_material(to_jsonb(p_a),to_jsonb(p_i),p_c.stripe_customer_id) is distinct from src-'config'
  or p_clock is null or not isfinite(p_clock) or p_clock>clock
  then raise exception 'retail_replacement_billing_admission_denied';end if;
 select * into r from private_retail_replacement.reservations where agreement_id=p_a.id;
 select * into o from private_retail_replacement.cancellations where agreement_id=p_a.id;
 q:=jsonb_build_object('version','retail_existing_replacement_cancel_v1','api_version','2023-10-16',
  'agreement_id',p_a.id,'client_id',p_c.id,'intent_id',p_i.id,
  'source_digest',encode(sha256(convert_to(src::text,'UTF8')),'hex'),
  'funding_receipt_digest',encode(sha256(convert_to(w::text,'UTF8')),'hex'),
  'provider_account_id',w->'proof'->'provider_account_id','livemode',b->'livemode','customer_id',b->'customer_id',
  'old_subscription_id',p_a.replaces_stripe_subscription_id,'new_subscription_id',b->'subscription_id',
  'cancellation',jsonb_build_object('method','DELETE','path','/v1/subscriptions/'||p_a.replaces_stripe_subscription_id,
   'parameters',jsonb_build_object('invoice_now',false,'prorate',false),'policy','immediate_cancel'));
 old:=o.observation->'old_subscription';clock:=clock_timestamp();
 if r.agreement_id is null or o.agreement_id is null or r.request is distinct from q
  or not isfinite(r.created_at) or r.created_at>clock
  or not coalesce(public.retail_existing_closed_object(old,array['id','customer','currency','livemode','status','canceled_at'])
   and old->'id'=q->'old_subscription_id' and old->'customer'=q->'customer_id' and old->>'currency'='usd'
   and jsonb_typeof(old->'livemode')='boolean' and old->'livemode'=q->'livemode'
   and old->>'status'='canceled' and jsonb_typeof(old->'canceled_at')='number'
   and old->>'canceled_at'~'^[1-9][0-9]{0,11}$',false)
  then raise exception 'retail_replacement_billing_observation_denied';end if;
 n:=(old->>'canceled_at')::bigint;
 expected:=jsonb_build_object('version','retail_existing_replacement_canceled_observation_v1','api_version','2023-10-16',
  'request',q,'journal_created_at',to_char(r.created_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
  'provider_account_id',q->'provider_account_id','old_subscription',old);
 if o.observation is distinct from expected or not isfinite(o.observed_at) or o.observed_at<r.created_at or o.observed_at>clock
  or n>253402300799 or n>floor(extract(epoch from clock)) then raise exception 'retail_replacement_billing_observation_denied';end if;
 months:=public.retail_existing_terms_months(to_jsonb(p_a),to_jsonb(p_i));clock:=clock_timestamp();
 if months is null or months not in(3,6,12) or b->>'api_version' is distinct from '2023-10-16'
  or (w->>'recorded_at')::timestamptz>clock or p_a.checkout_paid_at>clock
  or to_timestamp((b->>'provider_period_end')::bigint)<=clock
  or public.retail_existing_month_anchor(p_a.checkout_paid_at,months)<=clock
  or p_i.activation_claimed_at>clock or p_i.activation_claimed_at<clock-interval '5 minutes'
  then raise exception 'retail_replacement_billing_clock_denied';end if;
 return true;
end $$;
revoke all on function private_retail_replacement.billing_replacement_proof(public.membership_agreements,public.public_purchase_intents,public.clients,text,text,timestamptz)
 from public,anon,authenticated,service_role;

do $patch$
declare p record;g record;h record;body text;guard_body text;definition text;needle text;addition text;helper_digest text;billing_digest text;digest text;
 signature text:='public.apply_public_purchase_billing(uuid,text,uuid,uuid,text,text,text,text,text,text,timestamptz,boolean,boolean,timestamptz,timestamptz,timestamptz,numeric,numeric,integer,numeric,integer,boolean,text,integer,integer,integer,boolean,boolean)';
begin
 select * into h from pg_proc where oid='private_retail_replacement.billing_replacement_proof(public.membership_agreements,public.public_purchase_intents,public.clients,text,text,timestamp with time zone)'::regprocedure;
 body:=h.prosrc;digest:=md5(body);
 body:=replace(body,$needle$self_pin text:='SELF_MD5:00000000000000000000000000000000'$needle$,format('self_pin text:=%L','SELF_MD5:'||digest));
 execute replace(pg_get_functiondef(h.oid),h.prosrc,body);helper_digest:=md5(body);
 select * into p from pg_proc where oid=to_regprocedure(signature);
 select * into g from pg_proc where oid='public.retail_linked_existing_member_schema_guard()'::regprocedure;
 body:=p.prosrc;guard_body:=g.prosrc;
 needle:=E'\n  v_retail_months integer;';
 if array_length(string_to_array(body,needle),1)<>2 then raise exception 'retail_replacement_billing_patch_drift';end if;
 body:=replace(body,needle,needle||E'\n  v_replacement_shaped boolean:=false;\n  v_replacement_helper record;');
 addition:=$proof$
    select * into v_replacement_helper from pg_catalog.pg_proc where oid='private_retail_replacement.billing_replacement_proof(public.membership_agreements,public.public_purchase_intents,public.clients,text,text,timestamp with time zone)'::pg_catalog.regprocedure;
    if pg_catalog.md5(v_replacement_helper.prosrc) is distinct from 'REPLACEMENT_HELPER_MD5'
      or v_replacement_helper.prosecdef or v_replacement_helper.proisstrict or v_replacement_helper.provolatile<>'v'
      or v_replacement_helper.proconfig is distinct from array['search_path=pg_catalog','lock_timeout=10s']
      or v_replacement_helper.proowner<>(select oid from pg_catalog.pg_roles where rolname='postgres')
      or exists(select 1 from pg_catalog.aclexplode(coalesce(v_replacement_helper.proacl,pg_catalog.acldefault('f',v_replacement_helper.proowner))) where grantee<>v_replacement_helper.proowner)
      or(select count(*) from pg_catalog.pg_proc where pronamespace=v_replacement_helper.pronamespace and proname=v_replacement_helper.proname)<>1
      then raise exception 'retail_replacement_billing_helper_drift';end if;
    perform private_retail_replacement.billing_replacement_proof(v_agreement,v_intent,v_client,p_stripe_customer_id,p_stripe_subscription_id,v_now);
$proof$;
 addition:=replace(addition,'REPLACEMENT_HELPER_MD5',helper_digest);
 needle:=E'\n  -- Only a first application inspects mutable client/plan/credit state.';
 if array_length(string_to_array(body,needle),1)<>2 then raise exception 'retail_replacement_billing_patch_drift';end if;
 body:=replace(body,needle,$shape$
  -- Mandatory first-write gate. Null/already-new root cannot bypass admission.
  v_replacement_shaped:=coalesce(v_agreement.template_version='membership_agreement_retail_terms_v2'
    and v_agreement.retail_funding_receipt is not null
    and(v_agreement.template_snapshot->>'source' is null
      or v_agreement.template_snapshot->>'source' not in('sales_assisted','public_purchase_intent')
      or v_agreement.replaces_stripe_subscription_id is not null or v_agreement.replacement_policy is not null),false);
  if v_replacement_shaped then
    perform private_retail_replacement.observation_schema_guard();
$shape$||addition||E'\n  end if;\n'||needle);
 needle:=$client$
  if v_client.plan_tier is not null and v_client.plan_tier is distinct from p_plan_tier
    or v_client.billing_interval is not null and v_client.billing_interval is distinct from p_billing_interval then
    raise exception using errcode = 'P0001', message = 'existing_client_plan_conflict';
  end if;
  if v_client.stripe_customer_id is not null and v_client.stripe_customer_id is distinct from p_stripe_customer_id
    or v_client.stripe_subscription_id is not null and v_client.stripe_subscription_id is distinct from p_stripe_subscription_id then
    raise exception using errcode = 'P0001', message = 'billing_identity_conflict';
  end if;
$client$;
 if array_length(string_to_array(body,needle),1)<>2 then raise exception 'retail_replacement_billing_patch_drift';end if;
 body:=replace(body,needle,E'\n  if not v_replacement_shaped then'||needle||E'\n  end if;\n');
 needle:=$plan$
  if found and (v_plan.plan_tier is distinct from p_plan_tier
    or v_plan.billing_interval is distinct from p_billing_interval) then
    raise exception using errcode = 'P0001', message = 'existing_plan_conflict';
  end if;
$plan$;
 if array_length(string_to_array(body,needle),1)<>2 then raise exception 'retail_replacement_billing_patch_drift';end if;
 body:=replace(body,needle,E'\n  if not v_replacement_shaped then'||needle||E'\n  end if;\n');
 needle:=E'\n  -- The original plan/credit locks may have waited.';
 if array_length(string_to_array(body,needle),1)<>2 then raise exception 'retail_replacement_billing_patch_drift';end if;
 body:=replace(body,needle,$last$
  -- Original upstream/plan/credit locks first, shared advisory LAST.
  if v_replacement_shaped then
    perform pg_catalog.pg_advisory_xact_lock(1632842307,pg_catalog.hashtext(v_agreement.id::text));
    v_now:=pg_catalog.clock_timestamp();
    perform private_retail_replacement.observation_schema_guard();
$last$||addition||E'\n  end if;\n'||needle);
 -- Preserve original signature/owner/ACL/definer/search_path and native digest.
 execute replace(pg_get_functiondef(p.oid),p.prosrc,body);billing_digest:=md5(body);
 -- No catalog guard may run in this swap/amend gap.
 if array_length(string_to_array(guard_body,'6ed48e7c15548a4521417b99ee213bd7'),1)<>2 then raise exception 'retail_replacement_billing_pin_drift';end if;
 guard_body:=replace(guard_body,'6ed48e7c15548a4521417b99ee213bd7',billing_digest);
 guard_body:=regexp_replace(guard_body,'SELF_MD5:[a-f0-9]{32}','SELF_MD5:00000000000000000000000000000000','g');digest:=md5(guard_body);
 guard_body:=replace(guard_body,$needle$self_pin text:='SELF_MD5:00000000000000000000000000000000'$needle$,format('self_pin text:=%L','SELF_MD5:'||digest));
 execute replace(pg_get_functiondef(g.oid),g.prosrc,guard_body);
 perform private_retail_replacement.observation_schema_guard();
 select * into h from pg_proc where oid=h.oid;
 if md5(h.prosrc) is distinct from helper_digest or h.prosecdef or h.provolatile<>'v'
  or h.proconfig is distinct from array['search_path=pg_catalog','lock_timeout=10s']
  or h.proowner<>(select oid from pg_roles where rolname='postgres')
  or exists(select 1 from aclexplode(coalesce(h.proacl,acldefault('f',h.proowner))) where grantee<>h.proowner)
  then raise exception 'retail_replacement_billing_helper_drift';end if;
end $patch$;
commit;
