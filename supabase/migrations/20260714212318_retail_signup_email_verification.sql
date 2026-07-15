create extension if not exists pgcrypto;

alter table public.public_purchase_intents
  add column if not exists email_verified_at timestamptz,
  add column if not exists email_verified_address text,
  add column if not exists email_verification_method text,
  add column if not exists email_verification_version integer;

create table if not exists public.retail_signup_email_verifications (
  id uuid primary key default gen_random_uuid(),
  purchase_intent_id uuid not null references public.public_purchase_intents(id) on delete cascade,
  buyer_email text not null,
  plan_key text not null,
  billing_cadence text not null,
  code_hash text not null,
  code_salt text not null,
  attempt_count integer not null default 0,
  expires_at timestamptz not null,
  sent_at timestamptz not null default now(),
  used_at timestamptz,
  invalidated_at timestamptz,
  invalidation_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint retail_signup_email_verifications_email_normalized_check
    check (buyer_email = lower(buyer_email)),
  constraint retail_signup_email_verifications_plan_key_check
    check (plan_key in ('basic', 'pro')),
  constraint retail_signup_email_verifications_billing_cadence_check
    check (billing_cadence in ('monthly', 'annual')),
  constraint retail_signup_email_verifications_code_hash_check
    check (code_hash ~ '^[0-9a-f]{64}$'),
  constraint retail_signup_email_verifications_code_salt_check
    check (code_salt ~ '^[0-9a-f]{64}$'),
  constraint retail_signup_email_verifications_attempt_count_check
    check (attempt_count between 0 and 5)
);

create index if not exists retail_signup_email_verifications_intent_email_created_idx
  on public.retail_signup_email_verifications (purchase_intent_id, buyer_email, created_at desc);

create index if not exists retail_signup_email_verifications_active_idx
  on public.retail_signup_email_verifications (purchase_intent_id, buyer_email, expires_at)
  where used_at is null and invalidated_at is null;

alter table public.retail_signup_email_verifications enable row level security;

revoke all on table public.retail_signup_email_verifications from anon;
revoke all on table public.retail_signup_email_verifications from authenticated;

create or replace function public.clear_public_purchase_intent_email_verification_on_email_change()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if lower(coalesce(old.buyer_email, '')) is distinct from lower(coalesce(new.buyer_email, '')) then
    new.email_verified_at := null;
    new.email_verified_address := null;
    new.email_verification_method := null;
    new.email_verification_version := null;

    update public.retail_signup_email_verifications
    set invalidated_at = coalesce(invalidated_at, now()),
        invalidation_reason = coalesce(invalidation_reason, 'buyer_email_changed'),
        updated_at = now()
    where purchase_intent_id = old.id
      and used_at is null
      and invalidated_at is null;
  end if;
  return new;
end;
$$;

drop trigger if exists clear_public_purchase_intent_email_verification_on_email_change
  on public.public_purchase_intents;

create trigger clear_public_purchase_intent_email_verification_on_email_change
before update of buyer_email on public.public_purchase_intents
for each row
execute function public.clear_public_purchase_intent_email_verification_on_email_change();

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

  select count(*)::integer
  into v_sent_count
  from public.retail_signup_email_verifications
  where purchase_intent_id = v_intent.id
    and buyer_email = lower(v_intent.buyer_email)
    and sent_at >= v_now - interval '1 hour';

  if v_sent_count >= 5 then
    return query select 'hourly_limit'::text, null::uuid, null::timestamptz, 0;
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

create or replace function public.consume_retail_signup_email_verification(
  p_purchase_intent_id uuid,
  p_buyer_email text,
  p_code_hash text
)
returns table (status text)
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_now timestamptz := now();
  v_intent public.public_purchase_intents%rowtype;
  v_verification public.retail_signup_email_verifications%rowtype;
  v_next_attempt_count integer;
begin
  select *
  into v_intent
  from public.public_purchase_intents
  where id = p_purchase_intent_id
  for update;

  if not found
    or lower(coalesce(v_intent.buyer_email, '')) <> lower(coalesce(p_buyer_email, ''))
    or v_intent.status <> 'pending'
    or (v_intent.expires_at is not null and v_intent.expires_at <= v_now) then
    return query select 'invalid'::text;
    return;
  end if;

  select *
  into v_verification
  from public.retail_signup_email_verifications
  where purchase_intent_id = v_intent.id
    and buyer_email = lower(v_intent.buyer_email)
  order by created_at desc
  limit 1
  for update;

  if not found then
    return query select 'invalid'::text;
    return;
  end if;

  if v_verification.plan_key <> v_intent.selected_plan_key
    or v_verification.billing_cadence <> v_intent.selected_billing_cadence then
    update public.retail_signup_email_verifications
    set invalidated_at = coalesce(invalidated_at, v_now),
        invalidation_reason = coalesce(invalidation_reason, 'context_mismatch'),
        updated_at = v_now
    where id = v_verification.id;
    return query select 'invalid'::text;
    return;
  end if;

  if v_verification.used_at is not null then
    return query select 'already_used'::text;
    return;
  end if;

  if v_verification.invalidated_at is not null then
    return query select case
      when v_verification.invalidation_reason = 'attempt_limit' then 'attempt_limit'
      else 'invalid'
    end;
    return;
  end if;

  if v_verification.expires_at <= v_now then
    update public.retail_signup_email_verifications
    set invalidated_at = v_now,
        invalidation_reason = 'expired',
        updated_at = v_now
    where id = v_verification.id;
    return query select 'expired'::text;
    return;
  end if;

  if v_verification.code_hash <> p_code_hash then
    v_next_attempt_count := v_verification.attempt_count + 1;
    update public.retail_signup_email_verifications
    set attempt_count = v_next_attempt_count,
        invalidated_at = case when v_next_attempt_count >= 5 then v_now else null end,
        invalidation_reason = case when v_next_attempt_count >= 5 then 'attempt_limit' else null end,
        updated_at = v_now
    where id = v_verification.id;

    return query select case when v_next_attempt_count >= 5 then 'attempt_limit' else 'invalid' end;
    return;
  end if;

  update public.retail_signup_email_verifications
  set used_at = v_now,
      updated_at = v_now
  where id = v_verification.id
    and used_at is null
    and invalidated_at is null;

  update public.public_purchase_intents
  set email_verified_at = v_now,
      email_verified_address = lower(v_intent.buyer_email),
      email_verification_method = 'retail_signup_email_otp_v1',
      email_verification_version = 1,
      updated_at = v_now
  where id = v_intent.id
    and lower(buyer_email) = lower(v_intent.buyer_email);

  return query select 'verified'::text;
end;
$$;

revoke all on function public.issue_retail_signup_email_verification(uuid, text, text, text, text, text) from public;
revoke all on function public.consume_retail_signup_email_verification(uuid, text, text) from public;
revoke all on function public.issue_retail_signup_email_verification(uuid, text, text, text, text, text) from anon;
revoke all on function public.consume_retail_signup_email_verification(uuid, text, text) from anon;
revoke all on function public.issue_retail_signup_email_verification(uuid, text, text, text, text, text) from authenticated;
revoke all on function public.consume_retail_signup_email_verification(uuid, text, text) from authenticated;
grant execute on function public.issue_retail_signup_email_verification(uuid, text, text, text, text, text) to service_role;
grant execute on function public.consume_retail_signup_email_verification(uuid, text, text) to service_role;
