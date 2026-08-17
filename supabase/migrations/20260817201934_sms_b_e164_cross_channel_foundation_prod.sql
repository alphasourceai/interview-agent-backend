begin;

alter table public.candidates
  add column if not exists phone_e164 text null,
  add column if not exists phone_country_code text null;

do $constraints$
begin
  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conrelid = 'public.candidates'::regclass
      and conname = 'candidates_phone_e164_format_check'
  ) then
    alter table public.candidates add constraint candidates_phone_e164_format_check
      check (phone_e164 is null or phone_e164 ~ '^\+[1-9][0-9]{7,14}$');
  end if;
  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conrelid = 'public.candidates'::regclass
      and conname = 'candidates_phone_country_code_check'
  ) then
    alter table public.candidates add constraint candidates_phone_country_code_check
      check (phone_country_code is null or phone_country_code ~ '^[A-Z]{2}$');
  end if;
  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conrelid = 'public.candidates'::regclass
      and conname = 'candidates_canonical_phone_pair_check'
  ) then
    alter table public.candidates add constraint candidates_canonical_phone_pair_check
      check ((phone_e164 is null) = (phone_country_code is null));
  end if;
end
$constraints$;

comment on column public.candidates.phone_e164 is
  'Nullable backend-authoritative canonical E.164 identity. PII: never log or expose in general telemetry.';
comment on column public.candidates.phone_country_code is
  'Nullable ISO 3166-1 alpha-2 provenance for phone_e164.';

-- Deliberately no historical phone backfill. The SMS-B count-only QA audit found
-- no durable country-provenance column; a ten-digit shape alone is not proof of US provenance.

alter table private_auth.otp_challenges
  add column if not exists provider text null,
  add column if not exists provider_message_id text null,
  add column if not exists provider_delivery_status text null,
  add column if not exists send_requested_at timestamptz null,
  add column if not exists provider_accepted_at timestamptz null,
  add column if not exists sent_at timestamptz null,
  add column if not exists delivered_at timestamptz null,
  add column if not exists failed_at timestamptz null,
  add column if not exists failure_category text null,
  add column if not exists last_provider_event_id text null,
  add column if not exists last_provider_event_at timestamptz null,
  add column if not exists sms_selection_at timestamptz null,
  add column if not exists consent_copy_version text null;

do $constraints$
begin
  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conrelid = 'private_auth.otp_challenges'::regclass
      and conname = 'otp_challenges_provider_check'
  ) then
    alter table private_auth.otp_challenges add constraint otp_challenges_provider_check
      check (provider is null or provider ~ '^[a-z0-9_-]{1,40}$');
  end if;
  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conrelid = 'private_auth.otp_challenges'::regclass
      and conname = 'otp_challenges_provider_message_check'
  ) then
    alter table private_auth.otp_challenges add constraint otp_challenges_provider_message_check
      check (
        (provider_message_id is null or (provider is not null and char_length(provider_message_id) between 1 and 255))
        and (last_provider_event_id is null or char_length(last_provider_event_id) between 1 and 255)
      );
  end if;
  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conrelid = 'private_auth.otp_challenges'::regclass
      and conname = 'otp_challenges_provider_delivery_status_check'
  ) then
    alter table private_auth.otp_challenges add constraint otp_challenges_provider_delivery_status_check
      check (provider_delivery_status is null or provider_delivery_status in (
        'queued', 'sent', 'delivered', 'failed', 'undelivered', 'rejected'
      ));
  end if;
  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conrelid = 'private_auth.otp_challenges'::regclass
      and conname = 'otp_challenges_failure_category_check'
  ) then
    alter table private_auth.otp_challenges add constraint otp_challenges_failure_category_check
      check (failure_category is null or failure_category in (
        'invalid_destination', 'blocked_destination', 'provider_rejected',
        'transient_preacceptance', 'ambiguous_outcome', 'misconfigured',
        'delivery_failed', 'delivery_undelivered'
      ));
  end if;
  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conrelid = 'private_auth.otp_challenges'::regclass
      and conname = 'otp_challenges_sms_consent_check'
  ) then
    alter table private_auth.otp_challenges add constraint otp_challenges_sms_consent_check
      check (
        (channel = 'email' and sms_selection_at is null and consent_copy_version is null)
        or (channel = 'sms' and (
          (sms_selection_at is null and consent_copy_version is null)
          or (sms_selection_at is not null and consent_copy_version ~ '^[A-Za-z0-9._:-]{1,80}$')
        ))
      );
  end if;
end
$constraints$;

create unique index if not exists otp_challenges_provider_message_uidx
  on private_auth.otp_challenges (provider, provider_message_id)
  where provider_message_id is not null;

create table if not exists private_auth.sms_destination_suppressions (
  suppression_id uuid primary key default gen_random_uuid(),
  destination_fingerprint text not null check (destination_fingerprint ~ '^[0-9a-f]{64}$'),
  scope text not null default 'authentication' check (scope ~ '^[a-z0-9_:-]{1,40}$'),
  status text not null check (status in ('opted_out', 'admin_blocked', 'provider_blocked', 'abuse_blocked')),
  reason text null check (reason is null or char_length(reason) between 1 and 160),
  source text not null check (source ~ '^[a-z0-9_:-]{1,40}$'),
  source_event_id text null check (source_event_id is null or char_length(source_event_id) between 1 and 255),
  suppressed_at timestamptz not null default statement_timestamp(),
  released_at timestamptz null,
  created_at timestamptz not null default statement_timestamp(),
  updated_at timestamptz not null default statement_timestamp(),
  metadata jsonb not null default '{}'::jsonb,
  check (jsonb_typeof(metadata) = 'object' and octet_length(metadata::text) <= 2048),
  check (not (metadata ?| array['phone', 'phone_e164', 'to', 'destination', 'otp', 'code'])),
  check (released_at is null or released_at >= suppressed_at)
);

alter table private_auth.sms_destination_suppressions enable row level security;
alter table private_auth.sms_destination_suppressions owner to postgres;
revoke all privileges on table private_auth.sms_destination_suppressions from public, anon, authenticated, service_role;

create unique index if not exists sms_destination_suppressions_one_active_uidx
  on private_auth.sms_destination_suppressions (destination_fingerprint, scope)
  where released_at is null;
create index if not exists sms_destination_suppressions_status_idx
  on private_auth.sms_destination_suppressions (status, suppressed_at desc)
  where released_at is null;

comment on table private_auth.sms_destination_suppressions is
  'Provider-independent private SMS suppression ledger keyed only by a secret-derived canonical E.164 fingerprint.';

-- Collapse any pre-existing email+SMS dual-active state before establishing the
-- cross-channel invariant. The newest row wins deterministically.
with ranked_active as (
  select
    c.challenge_id,
    first_value(c.challenge_id) over (
      partition by c.purpose, c.candidate_id, c.client_id, c.role_id
      order by c.created_at desc, c.challenge_id desc
    ) as newest_challenge_id,
    row_number() over (
      partition by c.purpose, c.candidate_id, c.client_id, c.role_id
      order by c.created_at desc, c.challenge_id desc
    ) as active_rank
  from private_auth.otp_challenges c
  where c.consumed_at is null and c.superseded_at is null
)
update private_auth.otp_challenges c
set superseded_at = statement_timestamp(),
    superseded_by = ranked_active.newest_challenge_id,
    superseded_reason = 'cross_channel_replaced',
    updated_at = statement_timestamp()
from ranked_active
where c.challenge_id = ranked_active.challenge_id
  and ranked_active.active_rank > 1;

drop index if exists private_auth.otp_challenges_one_active_resource_uidx;
create unique index otp_challenges_one_active_resource_uidx
  on private_auth.otp_challenges (purpose, candidate_id, client_id, role_id)
  where consumed_at is null and superseded_at is null;

create or replace function private_auth.issue_otp_challenge_v2(
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
  p_delivery_state text,
  p_sms_selection_at timestamptz,
  p_consent_copy_version text
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
    or (p_channel = 'email' and (p_sms_selection_at is not null or p_consent_copy_version is not null))
    or (p_channel = 'sms' and (
      p_sms_selection_at is null
      or p_consent_copy_version !~ '^[A-Za-z0-9._:-]{1,80}$'
    ))
  then
    raise exception using errcode = '22023', message = 'invalid otp challenge input';
  end if;

  if not exists (
    select 1 from public.candidates c
    where c.id = p_candidate_id and c.client_id = p_client_id and c.role_id = p_role_id
  ) then
    raise exception using errcode = '23503', message = 'otp challenge binding is invalid';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      p_purpose || chr(31) || p_candidate_id::text || chr(31) ||
      p_client_id::text || chr(31) || p_role_id::text,
      0
    )
  );
  v_expires := v_now + pg_catalog.make_interval(secs => p_expires_in_seconds);

  update private_auth.otp_challenges c
  set superseded_at = v_now,
      superseded_by = p_challenge_id,
      superseded_reason = 'resource_replaced',
      updated_at = v_now
  where c.purpose = p_purpose
    and c.candidate_id = p_candidate_id
    and c.client_id = p_client_id
    and c.role_id = p_role_id
    and c.consumed_at is null
    and c.superseded_at is null;

  insert into private_auth.otp_challenges (
    challenge_id, purpose, channel, pepper_version, verifier_hmac,
    binding_fingerprint, candidate_id, client_id, role_id, submission_id,
    interview_attempt_id, recovery_authorization_id, destination_fingerprint,
    expires_at, max_attempts, delivery_state, sms_selection_at,
    consent_copy_version, created_at, updated_at
  ) values (
    p_challenge_id, p_purpose, p_channel, p_pepper_version,
    pg_catalog.decode(p_verifier_hmac_hex, 'hex'), p_binding_fingerprint,
    p_candidate_id, p_client_id, p_role_id, p_submission_id,
    p_interview_attempt_id, p_recovery_authorization_id,
    p_destination_fingerprint, v_expires, p_max_attempts, p_delivery_state,
    p_sms_selection_at, p_consent_copy_version, v_now, v_now
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
begin
  if p_channel <> 'email' then
    raise exception using errcode = '22023', message = 'sms requires the consent-bound issuance boundary';
  end if;
  return query select * from private_auth.issue_otp_challenge_v2(
    p_challenge_id, p_purpose, p_channel, p_pepper_version,
    p_verifier_hmac_hex, p_binding_fingerprint, p_candidate_id, p_client_id,
    p_role_id, p_submission_id, p_interview_attempt_id,
    p_recovery_authorization_id, p_destination_fingerprint,
    p_expires_in_seconds, p_max_attempts, p_delivery_state, null, null
  );
end
$function$;

create or replace function private_auth.issue_sms_otp_challenge(
  p_challenge_id uuid,
  p_purpose text,
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
  p_delivery_state text,
  p_sms_selection_at timestamptz,
  p_consent_copy_version text
)
returns table(challenge_id uuid, expires_at timestamptz)
language sql
volatile
security definer
set search_path = ''
as $function$
  select * from private_auth.issue_otp_challenge_v2(
    p_challenge_id, p_purpose, 'sms', p_pepper_version,
    p_verifier_hmac_hex, p_binding_fingerprint, p_candidate_id, p_client_id,
    p_role_id, p_submission_id, p_interview_attempt_id,
    p_recovery_authorization_id, p_destination_fingerprint,
    p_expires_in_seconds, p_max_attempts, p_delivery_state,
    p_sms_selection_at, p_consent_copy_version
  )
$function$;

create or replace function private_auth.is_sms_destination_suppressed(
  p_destination_fingerprint text,
  p_scope text
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select case
    when p_destination_fingerprint !~ '^[0-9a-f]{64}$'
      or coalesce(p_scope, '') !~ '^[a-z0-9_:-]{1,40}$'
    then true
    else exists (
      select 1 from private_auth.sms_destination_suppressions s
      where s.destination_fingerprint = p_destination_fingerprint
        and s.scope = p_scope
        and s.released_at is null
    )
  end
$function$;

create or replace function public.service_issue_sms_otp_challenge(
  p_challenge_id uuid,
  p_purpose text,
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
  p_delivery_state text,
  p_sms_selection_at timestamptz,
  p_consent_copy_version text
)
returns table(challenge_id uuid, expires_at timestamptz)
language sql
volatile
security definer
set search_path = ''
as $function$
  select * from private_auth.issue_sms_otp_challenge(
    p_challenge_id, p_purpose, p_pepper_version, p_verifier_hmac_hex,
    p_binding_fingerprint, p_candidate_id, p_client_id, p_role_id,
    p_submission_id, p_interview_attempt_id, p_recovery_authorization_id,
    p_destination_fingerprint, p_expires_in_seconds, p_max_attempts,
    p_delivery_state, p_sms_selection_at, p_consent_copy_version
  )
$function$;

create or replace function public.service_is_sms_destination_suppressed(
  p_destination_fingerprint text,
  p_scope text default 'authentication'
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select private_auth.is_sms_destination_suppressed(p_destination_fingerprint, p_scope)
$function$;

alter function private_auth.issue_otp_challenge_v2(uuid,text,text,smallint,text,text,uuid,uuid,uuid,uuid,uuid,uuid,text,integer,integer,text,timestamptz,text) owner to postgres;
alter function private_auth.issue_otp_challenge(uuid,text,text,smallint,text,text,uuid,uuid,uuid,uuid,uuid,uuid,text,integer,integer,text) owner to postgres;
alter function private_auth.issue_sms_otp_challenge(uuid,text,smallint,text,text,uuid,uuid,uuid,uuid,uuid,uuid,text,integer,integer,text,timestamptz,text) owner to postgres;
alter function private_auth.is_sms_destination_suppressed(text,text) owner to postgres;
alter function public.service_issue_sms_otp_challenge(uuid,text,smallint,text,text,uuid,uuid,uuid,uuid,uuid,uuid,text,integer,integer,text,timestamptz,text) owner to postgres;
alter function public.service_is_sms_destination_suppressed(text,text) owner to postgres;

revoke all on function private_auth.issue_otp_challenge_v2(uuid,text,text,smallint,text,text,uuid,uuid,uuid,uuid,uuid,uuid,text,integer,integer,text,timestamptz,text) from public, anon, authenticated, service_role;
revoke all on function private_auth.issue_otp_challenge(uuid,text,text,smallint,text,text,uuid,uuid,uuid,uuid,uuid,uuid,text,integer,integer,text) from public, anon, authenticated, service_role;
revoke all on function private_auth.issue_sms_otp_challenge(uuid,text,smallint,text,text,uuid,uuid,uuid,uuid,uuid,uuid,text,integer,integer,text,timestamptz,text) from public, anon, authenticated, service_role;
revoke all on function private_auth.is_sms_destination_suppressed(text,text) from public, anon, authenticated, service_role;

revoke all on function public.service_issue_sms_otp_challenge(uuid,text,smallint,text,text,uuid,uuid,uuid,uuid,uuid,uuid,text,integer,integer,text,timestamptz,text) from public, anon, authenticated;
revoke all on function public.service_is_sms_destination_suppressed(text,text) from public, anon, authenticated;
grant execute on function public.service_issue_sms_otp_challenge(uuid,text,smallint,text,text,uuid,uuid,uuid,uuid,uuid,uuid,text,integer,integer,text,timestamptz,text) to service_role;
grant execute on function public.service_is_sms_destination_suppressed(text,text) to service_role;

commit;
