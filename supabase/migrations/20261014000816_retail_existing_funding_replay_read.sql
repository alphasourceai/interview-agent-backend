-- LOCAL unmounted read/retry boundary. Reuse existing rows/source/locks; no
-- enrollment, paid/access/credit/Auth changes, table grants or provider work.
begin;
set local lock_timeout='10s';
do $baseline$
declare s text[];p record;
begin
 if to_regprocedure('public.read_retail_existing_funding(uuid,uuid,text,jsonb)') is not null then
  raise exception 'retail_funding_replay_schema_drift';end if;
 foreach s slice 1 in array array[
  array['retail_existing_funding_schema_guard()','abfab9e6f97d88c8aa940b8a993db42b','s'],
  array['retail_existing_funding_context(public.membership_agreements,text)','71551667938edd71dd8d735eff10078b','v'],
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
   then raise exception 'retail_funding_replay_prerequisite_drift';end if;
 end loop;
 perform public.retail_existing_funding_schema_guard();
end $baseline$;

create function public.read_retail_existing_funding(p_agreement uuid,p_client uuid,p_claim text,p_source jsonb)
returns jsonb language plpgsql volatile security invoker set search_path=pg_catalog set lock_timeout='10s' as $$
declare a public.membership_agreements;i public.public_purchase_intents;c public.clients;
 w jsonb;m jsonb;had_intent boolean;phase text;paid timestamptz;clock timestamptz;
begin
 if current_user<>'service_role' then raise exception 'retail_funding_server_only';end if;
 perform public.retail_existing_funding_schema_guard();
 begin select * into strict i from public.public_purchase_intents where agreement_id=p_agreement for share;had_intent:=true;
 exception when no_data_found then had_intent:=false;when too_many_rows then raise exception 'retail_funding_intent_ambiguous';end;
 select * into a from public.membership_agreements where id=p_agreement for share;
 if not found or a.client_id is distinct from p_client or a.checkout_attempt_source is distinct from p_source
  then raise exception 'retail_funding_source_denied';end if;
 select * into c from public.clients where id=p_client for share;
 perform 1 from public.billing_customers where stripe_customer_id=a.checkout_attempt_source->>'customer_id' order by id for share;
 perform public.retail_existing_funding_schema_guard();
 clock:=clock_timestamp();w:=a.retail_funding_receipt;
 if w is null or not coalesce(public.retail_existing_funding_receipt_valid(w,p_source),false)
  or w->'proof'->'period'->>'checkout_session_id' is distinct from a.checkout_session_id
  or (w->>'recorded_at')::timestamptz>clock
  then raise exception 'retail_funding_receipt_unavailable';end if;
 paid:=(w->'proof'->'period'->>'paid_at')::timestamptz;
 if a.checkout_paid_at is null then
  phase:='pending';perform public.retail_existing_funding_context(a,p_claim);
 else
  phase:='paid';
  if a.status not in('signed','active') or a.status is null or a.is_current is distinct from true
   or a.superseded_by_agreement_id is not null or a.superseded_at is not null or a.voided_at is not null
   or a.checkout_status is distinct from 'paid' or a.checkout_paid_at is distinct from paid
   then raise exception 'retail_funding_paid_source_denied';end if;
  if had_intent and (i.client_id is distinct from a.client_id or i.status is distinct from 'completed'
   or i.protocol is distinct from 'fenced_v2' or i.canceled_at is not null or i.activated_at is distinct from paid
   or i.stripe_checkout_session_id is distinct from a.checkout_session_id
   or p_claim is null or length(p_claim)<32 or i.activation_claim_key is distinct from p_claim
   or i.activation_claimed_at is null or i.activation_claimed_at<clock-interval '5 minutes' or i.activation_claimed_at>clock)
   then raise exception 'retail_funding_claim_denied';end if;
  if not had_intent and p_claim is not null then raise exception 'retail_funding_admin_claim_denied';end if;
  if c.id is null or c.parent_client_id is not null or c.archived_at is not null
   or c.stripe_customer_id is distinct from p_source->>'customer_id'
   or (c.stripe_subscription_id is not null and c.stripe_subscription_id is distinct from w->'proof'->'period'->>'subscription_id'
    and c.stripe_subscription_id is distinct from a.replaces_stripe_subscription_id)
   or (select count(*) from public.billing_customers where stripe_customer_id=c.stripe_customer_id)<>1
   or not exists(select 1 from public.billing_customers where stripe_customer_id=c.stripe_customer_id and client_id=c.id)
   then raise exception 'retail_funding_customer_denied';end if;
  m:=public.retail_existing_checkout_material(to_jsonb(a),case when had_intent then to_jsonb(i) else null end,c.stripe_customer_id);
  if m is distinct from p_source-'config' or not coalesce(public.retail_existing_checkout_config_valid(p_source->'config'),false)
   or a.checkout_embedded is null or a.checkout_created_at is null or not isfinite(a.checkout_created_at)
   or a.checkout_created_at>clock then raise exception 'retail_funding_source_changed';end if;
 end if;
 return jsonb_build_object('version','retail_existing_funding_read_v1','phase',phase,'receipt',w);
end $$;
revoke all on function public.read_retail_existing_funding(uuid,uuid,text,jsonb) from public,anon,authenticated;
grant execute on function public.read_retail_existing_funding(uuid,uuid,text,jsonb) to service_role;
commit;
