begin;

alter table private_auth.otp_challenges
  add column if not exists recovery_reissued_at timestamptz null,
  add column if not exists recovery_replacement_challenge_id uuid null;

alter table private_auth.otp_challenges
  drop constraint if exists otp_challenges_recovery_claim_pair_check;
alter table private_auth.otp_challenges
  add constraint otp_challenges_recovery_claim_pair_check check (
    (recovery_reissued_at is null and recovery_replacement_challenge_id is null)
    or (recovery_reissued_at is not null and recovery_replacement_challenge_id is not null)
  );

create index if not exists otp_challenges_recovery_resource_idx
  on private_auth.otp_challenges (
    purpose, candidate_id, client_id, role_id, recovery_reissued_at desc
  )
  where recovery_reissued_at is not null;

comment on column private_auth.otp_challenges.recovery_reissued_at is
  'Atomic one-use marker for a consumed challenge recovery request.';
comment on column private_auth.otp_challenges.recovery_replacement_challenge_id is
  'Application-generated challenge identifier reserved by the consumed challenge recovery claim.';

create or replace function public.service_claim_consumed_otp_recovery(
  p_challenge_id uuid,
  p_replacement_challenge_id uuid
)
returns table(status text)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_now timestamptz := statement_timestamp();
  v_source private_auth.otp_challenges%rowtype;
begin
  if p_challenge_id is null
    or p_replacement_challenge_id is null
    or p_challenge_id = p_replacement_challenge_id
  then
    return query select 'not_claimed'::text;
    return;
  end if;

  select c.* into v_source
  from private_auth.otp_challenges c
  where c.challenge_id = p_challenge_id;

  if not found then
    return query select 'not_claimed'::text;
    return;
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      v_source.purpose || chr(31) || v_source.candidate_id::text || chr(31) ||
      v_source.client_id::text || chr(31) || v_source.role_id::text,
      0
    )
  );

  select c.* into v_source
  from private_auth.otp_challenges c
  where c.challenge_id = p_challenge_id
  for update;

  if not found
    or v_source.purpose <> 'interview_access'
    or v_source.consumed_at is null
    or v_source.consumed_at > v_now
    or v_source.consumed_at < v_now - interval '30 minutes'
    or v_source.superseded_at is not null
    or v_source.recovery_reissued_at is not null
    or exists (
      select 1
      from private_auth.otp_challenges recent
      where recent.purpose = v_source.purpose
        and recent.candidate_id = v_source.candidate_id
        and recent.client_id = v_source.client_id
        and recent.role_id = v_source.role_id
        and recent.recovery_reissued_at >= v_now - interval '60 seconds'
    )
    or exists (
      select 1
      from private_auth.otp_challenges replacement
      where replacement.challenge_id = p_replacement_challenge_id
    )
  then
    return query select 'not_claimed'::text;
    return;
  end if;

  update private_auth.otp_challenges c
  set recovery_reissued_at = v_now,
      recovery_replacement_challenge_id = p_replacement_challenge_id,
      updated_at = v_now
  where c.challenge_id = p_challenge_id;

  return query select 'claimed'::text;
end
$function$;

alter function public.service_claim_consumed_otp_recovery(uuid,uuid) owner to postgres;
revoke all on function public.service_claim_consumed_otp_recovery(uuid,uuid) from public, anon, authenticated;
grant execute on function public.service_claim_consumed_otp_recovery(uuid,uuid) to service_role;

commit;
