begin;

-- Give delayed carrier delivery a fair chance to complete before a resend
-- invalidates the active code and creates a second message.
create or replace function private_auth.issue_retail_signup_sms_verification(
  p_verification_id uuid,
  p_purchase_intent_id uuid,
  p_destination_fingerprint text,
  p_plan_key text,
  p_billing_cadence text,
  p_pepper_version integer,
  p_verifier_hmac_hex text,
  p_sms_selection_at timestamptz,
  p_consent_copy_version text
)
returns table(status text, verification_id uuid, expires_at timestamptz, resend_after_seconds integer)
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_now timestamptz := statement_timestamp();
  v_intent public.public_purchase_intents%rowtype;
  v_latest_sent_at timestamptz;
  v_oldest_hourly_sent_at timestamptz;
  v_sent_count integer;
  v_expires_at timestamptz;
begin
  if p_verification_id is null
    or p_destination_fingerprint !~ '^[0-9a-f]{64}$'
    or p_verifier_hmac_hex !~ '^[0-9a-f]{64}$'
    or p_pepper_version not between 1 and 1000
    or p_sms_selection_at is null
    or p_sms_selection_at > v_now + interval '1 minute'
    or p_consent_copy_version <> 'sms-consent-v2'
  then
    return query select 'invalid_input'::text, null::uuid, null::timestamptz, 0;
    return;
  end if;

  select * into v_intent
  from public.public_purchase_intents
  where id = p_purchase_intent_id
  for update;

  if not found then
    return query select 'intent_not_found'::text, null::uuid, null::timestamptz, 0;
    return;
  end if;

  if v_intent.selected_plan_key <> p_plan_key
    or v_intent.selected_billing_cadence <> p_billing_cadence
    or coalesce(v_intent.buyer_phone, '') = ''
  then
    return query select 'context_mismatch'::text, null::uuid, null::timestamptz, 0;
    return;
  end if;

  if v_intent.status <> 'pending'
    or (v_intent.expires_at is not null and v_intent.expires_at <= v_now)
  then
    return query select 'intent_not_eligible'::text, null::uuid, null::timestamptz, 0;
    return;
  end if;

  select count(*)::integer, min(sent_at)
  into v_sent_count, v_oldest_hourly_sent_at
  from private_auth.retail_signup_sms_verifications
  where purchase_intent_id = v_intent.id
    and destination_fingerprint = p_destination_fingerprint
    and sent_at >= v_now - interval '1 hour';

  if v_sent_count >= 5 then
    return query select 'hourly_limit'::text, null::uuid, null::timestamptz,
      greatest(1, ceil(extract(epoch from (v_oldest_hourly_sent_at + interval '1 hour' - v_now)))::integer);
    return;
  end if;

  select sent_at into v_latest_sent_at
  from private_auth.retail_signup_sms_verifications
  where purchase_intent_id = v_intent.id
    and destination_fingerprint = p_destination_fingerprint
  order by sent_at desc
  limit 1;

  if v_latest_sent_at is not null and v_latest_sent_at > v_now - interval '120 seconds' then
    return query select 'resend_cooldown'::text, null::uuid, null::timestamptz,
      greatest(1, ceil(extract(epoch from (v_latest_sent_at + interval '120 seconds' - v_now)))::integer);
    return;
  end if;

  update private_auth.retail_signup_sms_verifications
  set invalidated_at = v_now,
      invalidation_reason = 'resend_or_channel_change',
      updated_at = v_now
  where purchase_intent_id = v_intent.id
    and used_at is null
    and invalidated_at is null;

  update public.retail_signup_email_verifications
  set invalidated_at = v_now,
      invalidation_reason = 'channel_changed_to_sms',
      updated_at = v_now
  where purchase_intent_id = v_intent.id
    and used_at is null
    and invalidated_at is null;

  v_expires_at := v_now + interval '10 minutes';
  insert into private_auth.retail_signup_sms_verifications (
    id, purchase_intent_id, destination_fingerprint, plan_key, billing_cadence,
    pepper_version, verifier_hmac_hex, expires_at, sent_at, sms_selection_at,
    consent_copy_version, created_at, updated_at
  ) values (
    p_verification_id, v_intent.id, p_destination_fingerprint, p_plan_key, p_billing_cadence,
    p_pepper_version, p_verifier_hmac_hex, v_expires_at, v_now, p_sms_selection_at,
    p_consent_copy_version, v_now, v_now
  );

  return query select 'issued'::text, p_verification_id, v_expires_at, 120;
end
$function$;

create or replace function private_auth.get_retail_signup_sms_verification(
  p_purchase_intent_id uuid,
  p_destination_fingerprint text
)
returns table(
  verification_id uuid,
  verifier_hmac_hex text,
  verified boolean,
  status text,
  expires_at timestamptz,
  sent_at timestamptz,
  resend_after_seconds integer
)
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_now timestamptz := statement_timestamp();
  v_intent public.public_purchase_intents%rowtype;
  v_latest private_auth.retail_signup_sms_verifications%rowtype;
  v_verified boolean := false;
  v_oldest_hourly_sent_at timestamptz;
  v_sent_count integer := 0;
  v_resend integer := 0;
begin
  select * into v_intent from public.public_purchase_intents where id = p_purchase_intent_id;
  if not found or p_destination_fingerprint !~ '^[0-9a-f]{64}$' then return; end if;

  v_verified := v_intent.phone_verified_at is not null
    and v_intent.phone_verified_destination_fingerprint = p_destination_fingerprint
    and v_intent.phone_verification_method = 'retail_signup_sms_otp_v1';

  select * into v_latest
  from private_auth.retail_signup_sms_verifications
  where purchase_intent_id = p_purchase_intent_id
    and destination_fingerprint = p_destination_fingerprint
  order by created_at desc
  limit 1;

  select count(*)::integer, min(v.sent_at)
  into v_sent_count, v_oldest_hourly_sent_at
  from private_auth.retail_signup_sms_verifications v
  where v.purchase_intent_id = p_purchase_intent_id
    and v.destination_fingerprint = p_destination_fingerprint
    and v.sent_at >= v_now - interval '1 hour';

  if v_latest.sent_at is not null then
    v_resend := greatest(v_resend, greatest(0, ceil(extract(epoch from (v_latest.sent_at + interval '120 seconds' - v_now)))::integer));
  end if;
  if v_sent_count >= 5 and v_oldest_hourly_sent_at is not null then
    v_resend := greatest(v_resend, greatest(0, ceil(extract(epoch from (v_oldest_hourly_sent_at + interval '1 hour' - v_now)))::integer));
  end if;

  return query select
    v_latest.id,
    v_latest.verifier_hmac_hex,
    v_verified,
    case
      when v_verified then 'verified'
      when v_latest.id is not null and v_latest.used_at is null and v_latest.invalidated_at is null and v_latest.expires_at > v_now then 'code_sent'
      else 'unverified'
    end,
    v_latest.expires_at,
    v_latest.sent_at,
    v_resend;
end
$function$;

commit;
