begin;

create schema if not exists private_auth authorization postgres;
revoke all on schema private_auth from public, anon, authenticated, service_role;

create table if not exists private_auth.otp_challenges (
  challenge_id uuid primary key,
  purpose text not null check (purpose in ('interview_access')),
  channel text not null check (channel in ('email', 'sms')),
  pepper_version smallint not null check (pepper_version > 0),
  verifier_hmac bytea not null check (octet_length(verifier_hmac) = 32),
  binding_fingerprint text not null check (binding_fingerprint ~ '^[0-9a-f]{64}$'),
  candidate_id uuid not null references public.candidates(id) on delete cascade,
  client_id uuid not null references public.clients(id) on delete cascade,
  role_id uuid not null references public.roles(id) on delete cascade,
  submission_id uuid null references public.candidate_submission_requests(id) on delete set null,
  interview_attempt_id uuid null references public.interviews(id) on delete set null,
  recovery_authorization_id uuid null references public.interview_reset_events(id) on delete set null,
  destination_fingerprint text not null check (destination_fingerprint ~ '^[0-9a-f]{64}$'),
  expires_at timestamptz not null,
  consumed_at timestamptz null,
  superseded_at timestamptz null,
  superseded_by uuid null,
  superseded_reason text null check (superseded_reason is null or char_length(superseded_reason) <= 80),
  attempt_count integer not null default 0 check (attempt_count >= 0),
  max_attempts integer not null default 5 check (max_attempts between 1 and 20),
  delivery_state text not null default 'pending' check (delivery_state in ('pending', 'sent', 'failed')),
  delivery_attempt_count integer not null default 0 check (delivery_attempt_count >= 0),
  last_delivery_at timestamptz null,
  created_at timestamptz not null default statement_timestamp(),
  updated_at timestamptz not null default statement_timestamp(),
  check (consumed_at is null or superseded_at is null),
  check (superseded_by is null or superseded_at is not null)
);

alter table private_auth.otp_challenges enable row level security;
alter table private_auth.otp_challenges owner to postgres;
revoke all privileges on table private_auth.otp_challenges from public, anon, authenticated, service_role;

create unique index if not exists otp_challenges_one_active_binding_uidx
  on private_auth.otp_challenges (purpose, channel, binding_fingerprint)
  where consumed_at is null and superseded_at is null;

create index if not exists otp_challenges_candidate_role_idx
  on private_auth.otp_challenges (candidate_id, role_id, created_at desc);

create index if not exists otp_challenges_expiry_idx
  on private_auth.otp_challenges (expires_at)
  where consumed_at is null and superseded_at is null;

comment on table private_auth.otp_challenges is
  'Private service-mediated OTP challenge ledger. Verifiers are HMAC digests; destinations and codes are never stored.';

create or replace function private_auth.issue_otp_challenge(
  p_challenge_id uuid,
  p_purpose text,
  p_channel text,
  p_pepper_version smallint,
  p_verifier_hmac_hex text,
  p_binding_fingerprint text,
  p_candidate_id uuid,
  p_client_id uuid,
  p_role_id uuid,
  p_submission_id uuid,
  p_interview_attempt_id uuid,
  p_recovery_authorization_id uuid,
  p_destination_fingerprint text,
  p_expires_in_seconds integer,
  p_max_attempts integer,
  p_delivery_state text
)
returns table(challenge_id uuid, expires_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_now timestamptz := statement_timestamp();
  v_expires timestamptz;
begin
  if p_challenge_id is null
    or p_purpose <> 'interview_access'
    or p_channel not in ('email', 'sms')
    or p_pepper_version < 1
    or p_verifier_hmac_hex !~ '^[0-9a-fA-F]{64}$'
    or p_binding_fingerprint !~ '^[0-9a-f]{64}$'
    or p_destination_fingerprint !~ '^[0-9a-f]{64}$'
    or p_candidate_id is null or p_client_id is null or p_role_id is null
    or p_expires_in_seconds not between 60 and 1800
    or p_max_attempts not between 1 and 20
    or p_delivery_state not in ('pending', 'sent', 'failed')
  then
    raise exception using errcode = '22023', message = 'invalid otp challenge input';
  end if;

  if not exists (
    select 1 from public.candidates c
    where c.id = p_candidate_id and c.client_id = p_client_id and c.role_id = p_role_id
  ) then
    raise exception using errcode = '23503', message = 'otp challenge binding is invalid';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_binding_fingerprint, 0));
  v_expires := v_now + pg_catalog.make_interval(secs => p_expires_in_seconds);

  update private_auth.otp_challenges c
  set superseded_at = v_now,
      superseded_by = p_challenge_id,
      superseded_reason = 'replaced',
      updated_at = v_now
  where c.purpose = p_purpose
    and c.channel = p_channel
    and c.binding_fingerprint = p_binding_fingerprint
    and c.consumed_at is null
    and c.superseded_at is null;

  insert into private_auth.otp_challenges (
    challenge_id, purpose, channel, pepper_version, verifier_hmac,
    binding_fingerprint, candidate_id, client_id, role_id, submission_id,
    interview_attempt_id, recovery_authorization_id, destination_fingerprint,
    expires_at, max_attempts, delivery_state, created_at, updated_at
  ) values (
    p_challenge_id, p_purpose, p_channel, p_pepper_version,
    pg_catalog.decode(p_verifier_hmac_hex, 'hex'), p_binding_fingerprint,
    p_candidate_id, p_client_id, p_role_id, p_submission_id,
    p_interview_attempt_id, p_recovery_authorization_id,
    p_destination_fingerprint, v_expires, p_max_attempts, p_delivery_state,
    v_now, v_now
  );

  update public.otp_tokens t
  set used = true,
      used_at = coalesce(t.used_at, v_now),
      invalidated_at = coalesce(t.invalidated_at, v_now),
      invalidation_reason = coalesce(t.invalidation_reason, 'durable_challenge_issued'),
      code = '[removed]'
  where t.candidate_id = p_candidate_id
    and t.role_id = p_role_id
    and coalesce(t.used, false) = false
    and t.invalidated_at is null;

  return query select p_challenge_id, v_expires;
end
$function$;

create or replace function private_auth.get_otp_challenge_context(p_challenge_id uuid)
returns table(
  challenge_id uuid,
  purpose text,
  channel text,
  pepper_version smallint,
  verifier_hmac_hex text,
  candidate_id uuid,
  client_id uuid,
  role_id uuid,
  submission_id uuid,
  interview_attempt_id uuid,
  recovery_authorization_id uuid,
  expires_at timestamptz,
  consumed_at timestamptz,
  superseded_at timestamptz,
  attempt_count integer,
  max_attempts integer
)
language sql
stable
security definer
set search_path = ''
as $function$
  select c.challenge_id, c.purpose, c.channel, c.pepper_version,
         pg_catalog.encode(c.verifier_hmac, 'hex'), c.candidate_id, c.client_id,
         c.role_id, c.submission_id, c.interview_attempt_id,
         c.recovery_authorization_id, c.expires_at, c.consumed_at,
         c.superseded_at, c.attempt_count, c.max_attempts
  from private_auth.otp_challenges c
  where c.challenge_id = p_challenge_id
$function$;

create or replace function private_auth.consume_otp_challenge(
  p_challenge_id uuid,
  p_verifier_matches boolean
)
returns table(
  status text,
  challenge_id uuid,
  candidate_id uuid,
  client_id uuid,
  role_id uuid,
  submission_id uuid,
  interview_attempt_id uuid
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_now timestamptz := statement_timestamp();
  v_challenge private_auth.otp_challenges%rowtype;
  v_attempts integer;
begin
  select * into v_challenge
  from private_auth.otp_challenges c
  where c.challenge_id = p_challenge_id
  for update;

  if not found then
    return query select 'not_found'::text, p_challenge_id, null::uuid, null::uuid, null::uuid, null::uuid, null::uuid;
    return;
  end if;
  if v_challenge.consumed_at is not null then
    return query select 'consumed'::text, v_challenge.challenge_id, v_challenge.candidate_id, v_challenge.client_id, v_challenge.role_id, v_challenge.submission_id, v_challenge.interview_attempt_id;
    return;
  end if;
  if v_challenge.superseded_at is not null then
    return query select 'superseded'::text, v_challenge.challenge_id, v_challenge.candidate_id, v_challenge.client_id, v_challenge.role_id, v_challenge.submission_id, v_challenge.interview_attempt_id;
    return;
  end if;
  if v_challenge.expires_at <= v_now then
    update private_auth.otp_challenges c
    set superseded_at = v_now, superseded_reason = 'expired', updated_at = v_now
    where c.challenge_id = p_challenge_id;
    return query select 'expired'::text, v_challenge.challenge_id, v_challenge.candidate_id, v_challenge.client_id, v_challenge.role_id, v_challenge.submission_id, v_challenge.interview_attempt_id;
    return;
  end if;
  if v_challenge.attempt_count >= v_challenge.max_attempts then
    update private_auth.otp_challenges c
    set superseded_at = coalesce(c.superseded_at, v_now), superseded_reason = coalesce(c.superseded_reason, 'attempts_exhausted'), updated_at = v_now
    where c.challenge_id = p_challenge_id;
    return query select 'attempts_exhausted'::text, v_challenge.challenge_id, v_challenge.candidate_id, v_challenge.client_id, v_challenge.role_id, v_challenge.submission_id, v_challenge.interview_attempt_id;
    return;
  end if;

  if not coalesce(p_verifier_matches, false) then
    v_attempts := v_challenge.attempt_count + 1;
    update private_auth.otp_challenges c
    set attempt_count = v_attempts,
        superseded_at = case when v_attempts >= c.max_attempts then v_now else c.superseded_at end,
        superseded_reason = case when v_attempts >= c.max_attempts then 'attempts_exhausted' else c.superseded_reason end,
        updated_at = v_now
    where c.challenge_id = p_challenge_id;
    return query select (case when v_attempts >= v_challenge.max_attempts then 'attempts_exhausted' else 'invalid' end)::text,
      v_challenge.challenge_id, v_challenge.candidate_id, v_challenge.client_id, v_challenge.role_id, v_challenge.submission_id, v_challenge.interview_attempt_id;
    return;
  end if;

  update public.candidates c
  set status = 'Verified', verified = true, otp_verified_at = v_now
  where c.id = v_challenge.candidate_id
    and c.client_id = v_challenge.client_id
    and c.role_id = v_challenge.role_id;
  if not found then
    update private_auth.otp_challenges c
    set superseded_at = v_now, superseded_reason = 'binding_invalid', updated_at = v_now
    where c.challenge_id = p_challenge_id;
    return query select 'binding_invalid'::text, v_challenge.challenge_id, v_challenge.candidate_id, v_challenge.client_id, v_challenge.role_id, v_challenge.submission_id, v_challenge.interview_attempt_id;
    return;
  end if;

  update private_auth.otp_challenges c
  set consumed_at = v_now, updated_at = v_now
  where c.challenge_id = p_challenge_id;

  return query select 'verified'::text, v_challenge.challenge_id, v_challenge.candidate_id, v_challenge.client_id, v_challenge.role_id, v_challenge.submission_id, v_challenge.interview_attempt_id;
end
$function$;

create or replace function private_auth.mark_otp_challenge_delivery(
  p_challenge_id uuid,
  p_delivery_state text
)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $function$
begin
  if p_delivery_state not in ('sent', 'failed') then
    raise exception using errcode = '22023', message = 'invalid delivery state';
  end if;
  update private_auth.otp_challenges c
  set delivery_state = p_delivery_state,
      delivery_attempt_count = c.delivery_attempt_count + 1,
      last_delivery_at = statement_timestamp(),
      updated_at = statement_timestamp()
  where c.challenge_id = p_challenge_id;
  return found;
end
$function$;

create or replace function private_auth.supersede_otp_challenges(
  p_candidate_id uuid,
  p_role_id uuid,
  p_reason text
)
returns bigint
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_count bigint;
begin
  update private_auth.otp_challenges c
  set superseded_at = statement_timestamp(),
      superseded_reason = left(coalesce(nullif(p_reason, ''), 'superseded'), 80),
      updated_at = statement_timestamp()
  where c.candidate_id = p_candidate_id
    and c.role_id = p_role_id
    and c.consumed_at is null
    and c.superseded_at is null;
  get diagnostics v_count = row_count;
  return v_count;
end
$function$;

alter function private_auth.issue_otp_challenge(uuid,text,text,smallint,text,text,uuid,uuid,uuid,uuid,uuid,uuid,text,integer,integer,text) owner to postgres;
alter function private_auth.get_otp_challenge_context(uuid) owner to postgres;
alter function private_auth.consume_otp_challenge(uuid,boolean) owner to postgres;
alter function private_auth.mark_otp_challenge_delivery(uuid,text) owner to postgres;
alter function private_auth.supersede_otp_challenges(uuid,uuid,text) owner to postgres;

revoke all on function private_auth.issue_otp_challenge(uuid,text,text,smallint,text,text,uuid,uuid,uuid,uuid,uuid,uuid,text,integer,integer,text) from public, anon, authenticated, service_role;
revoke all on function private_auth.get_otp_challenge_context(uuid) from public, anon, authenticated, service_role;
revoke all on function private_auth.consume_otp_challenge(uuid,boolean) from public, anon, authenticated, service_role;
revoke all on function private_auth.mark_otp_challenge_delivery(uuid,text) from public, anon, authenticated, service_role;
revoke all on function private_auth.supersede_otp_challenges(uuid,uuid,text) from public, anon, authenticated, service_role;

create or replace function public.service_issue_otp_challenge(
  p_challenge_id uuid,
  p_purpose text,
  p_channel text,
  p_pepper_version smallint,
  p_verifier_hmac_hex text,
  p_binding_fingerprint text,
  p_candidate_id uuid,
  p_client_id uuid,
  p_role_id uuid,
  p_submission_id uuid,
  p_interview_attempt_id uuid,
  p_recovery_authorization_id uuid,
  p_destination_fingerprint text,
  p_expires_in_seconds integer,
  p_max_attempts integer,
  p_delivery_state text
)
returns table(challenge_id uuid, expires_at timestamptz)
language sql
volatile
security definer
set search_path = ''
as $function$
  select * from private_auth.issue_otp_challenge(
    p_challenge_id, p_purpose, p_channel, p_pepper_version,
    p_verifier_hmac_hex, p_binding_fingerprint, p_candidate_id, p_client_id,
    p_role_id, p_submission_id, p_interview_attempt_id,
    p_recovery_authorization_id, p_destination_fingerprint,
    p_expires_in_seconds, p_max_attempts, p_delivery_state
  )
$function$;

create or replace function public.service_get_otp_challenge_context(p_challenge_id uuid)
returns table(
  challenge_id uuid, purpose text, channel text, pepper_version smallint,
  verifier_hmac_hex text, candidate_id uuid, client_id uuid, role_id uuid,
  submission_id uuid, interview_attempt_id uuid, recovery_authorization_id uuid,
  expires_at timestamptz, consumed_at timestamptz, superseded_at timestamptz,
  attempt_count integer, max_attempts integer
)
language sql
stable
security definer
set search_path = ''
as $function$
  select * from private_auth.get_otp_challenge_context(p_challenge_id)
$function$;

create or replace function public.service_consume_otp_challenge(p_challenge_id uuid, p_verifier_matches boolean)
returns table(status text, challenge_id uuid, candidate_id uuid, client_id uuid, role_id uuid, submission_id uuid, interview_attempt_id uuid)
language sql
volatile
security definer
set search_path = ''
as $function$
  select * from private_auth.consume_otp_challenge(p_challenge_id, p_verifier_matches)
$function$;

create or replace function public.service_mark_otp_challenge_delivery(p_challenge_id uuid, p_delivery_state text)
returns boolean
language sql
volatile
security definer
set search_path = ''
as $function$
  select private_auth.mark_otp_challenge_delivery(p_challenge_id, p_delivery_state)
$function$;

create or replace function public.service_supersede_otp_challenges(p_candidate_id uuid, p_role_id uuid, p_reason text)
returns bigint
language sql
volatile
security definer
set search_path = ''
as $function$
  select private_auth.supersede_otp_challenges(p_candidate_id, p_role_id, p_reason)
$function$;

alter function public.service_issue_otp_challenge(uuid,text,text,smallint,text,text,uuid,uuid,uuid,uuid,uuid,uuid,text,integer,integer,text) owner to postgres;
alter function public.service_get_otp_challenge_context(uuid) owner to postgres;
alter function public.service_consume_otp_challenge(uuid,boolean) owner to postgres;
alter function public.service_mark_otp_challenge_delivery(uuid,text) owner to postgres;
alter function public.service_supersede_otp_challenges(uuid,uuid,text) owner to postgres;

revoke all on function public.service_issue_otp_challenge(uuid,text,text,smallint,text,text,uuid,uuid,uuid,uuid,uuid,uuid,text,integer,integer,text) from public, anon, authenticated;
revoke all on function public.service_get_otp_challenge_context(uuid) from public, anon, authenticated;
revoke all on function public.service_consume_otp_challenge(uuid,boolean) from public, anon, authenticated;
revoke all on function public.service_mark_otp_challenge_delivery(uuid,text) from public, anon, authenticated;
revoke all on function public.service_supersede_otp_challenges(uuid,uuid,text) from public, anon, authenticated;
grant execute on function public.service_issue_otp_challenge(uuid,text,text,smallint,text,text,uuid,uuid,uuid,uuid,uuid,uuid,text,integer,integer,text) to service_role;
grant execute on function public.service_get_otp_challenge_context(uuid) to service_role;
grant execute on function public.service_consume_otp_challenge(uuid,boolean) to service_role;
grant execute on function public.service_mark_otp_challenge_delivery(uuid,text) to service_role;
grant execute on function public.service_supersede_otp_challenges(uuid,uuid,text) to service_role;

-- Permanently neutralize retained legacy rows without changing audit row counts.
update public.otp_tokens
set code = '[removed]',
    invalidated_at = coalesce(invalidated_at, statement_timestamp()),
    invalidation_reason = coalesce(invalidation_reason, 'durable_otp_cutover'),
    used = true,
    used_at = coalesce(used_at, statement_timestamp())
where code is distinct from '[removed]';

alter table public.otp_tokens drop constraint if exists otp_tokens_no_plaintext_code;
alter table public.otp_tokens
  add constraint otp_tokens_no_plaintext_code check (code = '[removed]');

commit;
