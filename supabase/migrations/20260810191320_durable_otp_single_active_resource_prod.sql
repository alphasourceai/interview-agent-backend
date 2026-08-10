begin;

with ranked_active as (
  select
    c.challenge_id,
    first_value(c.challenge_id) over (
      partition by c.purpose, c.channel, c.candidate_id, c.client_id, c.role_id
      order by c.created_at desc, c.challenge_id desc
    ) as newest_challenge_id,
    row_number() over (
      partition by c.purpose, c.channel, c.candidate_id, c.client_id, c.role_id
      order by c.created_at desc, c.challenge_id desc
    ) as active_rank
  from private_auth.otp_challenges c
  where c.consumed_at is null
    and c.superseded_at is null
)
update private_auth.otp_challenges c
set superseded_at = statement_timestamp(),
    superseded_by = ranked_active.newest_challenge_id,
    superseded_reason = 'resource_replaced',
    updated_at = statement_timestamp()
from ranked_active
where c.challenge_id = ranked_active.challenge_id
  and ranked_active.active_rank > 1;

drop index if exists private_auth.otp_challenges_one_active_binding_uidx;

create unique index if not exists otp_challenges_one_active_resource_uidx
  on private_auth.otp_challenges (
    purpose,
    channel,
    candidate_id,
    client_id,
    role_id
  )
  where consumed_at is null and superseded_at is null;

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

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      p_purpose || chr(31) || p_channel || chr(31) ||
      p_candidate_id::text || chr(31) || p_client_id::text || chr(31) || p_role_id::text,
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
    and c.channel = p_channel
    and c.candidate_id = p_candidate_id
    and c.client_id = p_client_id
    and c.role_id = p_role_id
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

alter function private_auth.issue_otp_challenge(uuid,text,text,smallint,text,text,uuid,uuid,uuid,uuid,uuid,uuid,text,integer,integer,text) owner to postgres;
revoke all on function private_auth.issue_otp_challenge(uuid,text,text,smallint,text,text,uuid,uuid,uuid,uuid,uuid,uuid,text,integer,integer,text) from public, anon, authenticated, service_role;

commit;
