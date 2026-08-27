begin;

alter table public.public_purchase_intents
  add column if not exists phone_verified_at timestamptz,
  add column if not exists phone_verified_destination_fingerprint text,
  add column if not exists phone_verification_method text,
  add column if not exists phone_verification_version integer;

create table if not exists private_auth.retail_signup_sms_verifications (
  id uuid primary key,
  purchase_intent_id uuid not null references public.public_purchase_intents(id) on delete cascade,
  destination_fingerprint text not null check (destination_fingerprint ~ '^[0-9a-f]{64}$'),
  plan_key text not null check (plan_key in ('basic', 'pro')),
  billing_cadence text not null check (billing_cadence in ('monthly', 'annual')),
  pepper_version integer not null check (pepper_version between 1 and 1000),
  verifier_hmac_hex text not null check (verifier_hmac_hex ~ '^[0-9a-f]{64}$'),
  attempt_count integer not null default 0 check (attempt_count between 0 and 5),
  expires_at timestamptz not null,
  sent_at timestamptz not null default statement_timestamp(),
  sms_selection_at timestamptz not null,
  consent_copy_version text not null check (consent_copy_version = 'sms-consent-v2'),
  provider text null check (provider is null or provider ~ '^[a-z0-9_:-]{1,40}$'),
  provider_message_id text null check (provider_message_id is null or char_length(provider_message_id) between 1 and 255),
  delivery_status text null check (delivery_status is null or delivery_status in ('queued', 'sent', 'delivered', 'failed', 'undelivered', 'rejected')),
  failure_category text null check (failure_category is null or failure_category in ('provider_rejected', 'invalid_destination', 'blocked_destination', 'transient_preacceptance', 'ambiguous_outcome', 'misconfigured')),
  last_provider_event_id text null check (last_provider_event_id is null or char_length(last_provider_event_id) between 1 and 255),
  last_provider_event_at timestamptz,
  used_at timestamptz,
  invalidated_at timestamptz,
  invalidation_reason text,
  created_at timestamptz not null default statement_timestamp(),
  updated_at timestamptz not null default statement_timestamp(),
  check (expires_at > sent_at)
);

create index if not exists retail_signup_sms_verifications_intent_created_idx
  on private_auth.retail_signup_sms_verifications (purchase_intent_id, created_at desc);

create unique index if not exists retail_signup_sms_verifications_provider_message_idx
  on private_auth.retail_signup_sms_verifications (provider, provider_message_id)
  where provider_message_id is not null;

create table if not exists private_auth.retail_signup_sms_delivery_events (
  event_id uuid primary key default gen_random_uuid(),
  provider text not null check (provider ~ '^[a-z0-9_:-]{1,40}$'),
  provider_event_id text not null check (char_length(provider_event_id) between 1 and 255),
  provider_event_at timestamptz not null,
  verification_id uuid null references private_auth.retail_signup_sms_verifications(id) on delete cascade,
  delivery_status text not null check (delivery_status in ('queued', 'sent', 'delivered', 'failed', 'undelivered', 'rejected')),
  created_at timestamptz not null default statement_timestamp(),
  unique (provider, provider_event_id)
);

create table if not exists private_auth.retail_sms_spend_reservations (
  reservation_id uuid primary key,
  period_day date not null,
  reserved_cents integer not null check (reserved_cents between 1 and 100000),
  provider text not null check (provider ~ '^[a-z0-9_:-]{1,40}$'),
  country text not null check (country ~ '^[A-Z]{2}$'),
  destination_fingerprint text not null check (destination_fingerprint ~ '^[0-9a-f]{64}$'),
  purchase_intent_id uuid not null references public.public_purchase_intents(id) on delete cascade,
  resource_fingerprint text not null check (resource_fingerprint ~ '^[0-9a-f]{64}$'),
  outcome text null check (outcome is null or outcome in (
    'accepted', 'ambiguous_outcome', 'provider_rejected', 'invalid_destination',
    'blocked_destination', 'transient_preacceptance', 'misconfigured'
  )),
  released_at timestamptz,
  created_at timestamptz not null default statement_timestamp(),
  updated_at timestamptz not null default statement_timestamp()
);

create index if not exists retail_sms_spend_reservations_active_day_idx
  on private_auth.retail_sms_spend_reservations (period_day, provider, created_at)
  where released_at is null;

alter table private_auth.retail_signup_sms_verifications enable row level security;
alter table private_auth.retail_signup_sms_delivery_events enable row level security;
alter table private_auth.retail_sms_spend_reservations enable row level security;

alter table private_auth.retail_signup_sms_verifications owner to postgres;
alter table private_auth.retail_signup_sms_delivery_events owner to postgres;
alter table private_auth.retail_sms_spend_reservations owner to postgres;

revoke all on table private_auth.retail_signup_sms_verifications from public, anon, authenticated, service_role;
revoke all on table private_auth.retail_signup_sms_delivery_events from public, anon, authenticated, service_role;
revoke all on table private_auth.retail_sms_spend_reservations from public, anon, authenticated, service_role;

comment on table private_auth.retail_signup_sms_verifications is
  'Private retail OTP challenges. Stores HMAC verifiers and destination fingerprints only; never raw codes or phone numbers.';

create or replace function public.clear_public_purchase_intent_phone_verification_on_phone_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if coalesce(old.buyer_phone, '') is distinct from coalesce(new.buyer_phone, '') then
    new.phone_verified_at := null;
    new.phone_verified_destination_fingerprint := null;
    new.phone_verification_method := null;
    new.phone_verification_version := null;

    update private_auth.retail_signup_sms_verifications
    set invalidated_at = coalesce(invalidated_at, statement_timestamp()),
        invalidation_reason = coalesce(invalidation_reason, 'buyer_phone_changed'),
        updated_at = statement_timestamp()
    where purchase_intent_id = old.id
      and used_at is null
      and invalidated_at is null;
  end if;
  return new;
end
$function$;

drop trigger if exists clear_public_purchase_intent_phone_verification_on_phone_change
  on public.public_purchase_intents;

create trigger clear_public_purchase_intent_phone_verification_on_phone_change
before update of buyer_phone on public.public_purchase_intents
for each row execute function public.clear_public_purchase_intent_phone_verification_on_phone_change();

create or replace function public.invalidate_retail_sms_verification_on_email_verified()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if new.email_verified_at is not null
    and old.email_verified_at is distinct from new.email_verified_at
  then
    update private_auth.retail_signup_sms_verifications
    set invalidated_at = coalesce(invalidated_at, statement_timestamp()),
        invalidation_reason = coalesce(invalidation_reason, 'verified_by_email'),
        updated_at = statement_timestamp()
    where purchase_intent_id = new.id
      and used_at is null and invalidated_at is null;
  end if;
  return new;
end
$function$;

drop trigger if exists invalidate_retail_sms_verification_on_email_verified
  on public.public_purchase_intents;

create trigger invalidate_retail_sms_verification_on_email_verified
after update of email_verified_at on public.public_purchase_intents
for each row execute function public.invalidate_retail_sms_verification_on_email_verified();

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

  if v_latest_sent_at is not null and v_latest_sent_at > v_now - interval '60 seconds' then
    return query select 'resend_cooldown'::text, null::uuid, null::timestamptz,
      greatest(1, ceil(extract(epoch from (v_latest_sent_at + interval '60 seconds' - v_now)))::integer);
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

  return query select 'issued'::text, p_verification_id, v_expires_at, 60;
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
    v_resend := greatest(v_resend, greatest(0, ceil(extract(epoch from (v_latest.sent_at + interval '60 seconds' - v_now)))::integer));
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

create or replace function private_auth.consume_retail_signup_sms_verification(
  p_verification_id uuid,
  p_verifier_matches boolean
)
returns table(status text)
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_now timestamptz := statement_timestamp();
  v_intent public.public_purchase_intents%rowtype;
  v_verification private_auth.retail_signup_sms_verifications%rowtype;
  v_next_attempt_count integer;
begin
  select * into v_verification
  from private_auth.retail_signup_sms_verifications
  where id = p_verification_id
  for update;

  if not found then
    return query select 'invalid'::text;
    return;
  end if;

  select * into v_intent
  from public.public_purchase_intents
  where id = v_verification.purchase_intent_id
  for update;

  if not found
    or v_intent.status <> 'pending'
    or (v_intent.expires_at is not null and v_intent.expires_at <= v_now)
  then return query select 'invalid'::text; return; end if;
  if v_verification.used_at is not null then return query select 'already_used'::text; return; end if;
  if v_verification.invalidated_at is not null then
    return query select case when v_verification.invalidation_reason = 'attempt_limit' then 'attempt_limit' else 'invalid' end;
    return;
  end if;
  if v_verification.expires_at <= v_now then
    update private_auth.retail_signup_sms_verifications
    set invalidated_at = v_now, invalidation_reason = 'expired', updated_at = v_now
    where id = v_verification.id;
    return query select 'expired'::text;
    return;
  end if;

  if not coalesce(p_verifier_matches, false) then
    v_next_attempt_count := v_verification.attempt_count + 1;
    update private_auth.retail_signup_sms_verifications
    set attempt_count = v_next_attempt_count,
        invalidated_at = case when v_next_attempt_count >= 5 then v_now else null end,
        invalidation_reason = case when v_next_attempt_count >= 5 then 'attempt_limit' else null end,
        updated_at = v_now
    where id = v_verification.id;
    return query select case when v_next_attempt_count >= 5 then 'attempt_limit' else 'invalid' end;
    return;
  end if;

  if v_verification.plan_key <> v_intent.selected_plan_key
    or v_verification.billing_cadence <> v_intent.selected_billing_cadence
  then
    update private_auth.retail_signup_sms_verifications
    set invalidated_at = v_now, invalidation_reason = 'context_mismatch', updated_at = v_now
    where id = v_verification.id;
    return query select 'invalid'::text;
    return;
  end if;

  update private_auth.retail_signup_sms_verifications
  set used_at = v_now, updated_at = v_now
  where id = v_verification.id and used_at is null and invalidated_at is null;

  update public.public_purchase_intents
  set phone_verified_at = v_now,
      phone_verified_destination_fingerprint = v_verification.destination_fingerprint,
      phone_verification_method = 'retail_signup_sms_otp_v1',
      phone_verification_version = 1,
      updated_at = v_now
  where id = v_intent.id;

  update public.retail_signup_email_verifications
  set invalidated_at = coalesce(invalidated_at, v_now),
      invalidation_reason = coalesce(invalidation_reason, 'verified_by_sms'),
      updated_at = v_now
  where purchase_intent_id = v_intent.id and used_at is null and invalidated_at is null;

  return query select 'verified'::text;
end
$function$;

create or replace function private_auth.invalidate_retail_signup_sms_verifications(
  p_purchase_intent_id uuid,
  p_reason text
)
returns integer
language plpgsql
security definer
set search_path = ''
as $function$
declare v_rows integer;
begin
  update private_auth.retail_signup_sms_verifications
  set invalidated_at = statement_timestamp(),
      invalidation_reason = left(coalesce(nullif(p_reason, ''), 'superseded'), 80),
      updated_at = statement_timestamp()
  where purchase_intent_id = p_purchase_intent_id
    and used_at is null and invalidated_at is null;
  get diagnostics v_rows = row_count;
  return v_rows;
end
$function$;

create or replace function private_auth.record_retail_signup_sms_delivery_metadata(
  p_verification_id uuid,
  p_event text,
  p_provider text,
  p_provider_message_id text default null,
  p_delivery_status text default null,
  p_failure_category text default null
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $function$
declare v_rows integer;
begin
  if p_event not in ('send_requested', 'provider_accepted', 'send_outcome')
    or p_provider !~ '^[a-z0-9_:-]{1,40}$'
  then return false; end if;

  update private_auth.retail_signup_sms_verifications
  set provider = p_provider,
      provider_message_id = case when p_event = 'provider_accepted' then p_provider_message_id else provider_message_id end,
      delivery_status = coalesce(p_delivery_status, delivery_status),
      failure_category = coalesce(p_failure_category, failure_category),
      updated_at = statement_timestamp()
  where id = p_verification_id;
  get diagnostics v_rows = row_count;
  return v_rows = 1;
end
$function$;

create or replace function private_auth.record_retail_signup_sms_delivery_event(
  p_provider text,
  p_provider_message_id text,
  p_provider_event_id text,
  p_provider_event_at timestamptz,
  p_delivery_status text
)
returns table(found boolean, verification_id uuid, provider_delivery_status text, last_provider_event_id text, last_provider_event_at timestamptz, applied boolean, replayed boolean)
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_verification private_auth.retail_signup_sms_verifications%rowtype;
  v_inserted integer;
  v_applied boolean := false;
begin
  select * into v_verification
  from private_auth.retail_signup_sms_verifications
  where provider = p_provider and provider_message_id = p_provider_message_id
  order by created_at desc limit 1 for update;

  if not found then
    return query select false, null::uuid, null::text, null::text, null::timestamptz, false, false;
    return;
  end if;

  insert into private_auth.retail_signup_sms_delivery_events (
    provider, provider_event_id, provider_event_at, verification_id, delivery_status
  ) values (p_provider, p_provider_event_id, p_provider_event_at, v_verification.id, p_delivery_status)
  on conflict (provider, provider_event_id) do nothing;
  get diagnostics v_inserted = row_count;

  if v_inserted = 0 then
    return query select true, v_verification.id, v_verification.delivery_status,
      v_verification.last_provider_event_id, v_verification.last_provider_event_at, false, true;
    return;
  end if;

  if v_verification.last_provider_event_at is null or p_provider_event_at >= v_verification.last_provider_event_at then
    update private_auth.retail_signup_sms_verifications
    set delivery_status = p_delivery_status,
        last_provider_event_id = p_provider_event_id,
        last_provider_event_at = p_provider_event_at,
        updated_at = statement_timestamp()
    where id = v_verification.id;
    v_applied := true;
  end if;

  return query select true, v_verification.id,
    case when v_applied then p_delivery_status else v_verification.delivery_status end,
    case when v_applied then p_provider_event_id else v_verification.last_provider_event_id end,
    case when v_applied then p_provider_event_at else v_verification.last_provider_event_at end,
    v_applied, false;
end
$function$;

create or replace function private_auth.reserve_retail_sms_spend(
  p_reservation_id uuid,
  p_reserved_cents integer,
  p_daily_cap_cents integer,
  p_provider text,
  p_country text,
  p_destination_fingerprint text,
  p_purchase_intent_id uuid,
  p_resource_fingerprint text
)
returns table(allowed boolean, reserved_total_cents integer)
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_period_day date := (statement_timestamp() at time zone 'UTC')::date;
  v_total bigint;
begin
  if p_reservation_id is null or p_reserved_cents not between 1 and 100000
    or p_daily_cap_cents not between p_reserved_cents and 10000000
    or p_provider !~ '^[a-z0-9_:-]{1,40}$' or p_country !~ '^[A-Z]{2}$'
    or p_destination_fingerprint !~ '^[0-9a-f]{64}$' or p_purchase_intent_id is null
    or p_resource_fingerprint !~ '^[0-9a-f]{64}$'
  then raise exception using errcode = '22023', message = 'invalid retail sms spend reservation input'; end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('sms-spend' || chr(31) || p_provider || chr(31) || v_period_day::text, 0)
  );

  if exists (select 1 from private_auth.sms_provider_breakers where provider = p_provider and active) then
    return query select false, 0; return;
  end if;

  select coalesce((select sum(reserved_cents) from private_auth.sms_spend_reservations where period_day = v_period_day and provider = p_provider and released_at is null), 0)
       + coalesce((select sum(reserved_cents) from private_auth.retail_sms_spend_reservations where period_day = v_period_day and provider = p_provider and released_at is null), 0)
  into v_total;

  if v_total + p_reserved_cents > p_daily_cap_cents then return query select false, v_total::integer; return; end if;

  insert into private_auth.retail_sms_spend_reservations (
    reservation_id, period_day, reserved_cents, provider, country,
    destination_fingerprint, purchase_intent_id, resource_fingerprint
  ) values (
    p_reservation_id, v_period_day, p_reserved_cents, p_provider, p_country,
    p_destination_fingerprint, p_purchase_intent_id, p_resource_fingerprint
  );
  return query select true, (v_total + p_reserved_cents)::integer;
end
$function$;

create or replace function private_auth.release_retail_sms_spend(p_reservation_id uuid, p_outcome text)
returns boolean language plpgsql security definer set search_path = '' as $function$
declare v_rows integer;
begin
  update private_auth.retail_sms_spend_reservations
  set released_at = statement_timestamp(), outcome = p_outcome, updated_at = statement_timestamp()
  where reservation_id = p_reservation_id and released_at is null;
  get diagnostics v_rows = row_count;
  return v_rows > 0;
end
$function$;

create or replace function private_auth.reserve_sms_spend(
  p_reservation_id uuid,
  p_reserved_cents integer,
  p_daily_cap_cents integer,
  p_provider text,
  p_country text,
  p_destination_fingerprint text,
  p_candidate_id uuid,
  p_resource_fingerprint text
)
returns table(allowed boolean, reserved_total_cents integer)
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_period_day date := (statement_timestamp() at time zone 'UTC')::date;
  v_total bigint;
begin
  if p_reservation_id is null
    or p_reserved_cents not between 1 and 100000
    or p_daily_cap_cents not between p_reserved_cents and 10000000
    or p_provider !~ '^[a-z0-9_:-]{1,40}$'
    or p_country !~ '^[A-Z]{2}$'
    or p_destination_fingerprint !~ '^[0-9a-f]{64}$'
    or p_candidate_id is null
    or p_resource_fingerprint !~ '^[0-9a-f]{64}$'
  then
    raise exception using errcode = '22023', message = 'invalid sms spend reservation input';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('sms-spend' || chr(31) || p_provider || chr(31) || v_period_day::text, 0)
  );

  if exists (
    select 1 from private_auth.sms_provider_breakers b
    where b.provider = p_provider and b.active = true
  ) then
    return query select false, 0;
    return;
  end if;

  select coalesce((
      select sum(r.reserved_cents)
      from private_auth.sms_spend_reservations r
      where r.period_day = v_period_day
        and r.provider = p_provider
        and r.released_at is null
    ), 0) + coalesce((
      select sum(r.reserved_cents)
      from private_auth.retail_sms_spend_reservations r
      where r.period_day = v_period_day
        and r.provider = p_provider
        and r.released_at is null
    ), 0)
  into v_total;

  if v_total + p_reserved_cents > p_daily_cap_cents then
    return query select false, v_total::integer;
    return;
  end if;

  insert into private_auth.sms_spend_reservations (
    reservation_id, period_day, reserved_cents, provider, country,
    destination_fingerprint, candidate_id, resource_fingerprint
  ) values (
    p_reservation_id, v_period_day, p_reserved_cents, p_provider, p_country,
    p_destination_fingerprint, p_candidate_id, p_resource_fingerprint
  );

  return query select true, (v_total + p_reserved_cents)::integer;
end
$function$;

create or replace function private_auth.finalize_retail_sms_spend(p_reservation_id uuid, p_outcome text)
returns boolean language plpgsql security definer set search_path = '' as $function$
declare v_rows integer;
begin
  update private_auth.retail_sms_spend_reservations
  set outcome = p_outcome, updated_at = statement_timestamp()
  where reservation_id = p_reservation_id and released_at is null;
  get diagnostics v_rows = row_count;
  return v_rows > 0;
end
$function$;

create or replace function public.service_issue_retail_signup_sms_verification(
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
language sql volatile security definer set search_path = '' as $function$
  select * from private_auth.issue_retail_signup_sms_verification(
    p_verification_id,p_purchase_intent_id,p_destination_fingerprint,p_plan_key,p_billing_cadence,
    p_pepper_version,p_verifier_hmac_hex,p_sms_selection_at,p_consent_copy_version
  )
$function$;

create or replace function public.service_get_retail_signup_sms_verification(
  p_purchase_intent_id uuid,
  p_destination_fingerprint text
)
returns table(verification_id uuid, verifier_hmac_hex text, verified boolean, status text, expires_at timestamptz, sent_at timestamptz, resend_after_seconds integer)
language sql stable security definer set search_path = '' as $function$
  select * from private_auth.get_retail_signup_sms_verification(p_purchase_intent_id,p_destination_fingerprint)
$function$;

create or replace function public.service_consume_retail_signup_sms_verification(
  p_verification_id uuid,
  p_verifier_matches boolean
)
returns table(status text) language sql volatile security definer set search_path = '' as $function$
  select * from private_auth.consume_retail_signup_sms_verification(p_verification_id,p_verifier_matches)
$function$;

create or replace function public.service_invalidate_retail_signup_sms_verifications(
  p_purchase_intent_id uuid,
  p_reason text
)
returns integer language sql volatile security definer set search_path = '' as $function$
  select private_auth.invalidate_retail_signup_sms_verifications(p_purchase_intent_id,p_reason)
$function$;

create or replace function public.service_record_retail_signup_sms_delivery_metadata(
  p_verification_id uuid,
  p_event text,
  p_provider text,
  p_provider_message_id text,
  p_delivery_status text,
  p_failure_category text
)
returns boolean language sql volatile security definer set search_path = '' as $function$
  select private_auth.record_retail_signup_sms_delivery_metadata(
    p_verification_id,p_event,p_provider,p_provider_message_id,p_delivery_status,p_failure_category
  )
$function$;

create or replace function public.service_record_retail_signup_sms_delivery_event(
  p_provider text,
  p_provider_message_id text,
  p_provider_event_id text,
  p_provider_event_at timestamptz,
  p_delivery_status text
)
returns table(found boolean, verification_id uuid, provider_delivery_status text, last_provider_event_id text, last_provider_event_at timestamptz, applied boolean, replayed boolean)
language sql volatile security definer set search_path = '' as $function$
  select * from private_auth.record_retail_signup_sms_delivery_event(
    p_provider,p_provider_message_id,p_provider_event_id,p_provider_event_at,p_delivery_status
  )
$function$;

create or replace function public.service_reserve_retail_sms_spend(
  p_reservation_id uuid,
  p_reserved_cents integer,
  p_daily_cap_cents integer,
  p_provider text,
  p_country text,
  p_destination_fingerprint text,
  p_purchase_intent_id uuid,
  p_resource_fingerprint text
)
returns table(allowed boolean, reserved_total_cents integer)
language sql volatile security definer set search_path = '' as $function$
  select * from private_auth.reserve_retail_sms_spend(
    p_reservation_id,p_reserved_cents,p_daily_cap_cents,p_provider,p_country,
    p_destination_fingerprint,p_purchase_intent_id,p_resource_fingerprint
  )
$function$;

create or replace function public.service_release_retail_sms_spend(
  p_reservation_id uuid,
  p_outcome text
)
returns boolean language sql volatile security definer set search_path = '' as $function$
  select private_auth.release_retail_sms_spend(p_reservation_id,p_outcome)
$function$;

create or replace function public.service_finalize_retail_sms_spend(
  p_reservation_id uuid,
  p_outcome text
)
returns boolean language sql volatile security definer set search_path = '' as $function$
  select private_auth.finalize_retail_sms_spend(p_reservation_id,p_outcome)
$function$;

alter function public.clear_public_purchase_intent_phone_verification_on_phone_change() owner to postgres;
alter function public.invalidate_retail_sms_verification_on_email_verified() owner to postgres;
alter function private_auth.issue_retail_signup_sms_verification(uuid,uuid,text,text,text,integer,text,timestamptz,text) owner to postgres;
alter function private_auth.get_retail_signup_sms_verification(uuid,text) owner to postgres;
alter function private_auth.consume_retail_signup_sms_verification(uuid,boolean) owner to postgres;
alter function private_auth.invalidate_retail_signup_sms_verifications(uuid,text) owner to postgres;
alter function private_auth.record_retail_signup_sms_delivery_metadata(uuid,text,text,text,text,text) owner to postgres;
alter function private_auth.record_retail_signup_sms_delivery_event(text,text,text,timestamptz,text) owner to postgres;
alter function private_auth.reserve_sms_spend(uuid,integer,integer,text,text,text,uuid,text) owner to postgres;
alter function private_auth.reserve_retail_sms_spend(uuid,integer,integer,text,text,text,uuid,text) owner to postgres;
alter function private_auth.release_retail_sms_spend(uuid,text) owner to postgres;
alter function private_auth.finalize_retail_sms_spend(uuid,text) owner to postgres;
alter function public.service_issue_retail_signup_sms_verification(uuid,uuid,text,text,text,integer,text,timestamptz,text) owner to postgres;
alter function public.service_get_retail_signup_sms_verification(uuid,text) owner to postgres;
alter function public.service_consume_retail_signup_sms_verification(uuid,boolean) owner to postgres;
alter function public.service_invalidate_retail_signup_sms_verifications(uuid,text) owner to postgres;
alter function public.service_record_retail_signup_sms_delivery_metadata(uuid,text,text,text,text,text) owner to postgres;
alter function public.service_record_retail_signup_sms_delivery_event(text,text,text,timestamptz,text) owner to postgres;
alter function public.service_reserve_retail_sms_spend(uuid,integer,integer,text,text,text,uuid,text) owner to postgres;
alter function public.service_release_retail_sms_spend(uuid,text) owner to postgres;
alter function public.service_finalize_retail_sms_spend(uuid,text) owner to postgres;

revoke all on function public.clear_public_purchase_intent_phone_verification_on_phone_change() from public, anon, authenticated, service_role;
revoke all on function public.invalidate_retail_sms_verification_on_email_verified() from public, anon, authenticated, service_role;
revoke all on function private_auth.issue_retail_signup_sms_verification(uuid,uuid,text,text,text,integer,text,timestamptz,text) from public, anon, authenticated, service_role;
revoke all on function private_auth.get_retail_signup_sms_verification(uuid,text) from public, anon, authenticated, service_role;
revoke all on function private_auth.consume_retail_signup_sms_verification(uuid,boolean) from public, anon, authenticated, service_role;
revoke all on function private_auth.invalidate_retail_signup_sms_verifications(uuid,text) from public, anon, authenticated, service_role;
revoke all on function private_auth.record_retail_signup_sms_delivery_metadata(uuid,text,text,text,text,text) from public, anon, authenticated, service_role;
revoke all on function private_auth.record_retail_signup_sms_delivery_event(text,text,text,timestamptz,text) from public, anon, authenticated, service_role;
revoke all on function private_auth.reserve_sms_spend(uuid,integer,integer,text,text,text,uuid,text) from public, anon, authenticated, service_role;
revoke all on function private_auth.reserve_retail_sms_spend(uuid,integer,integer,text,text,text,uuid,text) from public, anon, authenticated, service_role;
revoke all on function private_auth.release_retail_sms_spend(uuid,text) from public, anon, authenticated, service_role;
revoke all on function private_auth.finalize_retail_sms_spend(uuid,text) from public, anon, authenticated, service_role;
revoke all on function public.service_issue_retail_signup_sms_verification(uuid,uuid,text,text,text,integer,text,timestamptz,text) from public, anon, authenticated;
revoke all on function public.service_get_retail_signup_sms_verification(uuid,text) from public, anon, authenticated;
revoke all on function public.service_consume_retail_signup_sms_verification(uuid,boolean) from public, anon, authenticated;
revoke all on function public.service_invalidate_retail_signup_sms_verifications(uuid,text) from public, anon, authenticated;
revoke all on function public.service_record_retail_signup_sms_delivery_metadata(uuid,text,text,text,text,text) from public, anon, authenticated;
revoke all on function public.service_record_retail_signup_sms_delivery_event(text,text,text,timestamptz,text) from public, anon, authenticated;
revoke all on function public.service_reserve_retail_sms_spend(uuid,integer,integer,text,text,text,uuid,text) from public, anon, authenticated;
revoke all on function public.service_release_retail_sms_spend(uuid,text) from public, anon, authenticated;
revoke all on function public.service_finalize_retail_sms_spend(uuid,text) from public, anon, authenticated;

grant execute on function public.service_issue_retail_signup_sms_verification(uuid,uuid,text,text,text,integer,text,timestamptz,text) to service_role;
grant execute on function public.service_get_retail_signup_sms_verification(uuid,text) to service_role;
grant execute on function public.service_consume_retail_signup_sms_verification(uuid,boolean) to service_role;
grant execute on function public.service_invalidate_retail_signup_sms_verifications(uuid,text) to service_role;
grant execute on function public.service_record_retail_signup_sms_delivery_metadata(uuid,text,text,text,text,text) to service_role;
grant execute on function public.service_record_retail_signup_sms_delivery_event(text,text,text,timestamptz,text) to service_role;
grant execute on function public.service_reserve_retail_sms_spend(uuid,integer,integer,text,text,text,uuid,text) to service_role;
grant execute on function public.service_release_retail_sms_spend(uuid,text) to service_role;
grant execute on function public.service_finalize_retail_sms_spend(uuid,text) to service_role;

commit;
