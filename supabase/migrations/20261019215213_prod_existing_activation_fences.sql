-- Production-specific adapter of existing activation fences. Exact-source review required.
-- Preserve old accepted agreements/status/amounts/links. Never run as a blanket migration push.
begin;

set local lock_timeout='10s';
-- Snapshot original rows inside the same transaction; never export row data.
lock table public.public_purchase_intents, public.membership_agreements in share row exclusive mode;
create temporary table prod_activation_before on commit drop as
select id,to_jsonb(i)-'updated_at' as snapshot from public.public_purchase_intents i;
create temporary table prod_agreements_before on commit drop as select id,to_jsonb(a) as snapshot from public.membership_agreements a;
do $$ begin
 if (select jsonb_object_agg(status,n) from(select status,count(*) n from public.public_purchase_intents group by status)s)
   is distinct from '{"completed":1,"pending":3,"agreement_pending":1,"canceled":1}'::jsonb
   or (select count(*) from public.membership_agreements)<>3
   or exists(select 1 from public.public_purchase_intents where activation_claimed_at is not null)
   or exists(select 1 from information_schema.columns where table_schema='public' and table_name='public_purchase_intents' and column_name in('protocol','billing_applied_at','billing_apply_digest'))
 then raise exception 'prod_activation_baseline_drift';end if;
end $$;

alter table public.public_purchase_intents
  add column protocol text,
  add column billing_applied_at timestamptz,
  add column billing_apply_digest text;

do $$
declare
  v_completed_before bigint;
  v_completed_updated bigint;
begin
  select count(*) into v_completed_before
  from public.public_purchase_intents where status = 'completed';
  if v_completed_before <> 1 then
    raise exception 'prod_legacy_completed_count_changed: %', v_completed_before;
  end if;
  update public.public_purchase_intents
  set protocol = 'legacy_complete'
  where status = 'completed';
  get diagnostics v_completed_updated = row_count;
  if v_completed_updated <> v_completed_before then
    raise exception 'prod_legacy_completed_update_mismatch: % / %',
      v_completed_updated, v_completed_before;
  end if;
  update public.public_purchase_intents
  set protocol = 'fenced_v2'
  where protocol is null;
end;
$$;

alter table public.public_purchase_intents
  alter column protocol set default 'fenced_v2',
  alter column protocol set not null;

alter table public.public_purchase_intents
  add constraint public_purchase_intents_activation_protocol_check
  check (protocol in ('legacy_complete', 'fenced_v2')),
  add constraint public_purchase_intents_billing_digest_check
  check (
    (billing_applied_at is null and billing_apply_digest is null)
    or (billing_applied_at is not null and billing_apply_digest ~ '^[a-f0-9]{64}$')
  );

-- Claim freshness must be sampled after waiting for the intent lock. An old
-- pre-lock clock can otherwise steal a lease refreshed during the wait.
create or replace function public.claim_public_purchase_activation(
  p_agreement_id uuid, p_claim_key text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_intent public.public_purchase_intents%rowtype;
  v_agreement public.membership_agreements%rowtype;
  v_now timestamptz;
begin
  perform set_config('lock_timeout', '10s', true);
  if p_claim_key is null or length(p_claim_key) < 32 then
    raise exception using errcode = '22023', message = 'invalid_activation_fence';
  end if;
  select * into v_intent from public.public_purchase_intents
  where agreement_id = p_agreement_id for update;
  if not found then
    return jsonb_build_object('status', 'purchase_intent_missing');
  end if;
  v_now := clock_timestamp();
  select * into v_agreement from public.membership_agreements
  where id = p_agreement_id for update;
  if not found or v_agreement.superseded_by_agreement_id is not null
    or v_agreement.status in ('superseded', 'voided') then
    return jsonb_build_object('status', 'agreement_superseded', 'intent_id', v_intent.id);
  end if;
  if v_intent.status = 'canceled' or v_intent.canceled_at is not null then
    return jsonb_build_object('status', 'purchase_canceled', 'intent_id', v_intent.id);
  end if;
  if v_intent.protocol = 'legacy_complete' then
    return jsonb_build_object('status', 'historical_complete', 'intent_id', v_intent.id);
  end if;
  if v_intent.activation_claimed_at is not null
    and v_intent.activation_claimed_at >= v_now - interval '5 minutes' then
    return jsonb_build_object('status', 'activation_in_progress', 'intent_id', v_intent.id);
  end if;
  update public.public_purchase_intents
  set activation_claimed_at = v_now, activation_claim_key = p_claim_key,
      updated_at = v_now
  where id = v_intent.id and protocol = 'fenced_v2';
  return jsonb_build_object('status', 'claimed', 'intent_id', v_intent.id);
end;
$$;

revoke all on function public.claim_public_purchase_activation(uuid, text)
  from public, anon, authenticated;
grant execute on function public.claim_public_purchase_activation(uuid, text)
  to service_role;

-- Preserve the existing completion contract while making the shared-client
-- lock order intent -> agreement -> client explicit. The prior version read
-- the existing client without a row lock.
create or replace function public.complete_public_purchase_activation(
  p_agreement_id uuid,
  p_claim_key text,
  p_paid_at timestamptz,
  p_checkout_session_id text,
  p_client_id uuid,
  p_create_client boolean,
  p_plan_key text,
  p_billing_interval text,
  p_term_start date,
  p_renewal_date date
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_intent public.public_purchase_intents%rowtype;
  v_agreement public.membership_agreements%rowtype;
  v_client_id uuid;
  v_client_email text;
  v_now timestamptz;
begin
  perform set_config('lock_timeout', '10s', true);
  select * into v_intent from public.public_purchase_intents
  where agreement_id = p_agreement_id for update;
  if not found then
    return jsonb_build_object('status', 'no_intent');
  end if;
  v_now := clock_timestamp();
  select * into v_agreement from public.membership_agreements
  where id = p_agreement_id for update;
  if not found or v_agreement.superseded_by_agreement_id is not null
    or v_agreement.status is distinct from 'signed'
    or v_agreement.is_current is not true
    or v_intent.agreement_id is distinct from p_agreement_id then
    return jsonb_build_object('status', 'agreement_superseded');
  end if;
  if v_intent.status = 'canceled' or v_intent.canceled_at is not null then
    return jsonb_build_object('status', 'purchase_canceled');
  end if;
  if v_intent.activation_claim_key is distinct from p_claim_key
    or v_intent.activation_claimed_at is null
    or v_intent.activation_claimed_at < v_now - interval '5 minutes' then
    return jsonb_build_object('status', 'activation_fence_lost');
  end if;
  if v_intent.protocol is distinct from 'fenced_v2' then
    return jsonb_build_object('status', 'billing_protocol_manual_review');
  end if;
  if p_paid_at is null or not isfinite(p_paid_at)
    or p_client_id is null or p_plan_key not in ('basic', 'pro')
    or p_billing_interval not in ('monthly', 'annual')
    or p_plan_key is distinct from v_intent.selected_plan_key
    or p_billing_interval is distinct from v_intent.selected_billing_cadence
    or coalesce(nullif(btrim(v_intent.stripe_checkout_session_id), ''),
      nullif(btrim(p_checkout_session_id), '')) is null
    or (nullif(btrim(v_intent.stripe_checkout_session_id), '') is not null
      and nullif(btrim(p_checkout_session_id), '') is not null
      and nullif(btrim(p_checkout_session_id), '') is distinct from
        nullif(btrim(v_intent.stripe_checkout_session_id), ''))
    or (nullif(btrim(v_agreement.checkout_session_id), '') is not null
      and nullif(btrim(v_agreement.checkout_session_id), '') is distinct from
        coalesce(nullif(btrim(v_intent.stripe_checkout_session_id), ''),
          nullif(btrim(p_checkout_session_id), ''))) then
    raise exception using errcode = '22023', message = 'invalid_activation_input';
  end if;

  if v_agreement.client_id is not null and v_intent.client_id is not null
    and v_agreement.client_id <> v_intent.client_id then
    raise exception using errcode = 'P0001', message = 'activation_client_mismatch';
  end if;
  v_client_id := coalesce(v_agreement.client_id, v_intent.client_id, p_client_id);
  if p_create_client and v_client_id = p_client_id then
    insert into public.clients (
      id, name, email, client_admin_name, plan_tier, billing_interval,
      billing_status, subscription_status, auto_renew
    ) values (
      v_client_id,
      coalesce(nullif(trim(v_intent.company_legal_name), ''),
        nullif(trim(v_agreement.client_legal_name), ''), 'alphaScreen client'),
      lower(coalesce(nullif(trim(v_intent.buyer_email), ''), trim(v_agreement.admin_email))),
      coalesce(nullif(trim(v_intent.buyer_first_name || ' ' || v_intent.buyer_last_name), ''),
        nullif(trim(v_agreement.primary_admin_name), '')),
      p_plan_key, p_billing_interval, 'inactive', 'incomplete', false
    ) on conflict (id) do nothing;
  end if;
  -- Locks the existing row, including after an INSERT conflict. A new row is
  -- already protected by this transaction; both paths use the same order.
  select email into v_client_email from public.clients
  where id = v_client_id for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'activation_client_missing';
  end if;
  if p_create_client and v_client_id = p_client_id
    and lower(v_client_email) <> lower(coalesce(nullif(trim(v_intent.buyer_email), ''), trim(v_agreement.admin_email))) then
    raise exception using errcode = 'P0001', message = 'activation_client_conflict';
  end if;

  update public.membership_agreements
  set client_id = v_client_id,
      checkout_status = 'paid',
      checkout_paid_at = coalesce(checkout_paid_at, p_paid_at),
      checkout_session_id = coalesce(checkout_session_id, nullif(p_checkout_session_id, '')),
      initial_term_start = case
        when checkout_paid_at is null and v_intent.term_start_basis = 'successful_payment'
        then p_term_start else initial_term_start end,
      initial_renewal_date = case
        when checkout_paid_at is null and v_intent.term_start_basis = 'successful_payment'
        then p_renewal_date else initial_renewal_date end,
      updated_at = v_now
  where id = p_agreement_id;

  update public.public_purchase_intents
  set client_id = v_client_id,
      status = 'completed',
      activated_at = coalesce(activated_at, v_agreement.checkout_paid_at, p_paid_at),
      stripe_checkout_session_id = coalesce(stripe_checkout_session_id, nullif(p_checkout_session_id, '')),
      updated_at = v_now
  where id = v_intent.id and activation_claim_key = p_claim_key;
  if not found then
    raise exception using errcode = 'P0001', message = 'activation_fence_lost';
  end if;
  return jsonb_build_object('status', 'completed', 'client_id', v_client_id,
    'paid_at', coalesce(v_agreement.checkout_paid_at, p_paid_at));
end;
$$;

revoke all on function public.complete_public_purchase_activation(
  uuid, text, timestamptz, text, uuid, boolean, text, text, date, date
) from public, anon, authenticated;
grant execute on function public.complete_public_purchase_activation(
  uuid, text, timestamptz, text, uuid, boolean, text, text, date, date
) to service_role;

create or replace function public.apply_public_purchase_billing(
  p_intent_id uuid,
  p_claim_key text,
  p_client_id uuid,
  p_billing_client_id uuid,
  p_stripe_customer_id text,
  p_stripe_subscription_id text,
  p_subscription_status text,
  p_billing_status text,
  p_billing_interval text,
  p_plan_tier text,
  p_current_term_end timestamptz,
  p_cancel_at_term_end boolean,
  p_auto_renew boolean,
  p_cancel_effective_at timestamptz,
  p_contract_start_at timestamptz,
  p_contract_end_at timestamptz,
  p_platform_fee numeric,
  p_per_role_fee numeric,
  p_included_interviews_per_role integer,
  p_additional_interview_fee numeric,
  p_max_interview_minutes integer,
  p_credit_selected boolean,
  p_credit_type text,
  p_credit_normal_role_fee_cents integer,
  p_credit_discounted_amount_cents integer,
  p_credit_discount_percent integer,
  p_credit_non_refundable boolean,
  p_credit_expires boolean
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_intent public.public_purchase_intents%rowtype;
  v_agreement public.membership_agreements%rowtype;
  v_client public.clients%rowtype;
  v_plan public.client_plan_settings%rowtype;
  v_credit public.client_role_credits%rowtype;
  v_credit_session text;
  v_credit_tuple jsonb;
  v_digest text;
  v_now timestamptz;
begin
  perform set_config('lock_timeout', '10s', true);

  select * into v_intent from public.public_purchase_intents
  where id = p_intent_id for update;
  if not found then
    return jsonb_build_object('status', 'intent_missing');
  end if;
  -- Evaluate lease freshness only after the row lock has been acquired.
  v_now := clock_timestamp();
  -- The protocol check is inside the writer, not only in its JS caller.
  if v_intent.protocol is distinct from 'fenced_v2' then
    return jsonb_build_object('status', 'billing_protocol_manual_review');
  end if;
  if v_intent.activation_claim_key is distinct from p_claim_key
    or v_intent.activation_claimed_at is null
    or v_intent.activation_claimed_at < v_now - interval '5 minutes' then
    return jsonb_build_object('status', 'activation_fence_lost');
  end if;
  if v_intent.status <> 'completed' or v_intent.canceled_at is not null
    or v_intent.agreement_id is null or v_intent.client_id is distinct from p_client_id then
    return jsonb_build_object('status', 'billing_intent_manual_review');
  end if;

  select * into v_agreement from public.membership_agreements
  where id = v_intent.agreement_id for update;
  if not found or v_agreement.client_id is distinct from p_client_id
    or v_agreement.checkout_status <> 'paid'
    or v_agreement.status not in ('signed', 'active')
    or v_agreement.is_current is not true
    or v_agreement.superseded_by_agreement_id is not null then
    return jsonb_build_object('status', 'billing_agreement_manual_review');
  end if;

  select * into v_client from public.clients
  where id = p_client_id for update;
  if not found or p_billing_client_id is distinct from p_client_id then
    return jsonb_build_object('status', 'billing_client_missing');
  end if;

  if p_plan_tier not in ('basic', 'pro')
    or p_billing_interval not in ('monthly', 'annual')
    or p_plan_tier is distinct from v_intent.selected_plan_key
    or p_billing_interval is distinct from v_intent.selected_billing_cadence
    or p_billing_status <> 'active'
    or p_subscription_status not in ('active', 'trialing')
    or p_stripe_customer_id is null or length(btrim(p_stripe_customer_id)) not between 3 and 255
    or p_stripe_subscription_id is null or length(btrim(p_stripe_subscription_id)) not between 3 and 255
    or p_stripe_customer_id is distinct from btrim(p_stripe_customer_id)
    or p_stripe_subscription_id is distinct from btrim(p_stripe_subscription_id)
    or p_cancel_at_term_end is null or p_auto_renew is null
    or p_contract_start_at is null or p_contract_end_at is null or p_current_term_end is null
    or not isfinite(p_contract_start_at) or not isfinite(p_contract_end_at)
    or not isfinite(p_current_term_end)
    or (p_cancel_effective_at is not null and not isfinite(p_cancel_effective_at))
    or p_contract_end_at <= p_contract_start_at
    or p_current_term_end <= p_contract_start_at
    or p_platform_fee is null or p_platform_fee < 0 or p_platform_fee > 1000000
    or p_per_role_fee is null or p_per_role_fee < 0 or p_per_role_fee > 1000000
    or p_additional_interview_fee is null or p_additional_interview_fee < 0 or p_additional_interview_fee > 1000000
    or p_included_interviews_per_role is null or p_included_interviews_per_role not between 0 and 100000
    or p_max_interview_minutes is null or p_max_interview_minutes not between 0 and 100000
    or p_credit_selected is null then
    raise exception using errcode = '22023', message = 'invalid_billing_payload';
  end if;
  if p_credit_selected is distinct from v_intent.first_role_prepay_selected then
    raise exception using errcode = '22023', message = 'credit_selection_mismatch';
  end if;
  if p_platform_fee is distinct from (v_intent.package_snapshot->>'platform_fee')::numeric
    or p_per_role_fee is distinct from (v_intent.package_snapshot->>'per_role_fee')::numeric
    or p_included_interviews_per_role is distinct from (v_intent.package_snapshot->>'included_interviews_per_role')::integer
    or p_additional_interview_fee is distinct from (v_intent.package_snapshot->>'additional_interview_fee')::numeric
    or p_max_interview_minutes is distinct from (v_intent.package_snapshot->>'max_interview_minutes')::integer then
    raise exception using errcode = '22023', message = 'package_snapshot_mismatch';
  end if;
  v_credit_session := nullif(btrim(v_intent.stripe_checkout_session_id), '');
  if p_credit_selected then
    if v_credit_session is null or p_credit_type <> 'first_role_prepay'
      or p_credit_normal_role_fee_cents is null or p_credit_normal_role_fee_cents not between 1 and 100000000
      or p_credit_discounted_amount_cents is null or p_credit_discounted_amount_cents not between 1 and 100000000
      or p_credit_discount_percent is null or p_credit_discount_percent not between 1 and 100
      or p_credit_non_refundable is null or p_credit_expires is null
      or p_credit_type is distinct from v_intent.first_role_prepay_credit_type
      or p_credit_normal_role_fee_cents is distinct from v_intent.first_role_normal_role_fee_cents
      or p_credit_discounted_amount_cents is distinct from v_intent.first_role_prepay_amount_cents
      or p_credit_discount_percent is distinct from v_intent.first_role_prepay_discount_percent
      or p_credit_selected is distinct from (v_intent.package_snapshot->'first_role_prepay'->>'selected')::boolean
      or p_credit_type is distinct from v_intent.package_snapshot->'first_role_prepay'->>'credit_type'
      or p_credit_normal_role_fee_cents is distinct from (v_intent.package_snapshot->'first_role_prepay'->>'normal_role_fee_cents')::integer
      or p_credit_discounted_amount_cents is distinct from (v_intent.package_snapshot->'first_role_prepay'->>'discounted_credit_amount_cents')::integer
      or p_credit_discount_percent is distinct from (v_intent.package_snapshot->'first_role_prepay'->>'discount_percent')::integer
      or p_credit_non_refundable is distinct from (v_intent.package_snapshot->'first_role_prepay'->>'non_refundable')::boolean
      or p_credit_expires is distinct from (v_intent.package_snapshot->'first_role_prepay'->>'expires')::boolean then
      raise exception using errcode = '22023', message = 'credit_payload_mismatch';
    end if;
    v_credit_tuple := jsonb_build_array(
      p_billing_client_id::text, p_client_id::text, p_intent_id::text,
      v_agreement.id::text, v_credit_session, p_credit_type, p_plan_tier,
      p_credit_normal_role_fee_cents, p_credit_discounted_amount_cents,
      p_credit_discount_percent, 'unused', p_credit_non_refundable, p_credit_expires
    );
  else
    if (v_intent.package_snapshot->'first_role_prepay'->>'selected')::boolean is distinct from false
      or p_credit_type is not null or p_credit_normal_role_fee_cents is not null
      or p_credit_discounted_amount_cents is not null or p_credit_discount_percent is not null
      or p_credit_non_refundable is not null or p_credit_expires is not null then
      raise exception using errcode = '22023', message = 'unexpected_credit_payload';
    end if;
    v_credit_tuple := to_jsonb('credit:none'::text);
  end if;

  v_digest := encode(extensions.digest(convert_to(jsonb_build_array(
    'fenced_v2', p_intent_id::text, p_client_id::text,
    p_stripe_customer_id, p_stripe_subscription_id, p_subscription_status,
    p_billing_status, p_billing_interval, p_plan_tier,
    to_char(p_current_term_end at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    p_cancel_at_term_end, p_auto_renew,
    to_char(p_cancel_effective_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    to_char(p_contract_start_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    to_char(p_contract_end_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    p_client_id::text, p_plan_tier, p_billing_interval,
    p_platform_fee::numeric(20,4), p_per_role_fee::numeric(20,4),
    p_included_interviews_per_role,
    p_additional_interview_fee::numeric(20,4), p_max_interview_minutes,
    v_credit_tuple
  )::text, 'UTF8'), 'sha256'), 'hex');

  if v_intent.billing_applied_at is not null then
    if v_intent.billing_apply_digest = v_digest then
      return jsonb_build_object('status', 'already_applied', 'digest', v_digest);
    end if;
    raise exception using errcode = 'P0001', message = 'billing_payload_conflict';
  end if;

  -- Only a first application inspects mutable client/plan/credit state. A
  -- matching replay is a true no-op even after its credit is later consumed.
  if v_client.plan_tier is not null and v_client.plan_tier is distinct from p_plan_tier
    or v_client.billing_interval is not null and v_client.billing_interval is distinct from p_billing_interval then
    raise exception using errcode = 'P0001', message = 'existing_client_plan_conflict';
  end if;
  if v_client.stripe_customer_id is not null and v_client.stripe_customer_id is distinct from p_stripe_customer_id
    or v_client.stripe_subscription_id is not null and v_client.stripe_subscription_id is distinct from p_stripe_subscription_id then
    raise exception using errcode = 'P0001', message = 'billing_identity_conflict';
  end if;

  select * into v_plan from public.client_plan_settings
  where client_id = p_client_id for update;
  if found and (v_plan.plan_tier is distinct from p_plan_tier
    or v_plan.billing_interval is distinct from p_billing_interval) then
    raise exception using errcode = 'P0001', message = 'existing_plan_conflict';
  end if;

  if p_credit_selected then
    select * into v_credit from public.client_role_credits
    where source_public_purchase_intent_id = p_intent_id for update;
    if v_credit.id is not null then
      if jsonb_build_array(
        v_credit.billing_client_id::text, v_credit.source_client_id::text,
        v_credit.source_public_purchase_intent_id::text,
        v_credit.source_membership_agreement_id::text,
        v_credit.source_stripe_checkout_session_id, v_credit.credit_type,
        v_credit.membership_key, v_credit.normal_role_fee_cents,
        v_credit.discounted_credit_amount_cents, v_credit.discount_percent,
        v_credit.status, v_credit.metadata->'non_refundable',
        v_credit.metadata->'expires'
      ) is distinct from v_credit_tuple then
        raise exception using errcode = 'P0001', message = 'existing_credit_conflict';
      end if;
    else
      perform 1 from public.client_role_credits
      where source_stripe_checkout_session_id = v_credit_session for update;
      if found then
        raise exception using errcode = 'P0001', message = 'credit_checkout_session_conflict';
      end if;
    end if;
  end if;

  update public.clients set
    stripe_customer_id = p_stripe_customer_id,
    stripe_subscription_id = p_stripe_subscription_id,
    subscription_status = p_subscription_status,
    billing_status = p_billing_status,
    billing_interval = p_billing_interval,
    plan_tier = p_plan_tier,
    current_term_end = p_current_term_end,
    cancel_at_term_end = p_cancel_at_term_end,
    auto_renew = p_auto_renew,
    cancel_effective_at = p_cancel_effective_at,
    contract_start_at = p_contract_start_at,
    contract_end_at = p_contract_end_at
  where id = p_client_id;

  insert into public.client_plan_settings (
    client_id, plan_tier, billing_interval, platform_fee,
    per_role_fee, included_interviews_per_role, additional_interview_fee,
    max_interview_minutes
  ) values (
    p_client_id, p_plan_tier, p_billing_interval, p_platform_fee,
    p_per_role_fee, p_included_interviews_per_role, p_additional_interview_fee,
    p_max_interview_minutes
  ) on conflict (client_id) do update set
    plan_tier = excluded.plan_tier,
    billing_interval = excluded.billing_interval,
    platform_fee = excluded.platform_fee,
    per_role_fee = excluded.per_role_fee,
    included_interviews_per_role = excluded.included_interviews_per_role,
    additional_interview_fee = excluded.additional_interview_fee,
    max_interview_minutes = excluded.max_interview_minutes,
    updated_at = v_now;

  if p_credit_selected and v_credit.id is null then
    insert into public.client_role_credits (
      billing_client_id, source_client_id, source_public_purchase_intent_id,
      source_membership_agreement_id, source_stripe_checkout_session_id,
      credit_type, membership_key, normal_role_fee_cents,
      discounted_credit_amount_cents, discount_percent, status, metadata
    ) values (
      p_billing_client_id, p_client_id, p_intent_id, v_agreement.id,
      v_credit_session, p_credit_type, p_plan_tier,
      p_credit_normal_role_fee_cents, p_credit_discounted_amount_cents,
      p_credit_discount_percent, 'unused', jsonb_build_object(
        'source', 'public_purchase_activation',
        'non_refundable', p_credit_non_refundable,
        'expires', p_credit_expires,
        'purchase_intent_id', p_intent_id,
        'membership_agreement_id', v_agreement.id
      )
    );
  end if;

  update public.public_purchase_intents
  set billing_applied_at = v_now, billing_apply_digest = v_digest,
      updated_at = v_now
  where id = p_intent_id and activation_claim_key = p_claim_key;
  if not found then
    raise exception using errcode = 'P0001', message = 'activation_fence_lost';
  end if;
  return jsonb_build_object('status', 'applied', 'digest', v_digest);
end;
$$;

revoke all on function public.apply_public_purchase_billing(
  uuid, text, uuid, uuid, text, text, text, text, text, text,
  timestamptz, boolean, boolean, timestamptz, timestamptz, timestamptz,
  numeric, numeric, integer, numeric, integer, boolean, text,
  integer, integer, integer, boolean, boolean
) from public, anon, authenticated;
grant execute on function public.apply_public_purchase_billing(
  uuid, text, uuid, uuid, text, text, text, text, text, text,
  timestamptz, boolean, boolean, timestamptz, timestamptz, timestamptz,
  numeric, numeric, integer, numeric, integer, boolean, text,
  integer, integer, integer, boolean, boolean
) to service_role;

create schema if not exists private_sales;
revoke all on schema private_sales from public, anon, authenticated;

-- All tail writers call this inside their own transaction. Row locks acquired
-- here remain held until that transaction commits. The order is intent,
-- agreement, client, plan; callers then lock member/ledger rows as needed.
create or replace function private_sales.locked_purchase_context(
  p_intent_id uuid, p_claim_key text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_intent public.public_purchase_intents%rowtype;
  v_agreement public.membership_agreements%rowtype;
  v_client public.clients%rowtype;
  v_plan public.client_plan_settings%rowtype;
  v_now timestamptz;
  v_email text;
begin
  perform set_config('lock_timeout', '10s', true);
  select * into v_intent from public.public_purchase_intents
  where id = p_intent_id for update;
  if not found then
    return jsonb_build_object('status', 'intent_missing');
  end if;
  v_now := clock_timestamp();
  if nullif(btrim(p_claim_key), '') is null
    or v_intent.activation_claim_key is distinct from p_claim_key
    or v_intent.activation_claimed_at is null
    or v_intent.activation_claimed_at < v_now - interval '5 minutes' then
    return jsonb_build_object('status', 'activation_fence_lost');
  end if;
  if v_intent.status is distinct from 'completed'
    or v_intent.canceled_at is not null
    or v_intent.agreement_id is null or v_intent.client_id is null
    or v_intent.protocol is distinct from 'fenced_v2' then
    return jsonb_build_object('status', 'purchase_tail_manual_review');
  end if;

  select * into v_agreement from public.membership_agreements
  where id = v_intent.agreement_id for update;
  if not found or v_agreement.client_id is distinct from v_intent.client_id
    or v_agreement.status is distinct from 'signed'
    or v_agreement.is_current is not true
    or v_agreement.superseded_by_agreement_id is not null
    or v_agreement.checkout_status is distinct from 'paid' then
    return jsonb_build_object('status', 'purchase_tail_agreement_manual_review');
  end if;

  select * into v_client from public.clients
  where id = v_intent.client_id for update;
  if not found or v_client.billing_status is distinct from 'active'
    or (v_client.subscription_status is not null
      and v_client.subscription_status not in ('active', 'trialing')) then
    return jsonb_build_object('status', 'purchase_tail_client_manual_review');
  end if;

  select * into v_plan from public.client_plan_settings
  where client_id = v_client.id for share;
  if not found then
    return jsonb_build_object('status', 'purchase_tail_plan_manual_review');
  end if;
  if v_intent.protocol = 'fenced_v2' and v_intent.billing_applied_at is null then
    return jsonb_build_object('status', 'billing_not_applied');
  end if;

  v_email := lower(btrim(v_intent.buyer_email));
  if nullif(v_email, '') is null
    or (nullif(btrim(v_agreement.admin_email), '') is not null
      and lower(btrim(v_agreement.admin_email)) is distinct from v_email) then
    return jsonb_build_object('status', 'purchase_tail_email_manual_review');
  end if;

  return jsonb_build_object(
    'status', 'ready', 'client_id', v_client.id,
    'agreement_id', v_agreement.id,
    'buyer_email', v_email, 'protocol', v_intent.protocol
  );
end;
$$;

revoke all on function private_sales.locked_purchase_context(uuid, text)
  from public, anon, authenticated, service_role;

create or replace function public.ensure_public_purchase_buyer_member(
  p_intent_id uuid, p_claim_key text, p_user_id uuid, p_name text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_context jsonb;
  v_client_id uuid;
  v_email text;
  v_row public.client_members%rowtype;
  v_matches integer := 0;
  v_name text := nullif(btrim(p_name), '');
  v_update_name text;
  v_update_email text;
  v_role text;
begin
  if p_user_id is null then
    return jsonb_build_object('status', 'member_user_missing');
  end if;
  v_context := private_sales.locked_purchase_context(p_intent_id, p_claim_key);
  if v_context->>'status' <> 'ready' then
    return v_context;
  end if;
  v_client_id := (v_context->>'client_id')::uuid;
  v_email := v_context->>'buyer_email';

  -- Lock every identity candidate, in a stable order. There is deliberately
  -- no LIMIT, SKIP LOCKED, or email-based unique-index assumption.
  for v_row in
    select * from public.client_members
    where client_id = v_client_id
      and (user_id = p_user_id or lower(btrim(email)) = v_email)
    order by client_id, user_id for update
  loop
    v_matches := v_matches + 1;
    if v_matches > 1 then
      return jsonb_build_object('status', 'member_identity_conflict');
    end if;
  end loop;

  if v_matches = 0 then
    begin
      insert into public.client_members (client_id, user_id, email, name, role)
      values (v_client_id, p_user_id, v_email, v_name, 'manager');
      return jsonb_build_object('status', 'created', 'role', 'manager');
    exception when unique_violation then
      -- A non-RPC writer raced us. Validate the exact PK before adopting it.
      select * into v_row from public.client_members
      where client_id = v_client_id and user_id = p_user_id for update;
      if not found then
        return jsonb_build_object('status', 'member_identity_conflict');
      end if;
      v_matches := 1;
    end;
  end if;

  if v_row.user_id is distinct from p_user_id
    or (nullif(btrim(v_row.email), '') is not null
      and lower(btrim(v_row.email)) is distinct from v_email) then
    return jsonb_build_object('status', 'member_identity_conflict');
  end if;
  v_role := coalesce(nullif(lower(btrim(v_row.role)), ''), 'manager');
  v_update_name := case when nullif(btrim(v_row.name), '') is null then v_name else v_row.name end;
  v_update_email := case when nullif(btrim(v_row.email), '') is null then v_email else v_row.email end;
  if v_update_name is distinct from v_row.name
    or v_update_email is distinct from v_row.email
    or v_role is distinct from v_row.role then
    update public.client_members
    set name = v_update_name, email = v_update_email, role = v_role
    where client_id = v_client_id and user_id = p_user_id;
    return jsonb_build_object('status', 'updated', 'role', v_role);
  end if;
  return jsonb_build_object('status', 'existing', 'role', v_role);
end;
$$;

revoke all on function public.ensure_public_purchase_buyer_member(
  uuid, text, uuid, text
) from public, anon, authenticated;
grant execute on function public.ensure_public_purchase_buyer_member(
  uuid, text, uuid, text
) to service_role;

-- A provider timeout is not proof that SendGrid rejected the message. Keep
-- ambiguous sends in `sending` until an operator reconciles them; never
-- convert them into an automatic retry.
alter table public.email_delivery_events
  add column welcome_send_token uuid,
  add column welcome_reconciled_at timestamptz,
  add column welcome_reconciled_by text,
  add column welcome_reconcile_reason text;

create or replace function public.reserve_public_purchase_welcome(
  p_intent_id uuid, p_claim_key text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_context jsonb;
  v_email text;
  v_key text;
  v_prefix text;
  v_row public.email_delivery_events%rowtype;
  v_count integer := 0;
begin
  v_context := private_sales.locked_purchase_context(p_intent_id, p_claim_key);
  if v_context->>'status' <> 'ready' then return v_context; end if;
  v_email := v_context->>'buyer_email';
  v_prefix := 'public_purchase_welcome:' || p_intent_id::text || ':';
  v_key := v_prefix || v_email;
  if length(v_key) > 240 then
    return jsonb_build_object('status', 'welcome_key_too_long');
  end if;

  -- The intent lock serializes this purchase's welcome writers. The prefix
  -- scan also refuses historical rows under a different recipient/key.
  for v_row in
    select * from public.email_delivery_events
    where sg_event_id like replace(replace(v_prefix, '%', '\%'), '_', '\_') || '%'
      escape '\'
    order by sg_event_id for update
  loop
    v_count := v_count + 1;
    if v_count > 1 or v_row.sg_event_id is distinct from v_key
      or lower(btrim(v_row.email)) is distinct from v_email then
      return jsonb_build_object('status', 'welcome_identity_conflict');
    end if;
  end loop;

  if v_count = 0 then
    insert into public.email_delivery_events (
      event_type, event_at, email, sg_event_id, category, email_category,
      custom_args, status, attempt, subject, raw_payload,
      is_problem, is_time_sensitive
    ) values (
      'outbound_public_purchase_welcome', clock_timestamp(), v_email, v_key,
      'public_purchase_welcome', 'public_purchase_welcome',
      jsonb_build_object('email_category', 'public_purchase_welcome',
        'client_id', v_context->>'client_id',
        'agreement_id', v_context->>'agreement_id',
        'purchase_intent_id', p_intent_id::text),
      'reserved', 0, 'Welcome to alphaScreen',
      jsonb_build_object('source', 'public_purchase_activation',
        'client_id', v_context->>'client_id',
        'agreement_id', v_context->>'agreement_id',
        'purchase_intent_id', p_intent_id::text),
      false, false
    );
    return jsonb_build_object('status', 'reserved', 'ledger_key', v_key);
  end if;

  if v_row.status in ('sent', 'skipped', 'manual_suppressed', 'sending') then
    return jsonb_build_object('status', v_row.status, 'ledger_key', v_key);
  end if;
  if v_row.status in ('reserved', 'send_rejected') then
    update public.email_delivery_events
    set status = 'reserved', response = null, is_problem = false,
        event_at = clock_timestamp()
    where id = v_row.id;
    return jsonb_build_object('status', 'reserved', 'ledger_key', v_key);
  end if;
  -- Unknown historical status is not evidence of a safe retry.
  return jsonb_build_object('status', 'welcome_manual_review', 'ledger_key', v_key);
end;
$$;

revoke all on function public.reserve_public_purchase_welcome(uuid, text)
  from public, anon, authenticated;
grant execute on function public.reserve_public_purchase_welcome(uuid, text)
  to service_role;

create or replace function public.begin_public_purchase_welcome(
  p_intent_id uuid, p_claim_key text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_context jsonb;
  v_key text;
  v_row public.email_delivery_events%rowtype;
  v_token uuid;
begin
  v_context := private_sales.locked_purchase_context(p_intent_id, p_claim_key);
  if v_context->>'status' <> 'ready' then return v_context; end if;
  v_key := 'public_purchase_welcome:' || p_intent_id::text || ':' ||
    (v_context->>'buyer_email');
  select * into v_row from public.email_delivery_events
  where sg_event_id = v_key for update;
  if not found or v_row.status is distinct from 'reserved' then
    return jsonb_build_object('status', 'welcome_not_reserved');
  end if;
  v_token := extensions.gen_random_uuid();
  update public.email_delivery_events
  set status = 'sending', welcome_send_token = v_token,
      attempt = coalesce(attempt, 0) + 1, event_at = clock_timestamp()
  where id = v_row.id;
  return jsonb_build_object('status', 'sending', 'send_token', v_token,
    'ledger_key', v_key, 'buyer_email', v_context->>'buyer_email',
    'client_id', v_context->>'client_id',
    'agreement_id', v_context->>'agreement_id');
end;
$$;

revoke all on function public.begin_public_purchase_welcome(uuid, text)
  from public, anon, authenticated;
grant execute on function public.begin_public_purchase_welcome(uuid, text)
  to service_role;

create or replace function public.finish_public_purchase_welcome(
  p_intent_id uuid, p_send_token uuid, p_result text, p_response text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_key_prefix text := 'public_purchase_welcome:' || p_intent_id::text || ':';
  v_row public.email_delivery_events%rowtype;
begin
  -- No lease check here: a provider 202 remains evidence of acceptance even
  -- if the activation claim expires before the response is persisted.
  select * into v_row from public.email_delivery_events
  where welcome_send_token = p_send_token
    and sg_event_id like replace(replace(v_key_prefix, '%', '\%'), '_', '\_') || '%'
      escape '\'
  for update;
  if not found or v_row.status is distinct from 'sending' then
    return jsonb_build_object('status', 'welcome_token_mismatch');
  end if;
  if p_result not in ('sent', 'skipped', 'send_rejected') then
    return jsonb_build_object('status', 'welcome_result_invalid');
  end if;
  update public.email_delivery_events
  set status = p_result, response = left(p_response, 500),
      is_problem = p_result = 'send_rejected', event_at = clock_timestamp()
  where id = v_row.id;
  return jsonb_build_object('status', p_result);
end;
$$;

revoke all on function public.finish_public_purchase_welcome(uuid, uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.finish_public_purchase_welcome(uuid, uuid, text, text)
  to service_role;

-- Deliberately outside the exposed public API schema and unavailable to the
-- backend service role. An operator must use privileged SQL with a recorded
-- actor and evidence-based reason.
create or replace function private_sales.reconcile_public_purchase_welcome(
  p_intent_id uuid, p_actor text, p_reason text, p_resolution text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.email_delivery_events%rowtype;
  v_count integer := 0;
begin
  if length(btrim(coalesce(p_actor, ''))) < 3
    or length(btrim(coalesce(p_reason, ''))) < 10
    or p_resolution not in ('sent', 'manual_suppressed') then
    return jsonb_build_object('status', 'invalid_reconciliation');
  end if;
  perform 1 from public.public_purchase_intents where id = p_intent_id for update;
  if not found then return jsonb_build_object('status', 'intent_missing'); end if;
  for v_row in
    select * from public.email_delivery_events
    where sg_event_id like 'public\_purchase\_welcome:' || p_intent_id::text || ':%'
      escape '\'
    order by sg_event_id for update
  loop
    v_count := v_count + 1;
  end loop;
  if v_count <> 1 or v_row.status is distinct from 'sending' then
    return jsonb_build_object('status', 'welcome_not_ambiguous');
  end if;
  update public.email_delivery_events
  set status = p_resolution, welcome_reconciled_at = clock_timestamp(),
      welcome_reconciled_by = left(btrim(p_actor), 120),
      welcome_reconcile_reason = left(btrim(p_reason), 1000),
      response = 'manual_reconciliation',
      is_problem = p_resolution = 'manual_suppressed'
  where id = v_row.id;
  return jsonb_build_object('status', p_resolution);
end;
$$;

revoke all on function private_sales.reconcile_public_purchase_welcome(uuid, text, text, text)
  from public, anon, authenticated, service_role;

do $$ begin
 if exists(select 1 from prod_activation_before b full join public.public_purchase_intents i using(id)
   where b.id is null or i.id is null or b.snapshot is distinct from to_jsonb(i)-'updated_at'-'protocol'-'billing_applied_at'-'billing_apply_digest')
   or exists(select 1 from prod_agreements_before b full join public.membership_agreements a using(id)
     where b.id is null or a.id is null or b.snapshot is distinct from to_jsonb(a))
   or exists(select 1 from public.public_purchase_intents where protocol is distinct from case when status='completed' then 'legacy_complete' else 'fenced_v2' end or billing_applied_at is not null or billing_apply_digest is not null)
 then raise exception 'prod_activation_preservation_failed';end if;
end $$;

commit;
