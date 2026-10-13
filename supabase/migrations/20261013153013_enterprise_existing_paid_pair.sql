-- LOCAL, UNMOUNTED: atomic completion of EXISTING agreement and pool rows.
-- Financial service writer, not provider authentication, Auth or delivery.
begin;
set local lock_timeout='10s';
do $baseline$
declare spec text[]; p record; x record;
begin
 foreach spec slice 1 in array array[
  array['enterprise_existing_pending_agreement_guard()','3b66f33ed9b06c128256eb5e7dea7ac7'],
  array['enterprise_existing_pending_pool_guard()','baeb4233953221be03c32114eb2c7ee6'],
  array['enterprise_existing_pending_pair_guard()','4e81301443662fc1f5bef56966b866e0'],
  array['enterprise_pool_v2_guard_pool()','5ec10701ca59c0c9fd6735a6f644c1a0'],
  array['enterprise_existing_billing_context(public.membership_agreements)','b324f967aec3fc19e526f78a0c506e7c'],
  array['enterprise_existing_funding_context(public.membership_agreements)','84c7a3ff1fe1a4c08e2fb17983ed0c76'],
  array['enterprise_existing_billing_receipt_valid(jsonb,jsonb,jsonb)','83d1be66006c96d57912cc7647a25701'],
  array['enterprise_existing_funding_receipt_valid(jsonb,jsonb,jsonb)','0737dfd61db15300e835cabe44cf885b'],
  array['enterprise_existing_funding_guard()','25d107b108fe853330325257fa2870d1'],
  array['enterprise_existing_billing_guard()','e7fe4203a4f78c0ba1157649cb316887'],
  array['enterprise_pool_v2_guard_source()','483cc416ab9ee7e3017f3ee8d0490daa'],
  array['read_enterprise_existing_billing(uuid)','6f0719620d7073a463b8fc6a6a8b4808']
 ] loop
  select * into p from pg_proc where oid=to_regprocedure('public.'||spec[1]);
  if not found or p.prosecdef or (spec[2]<>'' and md5(p.prosrc)<>spec[2])
   or p.proconfig is distinct from(case when spec[1] like 'read_%' then array['search_path=pg_catalog','lock_timeout=10s'] else array['search_path=pg_catalog'] end)
   or has_function_privilege('anon',p.oid,'EXECUTE') or has_function_privilege('authenticated',p.oid,'EXECUTE')
   or not has_function_privilege('service_role',p.oid,'EXECUTE') then raise exception 'enterprise_payment_prerequisite_drift';end if;
 end loop;
 for x in select * from(values
  ('membership_agreements','enterprise_existing_pending_agreement_guard','enterprise_existing_pending_agreement_guard',31,false),
  ('client_interview_pools','enterprise_existing_pending_pool_guard','enterprise_existing_pending_pool_guard',31,false),
  ('membership_agreements','enterprise_existing_pending_agreement_pair','enterprise_existing_pending_pair_guard',21,true),
  ('client_interview_pools','enterprise_existing_pending_pool_pair','enterprise_existing_pending_pair_guard',21,true),
  ('client_interview_pools','enterprise_pool_v2_guard_pool','enterprise_pool_v2_guard_pool',31,false),
  ('membership_agreements','enterprise_existing_funding_guard','enterprise_existing_funding_guard',31,false),
  ('membership_agreements','enterprise_existing_billing_guard','enterprise_existing_billing_guard',31,false),
  ('membership_agreements','enterprise_pool_v2_guard_source','enterprise_pool_v2_guard_source',27,false)
 )t(tab,name,func,kind,deferred) loop
  if not exists(select 1 from pg_trigger where tgrelid=to_regclass('public.'||x.tab) and tgname=x.name and tgenabled='O'
   and tgtype=x.kind and tgfoid=to_regprocedure('public.'||x.func||'()') and tgdeferrable=x.deferred and tginitdeferred=x.deferred)
   then raise exception 'enterprise_payment_trigger_drift';end if;
 end loop;
 if not exists(select 1 from pg_index i join pg_attribute a on a.attrelid=i.indrelid and a.attname='stripe_subscription_id'
   where i.indexrelid=to_regclass('public.clients_stripe_subscription_id_uniq') and i.indrelid='public.clients'::regclass
    and i.indisunique and i.indisvalid and i.indisready and i.indnkeyatts=1 and i.indkey[0]=a.attnum
    and pg_get_expr(i.indpred,i.indrelid)='(stripe_subscription_id IS NOT NULL)')
  or not exists(select 1 from pg_index i join pg_attribute a on a.attrelid=i.indrelid and a.attname='agreement_id'
   where i.indexrelid=to_regclass('public.enterprise_pool_one_initial_agreement') and i.indrelid='public.client_interview_pools'::regclass
    and i.indisunique and i.indisvalid and i.indisready and i.indnkeyatts=1 and i.indkey[0]=a.attnum
    and pg_get_expr(i.indpred,i.indrelid)='(agreement_id IS NOT NULL)')
  or not exists(select 1 from pg_constraint where conrelid='public.membership_agreements'::regclass
    and conname='enterprise_existing_funding_receipt_check' and contype='c' and convalidated)
  or not exists(select 1 from pg_constraint where conrelid='public.membership_agreements'::regclass
    and conname='enterprise_existing_billing_receipt_check' and contype='c' and convalidated)
  then raise exception 'enterprise_payment_financial_schema_drift';end if;
 if to_regprocedure('public.complete_enterprise_existing_payment(uuid,uuid,jsonb)') is not null
  or to_regclass('public.enterprise_pool_one_payment_intent') is not null
  or exists(select 1 from public.client_interview_pools where stripe_payment_intent_id is not null
    group by stripe_payment_intent_id having count(*)>1)
  then raise exception 'enterprise_payment_schema_or_duplicate_drift';end if;
 foreach spec slice 1 in array array[
  array['enterprise_funding_one_checkout','checkout_session_id'],array['enterprise_funding_one_subscription','subscription_id'],
  array['enterprise_funding_one_invoice','invoice_id'],array['enterprise_funding_one_pi','payment_intent_id'],array['enterprise_funding_one_charge','charge_id']
 ] loop
  if not exists(select 1 from pg_index i where i.indexrelid=to_regclass('public.'||spec[1])
   and i.indrelid='public.membership_agreements'::regclass and i.indisunique and i.indisvalid and i.indisready
   and i.indnkeyatts=3 and i.indnatts=3 and pg_get_expr(i.indpred,i.indrelid)='(enterprise_funding_receipt IS NOT NULL)'
   and regexp_replace(pg_get_expr(i.indexprs,i.indrelid),'[()[:space:]]','','g')=
    'enterprise_funding_receipt->''proof''::text->>''provider_account_id''::text,enterprise_funding_receipt->''proof''::text->>''livemode''::text,enterprise_funding_receipt->''proof''::text->>'''||spec[2]||'''::text')
   then raise exception 'enterprise_payment_cash_index_drift';end if;
 end loop;
 foreach spec slice 1 in array array[array['membership_agreements'],array['client_interview_pools'],array['clients'],array['billing_customers']] loop
  if not exists(select 1 from pg_class where oid=to_regclass('public.'||spec[1]) and relrowsecurity)
   or not has_table_privilege('service_role','public.'||spec[1],'SELECT')
   or not has_table_privilege('service_role','public.'||spec[1],'UPDATE')
   then raise exception 'enterprise_payment_acl_drift';end if;
 end loop;
end $baseline$;
create unique index enterprise_pool_one_payment_intent on public.client_interview_pools(stripe_payment_intent_id)
 where stripe_payment_intent_id is not null;

create function public.enterprise_existing_paid_agreement_valid(a public.membership_agreements)
returns boolean language plpgsql immutable security invoker set search_path=pg_catalog as $$
declare w jsonb:=a.enterprise_billing_receipt; f jsonb:=a.enterprise_funding_receipt;
begin
 return coalesce(public.enterprise_existing_billing_receipt_valid(w,a.enterprise_checkout_source,a.enterprise_checkout_prices)
  and w->'funding_receipt'=f and a.checkout_status='paid'
  and a.checkout_paid_at=(f->'proof'->>'payment_success_at')::timestamptz
  and a.client_id::text=f->'proof'->>'client_id' and a.enterprise_checkout_pool_id::text=f->'proof'->>'pool_id'
  and a.checkout_session_id=f->'proof'->>'checkout_session_id',false);
exception when others then return false;
end $$;
create function public.enterprise_existing_paid_pool_valid(a public.membership_agreements,p public.client_interview_pools)
returns boolean language sql immutable security invoker set search_path=pg_catalog as $$
 select coalesce(public.enterprise_existing_paid_agreement_valid(a) and p.status='paid'
  and p.id=a.enterprise_checkout_pool_id and p.agreement_id=a.id and p.client_id=a.client_id
  and p.stripe_checkout_session_id=a.checkout_session_id
  and p.paid_at=a.checkout_paid_at and p.stripe_payment_intent_id=a.enterprise_funding_receipt->'proof'->>'payment_intent_id'
  and p.offer_snapshot=a.template_snapshot->'values'->'pool_offer_snapshot'
  and p.offer_digest=a.template_snapshot->'values'->>'pool_offer_digest',false);
$$;
-- First transition only. Never impose current/admin-state equality on later
-- historical supersession, billing edits or allocation reads.
create function public.enterprise_existing_payment_current(a public.membership_agreements)
returns void language plpgsql security invoker set search_path=pg_catalog as $$
declare c public.clients; seal public.enterprise_v2_execution_seals;
begin
 select * into c from public.clients where id=a.client_id;
 select * into seal from public.enterprise_v2_execution_seals where agreement_id=a.id;
 if current_user<>'service_role' or a.status is distinct from 'signed' or a.is_current is distinct from true
  or a.superseded_at is not null or a.superseded_by_agreement_id is not null
  or c.id is null or c.stripe_customer_id is distinct from a.enterprise_funding_receipt->'proof'->>'customer_id'
  or c.stripe_subscription_id is distinct from a.enterprise_funding_receipt->'proof'->>'subscription_id'
  or (select count(*) from public.billing_customers where stripe_customer_id=c.stripe_customer_id)<>1
  or not exists(select 1 from public.billing_customers where stripe_customer_id=c.stripe_customer_id and client_id=c.id)
  or public.enterprise_existing_pending_material(to_jsonb(a),to_jsonb(c),to_jsonb(seal)) is distinct from a.enterprise_checkout_source->'material'
  or exists(select 1 from public.public_purchase_intents where agreement_id=a.id)
  then raise exception 'enterprise_payment_current_denied';end if;
end $$;

-- Revised existing guards/context are materialized below from their pinned
-- prior sources, preserving all unchanged source/offer/session validations.

create or replace function public.enterprise_existing_pending_agreement_guard()
returns trigger language plpgsql security invoker set search_path=pg_catalog as $$
declare src jsonb; b timestamptz;expiry timestamptz;c jsonb;s jsonb;
begin
 if TG_OP='DELETE' then if old.enterprise_checkout_source is not null then raise exception 'enterprise_binding_immutable';end if;return old;end if;
 if TG_OP='INSERT' then
  if new.enterprise_checkout_source is not null or new.enterprise_checkout_pool_id is not null or new.enterprise_checkout_prices is not null then raise exception 'enterprise_binding_claim_required';end if;return new;
 end if;
 if old.enterprise_checkout_source is null and new.enterprise_checkout_source is null then
  if new.enterprise_checkout_pool_id is not null or new.enterprise_checkout_prices is not null then raise exception 'enterprise_binding_claim_required';end if;return new;
 end if;
 if old.enterprise_checkout_source is not null and (new.enterprise_checkout_source is distinct from old.enterprise_checkout_source
  or new.enterprise_checkout_pool_id is distinct from old.enterprise_checkout_pool_id) then raise exception 'enterprise_binding_immutable';end if;
 if old.enterprise_checkout_prices is not null and new.enterprise_checkout_prices is distinct from old.enterprise_checkout_prices then raise exception 'enterprise_trace_prices_immutable';end if;
 if old.checkout_session_id is not null and new.checkout_session_id is distinct from old.checkout_session_id then raise exception 'enterprise_trace_session_immutable';end if;
 if (old.enterprise_checkout_prices is null and new.enterprise_checkout_prices is not null) or(old.checkout_session_id is null and new.checkout_session_id is not null) then
  if current_user<>'service_role' or old.status is distinct from 'signed' or old.is_current is distinct from true
   or old.superseded_at is not null or old.superseded_by_agreement_id is not null then raise exception 'enterprise_trace_server_only';end if;
 end if;
 if old.checkout_status='paid' and(new.checkout_status,new.checkout_paid_at) is distinct from(old.checkout_status,old.checkout_paid_at)
  then raise exception 'enterprise_payment_immutable';end if;
 if new.checkout_attempt_source is not null or new.checkout_embedded is not null then raise exception 'enterprise_binding_pending_only';end if;
 if new.checkout_paid_at is not null or new.checkout_status='paid' then
  if current_user<>'service_role' or not public.enterprise_existing_paid_agreement_valid(new)
   then raise exception 'enterprise_payment_agreement_denied';end if;
  if old.checkout_status is distinct from 'paid' then
   if old.checkout_status is distinct from 'pending_payment' or old.checkout_paid_at is not null
    or public.read_enterprise_existing_billing(old.id) is distinct from new.enterprise_billing_receipt
    then raise exception 'enterprise_payment_first_denied';end if;
  end if;
 end if;
 src:=new.enterprise_checkout_source;
 if jsonb_typeof(src) is distinct from 'object' or(select count(*) from jsonb_object_keys(src))<>8
  or not(src ?& array['version','material','pool_id','created_at','expires_at','embedded','replacement_id','config'])
  or src->>'version' is distinct from 'enterprise_existing_pending_v1' or src->>'pool_id' is distinct from new.enterprise_checkout_pool_id::text
  or jsonb_typeof(src->'embedded') is distinct from 'boolean' or not coalesce(public.enterprise_existing_pending_config_valid(src->'config'),false)
  or(src->'replacement_id'<>'null'::jsonb and(jsonb_typeof(src->'replacement_id')<>'string' or src->>'replacement_id' !~ '^sub_[A-Za-z0-9_]+$'))
  then raise exception 'enterprise_binding_source_denied';end if;
 select to_jsonb(x) into c from public.clients x where id=new.client_id;
 select to_jsonb(x) into s from public.enterprise_v2_execution_seals x where agreement_id=new.id;
 if public.enterprise_existing_pending_material(to_jsonb(new),c,s) is distinct from src->'material' then raise exception 'enterprise_binding_source_denied';end if;
 b:=(src->>'created_at')::timestamptz;expiry:=(src->>'expires_at')::timestamptz;
 if not coalesce(isfinite(b),false) or src->>'created_at' is distinct from to_char(b at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  or src->>'expires_at' is distinct from to_char(expiry at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
  or expiry is distinct from public.enterprise_existing_pending_expiry(b,new.agreement_expires_at) then raise exception 'enterprise_binding_clock_denied';end if;
 if old.enterprise_checkout_source is null then
  if current_user<>'service_role' or old.enterprise_checkout_pool_id is not null or old.enterprise_checkout_prices is not null
   or old.checkout_created_at is not null or old.checkout_session_id is not null or new.enterprise_checkout_prices is not null or new.checkout_session_id is not null
   or old.status is distinct from 'signed' or old.is_current is distinct from true or old.superseded_at is not null or old.superseded_by_agreement_id is not null
   or b>clock_timestamp() or b<clock_timestamp()-interval '10 seconds' or expiry<clock_timestamp()+interval '30 minutes'
   or exists(select 1 from public.public_purchase_intents where agreement_id=new.id) then raise exception 'enterprise_binding_claim_denied';end if;
 end if;
 if new.enterprise_checkout_prices is not null and not coalesce(public.enterprise_existing_checkout_prices_valid(new.enterprise_checkout_prices),false) then raise exception 'enterprise_trace_prices_denied';end if;
 if (old.enterprise_checkout_prices is null and new.enterprise_checkout_prices is not null) or(old.checkout_session_id is null and new.checkout_session_id is not null) then
  if expiry<clock_timestamp()+interval '30 minutes' then raise exception 'enterprise_trace_window_closed';end if;
 end if;
 if new.checkout_session_id is null then
  if new.checkout_created_at is not null or new.checkout_status is not null or new.replaces_stripe_subscription_id is not null or new.replacement_policy is not null then raise exception 'enterprise_trace_incomplete';end if;
 else
  if new.checkout_session_id !~ '^cs_[A-Za-z0-9_]+$' or new.enterprise_checkout_prices is null or new.checkout_created_at is distinct from b
   or (new.checkout_status is distinct from 'pending_payment' and new.checkout_status is distinct from 'paid') or new.replaces_stripe_subscription_id is distinct from src->>'replacement_id'
   or new.replacement_policy is distinct from(case when src->>'replacement_id' is null then null else 'immediate_cancel' end) then raise exception 'enterprise_trace_incomplete';end if;
 end if;return new;
end $$;

create or replace function public.enterprise_existing_pending_pool_guard()
returns trigger language plpgsql security invoker set search_path=pg_catalog as $$
declare a public.membership_agreements;
begin
 if TG_OP='DELETE' then if old.agreement_id is not null then raise exception 'enterprise_binding_immutable';end if;return old;end if;
 if TG_OP='UPDATE' then
  if new.agreement_id is distinct from old.agreement_id then raise exception 'enterprise_binding_pool_link_immutable';end if;
  if old.agreement_id is not null and old.stripe_checkout_session_id is not null and new.stripe_checkout_session_id is distinct from old.stripe_checkout_session_id then raise exception 'enterprise_trace_session_immutable';end if;
  if new.agreement_id is null then return new;end if;
 elsif new.agreement_id is null then return new;end if;
 if current_user<>'service_role' or new.offer_snapshot is null
  or(TG_OP='INSERT' and new.stripe_checkout_session_id is not null)
  or(new.stripe_checkout_session_id is not null and new.stripe_checkout_session_id !~ '^cs_[A-Za-z0-9_]+$') then raise exception 'enterprise_binding_pending_only';end if;
 if TG_OP='UPDATE' and old.status='paid' and(new.status,new.paid_at,new.stripe_payment_intent_id)
  is distinct from(old.status,old.paid_at,old.stripe_payment_intent_id) then raise exception 'enterprise_payment_immutable';end if;
 if new.status='pending' then
  if new.paid_at is not null or new.stripe_payment_intent_id is not null then raise exception 'enterprise_binding_pending_only';end if;
 else
  select * into a from public.membership_agreements where id=new.agreement_id;
  if TG_OP<>'UPDATE' or not public.enterprise_existing_paid_pool_valid(a,new) then raise exception 'enterprise_payment_pool_denied';end if;
  if old.status is distinct from 'paid' then
   if old.status is distinct from 'pending' or old.paid_at is not null or old.stripe_payment_intent_id is not null
    then raise exception 'enterprise_payment_first_denied';end if;
   perform public.enterprise_existing_payment_current(a);
  end if;
 end if;return new;
end $$;

create or replace function public.enterprise_existing_pending_pair_guard()
returns trigger language plpgsql security invoker set search_path=pg_catalog as $$
declare aid uuid;a public.membership_agreements;p public.client_interview_pools;
begin
 if TG_TABLE_NAME='membership_agreements' then aid:=new.id;else aid:=new.agreement_id;end if;
 if aid is null then return null;end if;
 select * into a from public.membership_agreements where id=aid;select * into p from public.client_interview_pools where agreement_id=aid;
 if a.enterprise_checkout_source is null and a.enterprise_checkout_pool_id is null and p.agreement_id is null then return null;end if;
 if a.id is null or p.id is null or a.enterprise_checkout_pool_id is distinct from p.id or a.enterprise_checkout_source->>'pool_id' is distinct from p.id::text
  or a.client_id is distinct from p.client_id or p.offer_snapshot is distinct from a.template_snapshot->'values'->'pool_offer_snapshot'
  or p.offer_digest is distinct from a.template_snapshot->'values'->>'pool_offer_digest' or a.checkout_session_id is distinct from p.stripe_checkout_session_id
  then raise exception 'enterprise_binding_pair_denied';end if;
 if a.checkout_paid_at is not null or a.checkout_status='paid' or p.paid_at is not null or p.status='paid' or p.stripe_payment_intent_id is not null then
  if not public.enterprise_existing_paid_pool_valid(a,p) then raise exception 'enterprise_payment_pair_denied';end if;
 end if;
 if TG_OP='UPDATE' then
  if TG_TABLE_NAME='membership_agreements' then
   if old.checkout_status='pending_payment' and new.checkout_status='paid' then
    perform public.read_enterprise_existing_billing(a.id);
   end if;
  elsif old.status='pending' and new.status='paid' then
   perform public.read_enterprise_existing_billing(a.id);
  end if;
 end if;return null;
end $$;

create or replace function public.enterprise_pool_v2_guard_pool()
returns trigger language plpgsql security invoker set search_path=pg_catalog as $$
declare a public.membership_agreements;
begin
 if TG_OP='DELETE' then if old.offer_snapshot is not null then raise exception 'enterprise_pool_v2_immutable';end if;return old;end if;
 if TG_OP='UPDATE' then
  if old.offer_snapshot is null and(new.offer_snapshot is not null or new.offer_digest is not null) then raise exception 'enterprise_pool_v2_backfill_denied';end if;
  if old.offer_snapshot is not null and
   (new.id,new.client_id,new.quantity_purchased,new.unit_price_cents,new.discount_pct,new.total_cents,new.offer_snapshot,new.offer_digest,new.created_at)
    is distinct from(old.id,old.client_id,old.quantity_purchased,old.unit_price_cents,old.discount_pct,old.total_cents,old.offer_snapshot,old.offer_digest,old.created_at)
   then raise exception 'enterprise_pool_v2_immutable';end if;
 end if;
 if new.offer_snapshot is not null then
  if current_user in('anon','authenticated') then raise exception 'enterprise_pool_v2_server_only';end if;
  if TG_OP='INSERT' and(new.status<>'pending' or new.paid_at is not null or new.stripe_payment_intent_id is not null) then raise exception 'enterprise_pool_v2_pending_required';end if;
  if new.status in('paid','refunded') or new.paid_at is not null then
   select * into a from public.membership_agreements where id=new.agreement_id;
   if current_user<>'service_role' or TG_OP<>'UPDATE' or not public.enterprise_existing_paid_pool_valid(a,new)
    then raise exception 'ENTERPRISE_POOL_V2_PAYMENT_PROOF_REQUIRED';end if;
  end if;
  if not exists(select 1 from public.clients where id=new.client_id) then raise exception 'enterprise_pool_v2_client_denied';end if;
 end if;return new;
end $$;

create or replace function public.enterprise_existing_billing_context(a public.membership_agreements)
returns void language plpgsql security invoker set search_path=pg_catalog as $$
declare c public.clients; p public.client_interview_pools; seal public.enterprise_v2_execution_seals; src jsonb;
begin
 if current_user<>'service_role' or a.id is null or a.status is distinct from 'signed' or a.is_current is distinct from true
  or a.superseded_at is not null or a.superseded_by_agreement_id is not null
  or a.checkout_attempt_source is not null or a.checkout_embedded is not null
  or not coalesce(public.enterprise_existing_funding_receipt_valid(a.enterprise_funding_receipt,a.enterprise_checkout_source,a.enterprise_checkout_prices),false)
  or exists(select 1 from public.public_purchase_intents where agreement_id=a.id)
  then raise exception 'enterprise_billing_source_denied';end if;
 select * into c from public.clients where id=a.client_id;
 select * into p from public.client_interview_pools where id=a.enterprise_checkout_pool_id;
 select * into seal from public.enterprise_v2_execution_seals where agreement_id=a.id;
 src:=a.enterprise_checkout_source;
 if c.id is null or p.id is null or seal.agreement_id is null
  or c.stripe_customer_id is distinct from a.enterprise_funding_receipt->'proof'->>'customer_id'
  or public.enterprise_existing_pending_material(to_jsonb(a),to_jsonb(c),to_jsonb(seal)) is distinct from src->'material'
  or src->>'pool_id' is distinct from p.id::text or p.client_id is distinct from c.id or p.agreement_id is distinct from a.id
  or not ((a.checkout_status='pending_payment' and a.checkout_paid_at is null and p.status='pending' and p.paid_at is null and p.stripe_payment_intent_id is null)
    or public.enterprise_existing_paid_pool_valid(a,p))
  or p.stripe_checkout_session_id is distinct from a.checkout_session_id
  or a.enterprise_funding_receipt->'proof'->>'checkout_session_id' is distinct from a.checkout_session_id
  or p.offer_snapshot is distinct from a.template_snapshot->'values'->'pool_offer_snapshot'
  or p.offer_digest is distinct from a.template_snapshot->'values'->>'pool_offer_digest'
  or a.replaces_stripe_subscription_id is distinct from src->>'replacement_id'
  or a.replacement_policy is distinct from(case when src->>'replacement_id' is null then null else 'immediate_cancel' end)
  or (select count(*) from public.billing_customers where stripe_customer_id=c.stripe_customer_id)<>1
  or not exists(select 1 from public.billing_customers where stripe_customer_id=c.stripe_customer_id and client_id=c.id)
  or a.checkout_created_at is distinct from(src->>'created_at')::timestamptz
  or(src->>'expires_at')::timestamptz is distinct from public.enterprise_existing_pending_expiry(a.checkout_created_at,a.agreement_expires_at)
  or(a.enterprise_funding_receipt->'proof'->>'payment_success_at')::timestamptz>clock_timestamp()
  then raise exception 'enterprise_billing_binding_denied';end if;
 if a.template_snapshot->'values'->>'term_start_basis'='agreement_date' then
  if a.initial_term_start is null or a.initial_renewal_date is null
   or to_char(a.initial_term_start,'YYYY-MM-DD') is distinct from a.template_snapshot->'values'->>'initial_term_start'
   or to_char(a.initial_renewal_date,'YYYY-MM-DD') is distinct from a.template_snapshot->'values'->>'initial_renewal_date'
   then raise exception 'enterprise_billing_term_denied';end if;
 elsif a.template_snapshot->'values'->>'term_start_basis'='successful_payment' then
  if a.initial_term_start is not null or a.initial_renewal_date is not null then raise exception 'enterprise_billing_term_denied';end if;
 else raise exception 'enterprise_billing_term_denied';end if;
end $$;

create function public.complete_enterprise_existing_payment(p_agreement uuid,p_client uuid,p_billing jsonb)
returns jsonb language plpgsql security invoker set search_path=pg_catalog set lock_timeout='10s' as $$
declare c public.clients; a public.membership_agreements; p public.client_interview_pools; owner_id uuid; w jsonb; cash_a timestamptz;
begin
 if current_user<>'service_role' then raise exception 'enterprise_payment_server_only';end if;
 select * into c from public.clients where id=p_client for update;
 if not found then raise exception 'enterprise_payment_client_denied';end if;
 select * into a from public.membership_agreements where id=p_agreement for update;
 if not found or a.client_id is distinct from c.id or a.enterprise_billing_receipt is null
  or a.enterprise_billing_receipt is distinct from p_billing then raise exception 'enterprise_payment_receipt_denied';end if;
 select * into p from public.client_interview_pools where id=a.enterprise_checkout_pool_id for update;
 if not found then raise exception 'enterprise_payment_pool_denied';end if;
 select id into owner_id from public.billing_customers where stripe_customer_id=c.stripe_customer_id for share;
 if not found then raise exception 'enterprise_payment_owner_denied';end if;
 w:=public.read_enterprise_existing_billing(a.id);
 if w is null or w is distinct from p_billing then raise exception 'enterprise_payment_receipt_denied';end if;
 if public.enterprise_existing_paid_pool_valid(a,p) then return w;end if;
 if a.checkout_status is distinct from 'pending_payment' or a.checkout_paid_at is not null or p.status is distinct from 'pending'
  or p.paid_at is not null or p.stripe_payment_intent_id is not null then raise exception 'enterprise_payment_phase_denied';end if;
 cash_a:=(w->'funding_receipt'->'proof'->>'payment_success_at')::timestamptz;
 update public.membership_agreements set checkout_status='paid',checkout_paid_at=cash_a where id=a.id;
 update public.client_interview_pools set status='paid',paid_at=cash_a,
  stripe_payment_intent_id=w->'funding_receipt'->'proof'->>'payment_intent_id' where id=p.id;
 select * into a from public.membership_agreements where id=p_agreement;
 select * into p from public.client_interview_pools where id=a.enterprise_checkout_pool_id;
 if not public.enterprise_existing_paid_pool_valid(a,p) then raise exception 'enterprise_payment_pair_denied';end if;
 return w;
end $$;
revoke all on function public.enterprise_existing_paid_agreement_valid(public.membership_agreements),
 public.enterprise_existing_paid_pool_valid(public.membership_agreements,public.client_interview_pools),
 public.enterprise_existing_payment_current(public.membership_agreements),public.complete_enterprise_existing_payment(uuid,uuid,jsonb),
 public.enterprise_existing_pending_agreement_guard(),public.enterprise_existing_pending_pool_guard(),public.enterprise_existing_pending_pair_guard(),
 public.enterprise_pool_v2_guard_pool(),public.enterprise_existing_billing_context(public.membership_agreements) from public,anon,authenticated;
grant execute on function public.enterprise_existing_paid_agreement_valid(public.membership_agreements),
 public.enterprise_existing_paid_pool_valid(public.membership_agreements,public.client_interview_pools),
 public.enterprise_existing_payment_current(public.membership_agreements),public.complete_enterprise_existing_payment(uuid,uuid,jsonb),
 public.enterprise_existing_pending_agreement_guard(),public.enterprise_existing_pending_pool_guard(),public.enterprise_existing_pending_pair_guard(),
 public.enterprise_pool_v2_guard_pool(),public.enterprise_existing_billing_context(public.membership_agreements) to service_role;
commit;

