create or replace function public.issue_retail_signup_email_verification(
  p_purchase_intent_id uuid,
  p_buyer_email text,
  p_plan_key text,
  p_billing_cadence text,
  p_code_hash text,
  p_code_salt text
)
returns table (
  status text,
  verification_id uuid,
  expires_at timestamptz,
  resend_after_seconds integer
)
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_now timestamptz := now();
  v_intent public.public_purchase_intents%rowtype;
  v_latest_sent_at timestamptz;
  v_oldest_hourly_sent_at timestamptz;
  v_sent_count integer;
  v_verification_id uuid;
  v_expires_at timestamptz;
begin
  select *
  into v_intent
  from public.public_purchase_intents
  where id = p_purchase_intent_id
  for update;

  if not found then
    return query select 'intent_not_found'::text, null::uuid, null::timestamptz, 0;
    return;
  end if;

  if lower(coalesce(v_intent.buyer_email, '')) <> lower(coalesce(p_buyer_email, ''))
    or v_intent.selected_plan_key <> p_plan_key
    or v_intent.selected_billing_cadence <> p_billing_cadence then
    return query select 'context_mismatch'::text, null::uuid, null::timestamptz, 0;
    return;
  end if;

  if v_intent.status <> 'pending'
    or (v_intent.expires_at is not null and v_intent.expires_at <= v_now) then
    return query select 'intent_not_eligible'::text, null::uuid, null::timestamptz, 0;
    return;
  end if;

  select count(*)::integer, min(sent_at)
  into v_sent_count, v_oldest_hourly_sent_at
  from public.retail_signup_email_verifications
  where purchase_intent_id = v_intent.id
    and buyer_email = lower(v_intent.buyer_email)
    and sent_at >= v_now - interval '1 hour';

  if v_sent_count >= 5 then
    return query select
      'hourly_limit'::text,
      null::uuid,
      null::timestamptz,
      greatest(1, ceil(extract(epoch from (v_oldest_hourly_sent_at + interval '1 hour' - v_now)))::integer);
    return;
  end if;

  select sent_at
  into v_latest_sent_at
  from public.retail_signup_email_verifications
  where purchase_intent_id = v_intent.id
    and buyer_email = lower(v_intent.buyer_email)
  order by sent_at desc
  limit 1;

  if v_latest_sent_at is not null and v_latest_sent_at > v_now - interval '60 seconds' then
    return query select
      'resend_cooldown'::text,
      null::uuid,
      null::timestamptz,
      greatest(1, ceil(extract(epoch from (v_latest_sent_at + interval '60 seconds' - v_now)))::integer);
    return;
  end if;

  update public.retail_signup_email_verifications
  set invalidated_at = v_now,
      invalidation_reason = 'resend',
      updated_at = v_now
  where purchase_intent_id = v_intent.id
    and buyer_email = lower(v_intent.buyer_email)
    and used_at is null
    and invalidated_at is null;

  v_verification_id := gen_random_uuid();
  v_expires_at := v_now + interval '10 minutes';

  insert into public.retail_signup_email_verifications (
    id,
    purchase_intent_id,
    buyer_email,
    plan_key,
    billing_cadence,
    code_hash,
    code_salt,
    expires_at,
    sent_at,
    created_at,
    updated_at
  ) values (
    v_verification_id,
    v_intent.id,
    lower(v_intent.buyer_email),
    v_intent.selected_plan_key,
    v_intent.selected_billing_cadence,
    p_code_hash,
    p_code_salt,
    v_expires_at,
    v_now,
    v_now,
    v_now
  );

  return query select 'issued'::text, v_verification_id, v_expires_at, 60;
end;
$$;

revoke all on function public.issue_retail_signup_email_verification(uuid, text, text, text, text, text) from public;
revoke all on function public.issue_retail_signup_email_verification(uuid, text, text, text, text, text) from anon;
revoke all on function public.issue_retail_signup_email_verification(uuid, text, text, text, text, text) from authenticated;
grant execute on function public.issue_retail_signup_email_verification(uuid, text, text, text, text, text) to service_role;
