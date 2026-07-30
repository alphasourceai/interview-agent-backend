-- alphaScreen candidate incident Phase B
-- Existing interviews rows remain the immutable attempt records. Historical
-- substantive evidence is deliberately left unknown unless it was already
-- recorded; the application evaluates preserved transcripts conservatively.

alter table public.interviews
  add column if not exists attempt_number integer,
  add column if not exists previous_attempt_id uuid null,
  add column if not exists replacement_authorization_id uuid null,
  add column if not exists is_active boolean not null default false,
  add column if not exists has_substantive_response boolean null,
  add column if not exists substantive_response_count integer null,
  add column if not exists candidate_utterance_count integer null,
  add column if not exists utterance_classification_counts jsonb not null default '{}'::jsonb,
  add column if not exists conversation_progress_state text null,
  add column if not exists replacement_eligible boolean null,
  add column if not exists replacement_eligibility_reason text null,
  add column if not exists reset_actor_user_id uuid null,
  add column if not exists reset_reason_code text null,
  add column if not exists reset_reason_detail text null,
  add column if not exists reset_at timestamptz null,
  add column if not exists reset_mode text null,
  add column if not exists effective_persona_id text null,
  add column if not exists effective_replica_id text null,
  add column if not exists effective_tavus_document_id text null,
  add column if not exists tavus_conversation_id text null,
  add column if not exists client_end_reason text null,
  add column if not exists vendor_end_reason text null,
  add column if not exists last_candidate_utterance_at timestamptz null,
  add column if not exists last_ai_utterance_at timestamptz null,
  add column if not exists watchdog_no_progress_at timestamptz null,
  add column if not exists reconnect_attempted boolean not null default false,
  add column if not exists reconnect_attempt_count integer not null default 0,
  add column if not exists reconnect_result text null,
  add column if not exists started_at timestamptz null,
  add column if not exists ended_at timestamptz null,
  add column if not exists last_vendor_event_at timestamptz null;

-- The pre-Phase-B schema allowed only one row for a candidate/role, so every
-- preserved row is deterministically attempt 1. No substantive classification
-- is inferred by this backfill.
update public.interviews
set attempt_number = 1
where attempt_number is null;

update public.interviews
set is_active = lower(coalesce(status, '')) in (
  'authorized', 'starting', 'pending', 'started', 'connected', 'in_progress', 'ending_requested'
);

alter table public.interviews
  alter column attempt_number set default 1,
  alter column attempt_number set not null;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'interviews_attempt_number_positive'
      and conrelid = 'public.interviews'::regclass
  ) then
    alter table public.interviews
      add constraint interviews_attempt_number_positive check (attempt_number > 0);
  end if;
  if not exists (
    select 1 from pg_constraint
    where conname = 'interviews_previous_attempt_id_fkey'
      and conrelid = 'public.interviews'::regclass
  ) then
    alter table public.interviews
      add constraint interviews_previous_attempt_id_fkey
      foreign key (previous_attempt_id) references public.interviews(id) on delete restrict;
  end if;
  if not exists (
    select 1 from pg_constraint
    where conname = 'interviews_previous_attempt_not_self'
      and conrelid = 'public.interviews'::regclass
  ) then
    alter table public.interviews
      add constraint interviews_previous_attempt_not_self
      check (previous_attempt_id is null or previous_attempt_id <> id);
  end if;
  if not exists (
    select 1 from pg_constraint
    where conname = 'interviews_substantive_response_count_nonnegative'
      and conrelid = 'public.interviews'::regclass
  ) then
    alter table public.interviews
      add constraint interviews_substantive_response_count_nonnegative
      check (substantive_response_count is null or substantive_response_count >= 0);
  end if;
  if not exists (
    select 1 from pg_constraint
    where conname = 'interviews_candidate_utterance_count_nonnegative'
      and conrelid = 'public.interviews'::regclass
  ) then
    alter table public.interviews
      add constraint interviews_candidate_utterance_count_nonnegative
      check (candidate_utterance_count is null or candidate_utterance_count >= 0);
  end if;
  if not exists (
    select 1 from pg_constraint
    where conname = 'interviews_reconnect_attempt_count_nonnegative'
      and conrelid = 'public.interviews'::regclass
  ) then
    alter table public.interviews
      add constraint interviews_reconnect_attempt_count_nonnegative
      check (reconnect_attempt_count >= 0);
  end if;
end
$$;

create unique index if not exists interviews_candidate_role_attempt_uidx
  on public.interviews (candidate_id, role_id, attempt_number)
  where candidate_id is not null and role_id is not null;

-- Replace the legacy one-row rule with an attempt-aware invariant. Dropping
-- this index removes no rows or historical artifacts.
drop index if exists public.uniq_interviews_candidate_role;

create unique index if not exists interviews_one_active_attempt_uidx
  on public.interviews (candidate_id, role_id)
  where is_active and candidate_id is not null and role_id is not null;

create index if not exists interviews_attempt_chain_idx
  on public.interviews (candidate_id, role_id, attempt_number desc, created_at desc);

create index if not exists interviews_previous_attempt_idx
  on public.interviews (previous_attempt_id)
  where previous_attempt_id is not null;

create table if not exists public.interview_reset_events (
  id uuid primary key default gen_random_uuid(),
  candidate_id uuid not null references public.candidates(id) on delete restrict,
  role_id uuid not null references public.roles(id) on delete restrict,
  client_id uuid not null references public.clients(id) on delete restrict,
  previous_interview_id uuid not null references public.interviews(id) on delete restrict,
  replacement_interview_id uuid null references public.interviews(id) on delete restrict,
  actor_user_id uuid not null,
  actor_email text null,
  reason_code text not null check (reason_code in (
    'technical_issue',
    'candidate_disconnected',
    'incorrect_candidate_information',
    'admin_approved_replacement',
    'resume_upload_problem',
    'other'
  )),
  reason_detail text null,
  reset_mode text not null check (reset_mode in ('reset_only', 'reset_and_send')),
  idempotency_key uuid not null,
  email_status text not null default 'not_requested' check (email_status in (
    'not_requested', 'pending', 'sending', 'sent', 'failed'
  )),
  email_claimed_at timestamptz null,
  email_sent_at timestamptz null,
  email_failed_at timestamptz null,
  email_failure_summary text null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (client_id, candidate_id, role_id, idempotency_key),
  unique (replacement_interview_id),
  check (reason_code <> 'other' or nullif(btrim(reason_detail), '') is not null)
);

alter table public.interview_reset_events enable row level security;

create index if not exists interview_reset_events_chain_idx
  on public.interview_reset_events (candidate_id, role_id, created_at desc);

create index if not exists interview_reset_events_previous_idx
  on public.interview_reset_events (previous_interview_id);

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'interviews_replacement_authorization_id_fkey'
      and conrelid = 'public.interviews'::regclass
  ) then
    alter table public.interviews
      add constraint interviews_replacement_authorization_id_fkey
      foreign key (replacement_authorization_id)
      references public.interview_reset_events(id) on delete restrict;
  end if;
end
$$;

create index if not exists interviews_replacement_authorization_idx
  on public.interviews (replacement_authorization_id)
  where replacement_authorization_id is not null;

create table if not exists public.interview_lifecycle_events (
  id uuid primary key default gen_random_uuid(),
  interview_id uuid not null references public.interviews(id) on delete restrict,
  client_id uuid not null references public.clients(id) on delete restrict,
  event_type text not null,
  vendor_event_id text null,
  dedupe_key text not null,
  speaker_role text null check (speaker_role is null or speaker_role in ('candidate', 'ai', 'system')),
  utterance_classification text null check (
    utterance_classification is null or utterance_classification in (
      'substantive_answer',
      'clarification_request',
      'repeat_request',
      'hearing_or_audio_issue',
      'acknowledgment',
      'filler',
      'technical_comment',
      'silence_or_empty',
      'unknown_non_substantive'
    )
  ),
  observed_at timestamptz null,
  received_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb,
  unique (interview_id, dedupe_key)
);

alter table public.interview_lifecycle_events enable row level security;

create unique index if not exists interview_lifecycle_vendor_event_uidx
  on public.interview_lifecycle_events (interview_id, vendor_event_id)
  where vendor_event_id is not null;

create index if not exists interview_lifecycle_events_received_idx
  on public.interview_lifecycle_events (interview_id, received_at desc);

alter table public.otp_tokens
  add column if not exists candidate_id uuid null references public.candidates(id) on delete restrict,
  add column if not exists interview_id uuid null references public.interviews(id) on delete restrict,
  add column if not exists invalidated_at timestamptz null,
  add column if not exists invalidation_reason text null;

create index if not exists otp_tokens_candidate_attempt_idx
  on public.otp_tokens (candidate_id, interview_id, created_at desc);

alter table public.reports
  add column if not exists interview_id uuid null references public.interviews(id) on delete restrict;

create index if not exists reports_interview_id_idx
  on public.reports (interview_id)
  where interview_id is not null;

create or replace function public.sync_interview_attempt_active_state()
returns trigger
language plpgsql
as $$
begin
  new.is_active := lower(coalesce(new.status, '')) in (
    'authorized', 'starting', 'pending', 'started', 'connected', 'in_progress', 'ending_requested'
  );
  if not new.is_active and lower(coalesce(new.status, '')) in (
    'ended', 'incomplete', 'failed', 'disconnected', 'completed', 'complete',
    'analyzed', 'readyforanalysis', 'ready for analysis', 'transcribed', 'transcriptionreceived'
  ) then
    new.ended_at := coalesce(new.ended_at, now());
  end if;
  return new;
end
$$;

drop trigger if exists sync_interview_attempt_active_state on public.interviews;
create trigger sync_interview_attempt_active_state
before insert or update of status on public.interviews
for each row execute function public.sync_interview_attempt_active_state();

create or replace function public.protect_interview_attempt_identity()
returns trigger
language plpgsql
as $$
begin
  if new.candidate_id is distinct from old.candidate_id
    or new.role_id is distinct from old.role_id
    or new.client_id is distinct from old.client_id
    or new.attempt_number is distinct from old.attempt_number
    or new.previous_attempt_id is distinct from old.previous_attempt_id
    or new.replacement_authorization_id is distinct from old.replacement_authorization_id then
    raise exception using errcode = '23514', message = 'interview_attempt_identity_immutable';
  end if;

  if (old.tavus_application_id is not null and new.tavus_application_id is distinct from old.tavus_application_id)
    or (old.tavus_conversation_id is not null and new.tavus_conversation_id is distinct from old.tavus_conversation_id)
    or (old.effective_persona_id is not null and new.effective_persona_id is distinct from old.effective_persona_id)
    or (old.effective_replica_id is not null and new.effective_replica_id is distinct from old.effective_replica_id)
    or (old.effective_tavus_document_id is not null and new.effective_tavus_document_id is distinct from old.effective_tavus_document_id) then
    raise exception using errcode = '23514', message = 'interview_vendor_identity_immutable';
  end if;
  return new;
end
$$;

drop trigger if exists protect_interview_attempt_identity on public.interviews;
create trigger protect_interview_attempt_identity
before update on public.interviews
for each row execute function public.protect_interview_attempt_identity();

create or replace function public.claim_candidate_interview_attempt(
  p_candidate_id uuid,
  p_role_id uuid,
  p_client_id uuid
)
returns table (interview_id uuid, attempt_number integer, authorized_replacement boolean)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_candidate public.candidates%rowtype;
  v_active public.interviews%rowtype;
  v_attempt_count integer;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_candidate_id::text || ':' || p_role_id::text, 0));

  select * into v_candidate
  from public.candidates
  where id = p_candidate_id
  for update;

  if not found or v_candidate.role_id is distinct from p_role_id or v_candidate.client_id is distinct from p_client_id then
    raise exception using errcode = 'P0001', message = 'candidate_interview_state_requires_review';
  end if;

  if lower(coalesce(v_candidate.status, '')) like '%interview completed%'
    or lower(coalesce(v_candidate.interview_status, '')) like '%interview completed%' then
    raise exception using errcode = 'P0001', message = 'completed_interview_retake_blocked';
  end if;

  if exists (
    select 1 from public.interviews
    where candidate_id = p_candidate_id
      and role_id = p_role_id
      and lower(coalesce(status, '')) in ('completed', 'complete', 'analyzed')
      and has_substantive_response is true
  ) then
    raise exception using errcode = 'P0001', message = 'completed_interview_retake_blocked';
  end if;

  if exists (
    select 1 from public.interviews
    where candidate_id = p_candidate_id
      and role_id = p_role_id
      and lower(coalesce(status, '')) in ('completed', 'complete', 'analyzed')
      and has_substantive_response is null
  ) then
    raise exception using errcode = 'P0001', message = 'candidate_interview_state_requires_review';
  end if;

  select * into v_active
  from public.interviews
  where candidate_id = p_candidate_id
    and role_id = p_role_id
    and is_active
  order by attempt_number desc
  limit 1
  for update;

  if found then
    if lower(coalesce(v_active.status, '')) = 'authorized'
      and v_active.replacement_authorization_id is not null then
      update public.interviews
      set status = 'Starting',
          started_at = coalesce(started_at, now()),
          updated_at = now()
      where id = v_active.id;
      return query select v_active.id, v_active.attempt_number, true;
      return;
    end if;
    raise exception using errcode = 'P0001', message = 'active_interview_attempt_exists';
  end if;

  select count(*)::integer into v_attempt_count
  from public.interviews
  where candidate_id = p_candidate_id and role_id = p_role_id;

  if v_attempt_count > 0 then
    raise exception using errcode = 'P0001', message = 'replacement_not_authorized';
  end if;

  return query
  insert into public.interviews (
    candidate_id, role_id, client_id, attempt_number, status, is_active,
    has_substantive_response, substantive_response_count, candidate_utterance_count,
    conversation_progress_state, started_at
  ) values (
    p_candidate_id, p_role_id, p_client_id, 1, 'Starting', true,
    false, 0, 0, 'WaitingForAnswer', now()
  )
  returning id, public.interviews.attempt_number, false;
end
$$;

create or replace function public.authorize_interview_replacement(
  p_candidate_id uuid,
  p_role_id uuid,
  p_client_id uuid,
  p_actor_user_id uuid,
  p_actor_email text,
  p_reason_code text,
  p_reason_detail text,
  p_reset_mode text,
  p_idempotency_key uuid
)
returns table (
  reset_event_id uuid,
  replacement_interview_id uuid,
  attempt_number integer,
  replayed boolean,
  stale_credentials_invalidated integer
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_candidate public.candidates%rowtype;
  v_latest public.interviews%rowtype;
  v_existing public.interview_reset_events%rowtype;
  v_reset_id uuid;
  v_replacement_id uuid;
  v_attempt_number integer;
  v_invalidated integer := 0;
  v_reason text := lower(btrim(coalesce(p_reason_code, '')));
  v_mode text := lower(btrim(coalesce(p_reset_mode, '')));
begin
  if v_reason not in (
    'technical_issue', 'candidate_disconnected', 'incorrect_candidate_information',
    'admin_approved_replacement', 'resume_upload_problem', 'other'
  ) then
    raise exception using errcode = 'P0001', message = 'interview_reset_reason_required';
  end if;
  if v_reason = 'other' and nullif(btrim(coalesce(p_reason_detail, '')), '') is null then
    raise exception using errcode = 'P0001', message = 'interview_reset_other_detail_required';
  end if;
  if v_mode not in ('reset_only', 'reset_and_send') or p_idempotency_key is null then
    raise exception using errcode = 'P0001', message = 'reset_request_conflict';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_candidate_id::text || ':' || p_role_id::text, 0));

  select * into v_existing
  from public.interview_reset_events
  where client_id = p_client_id
    and candidate_id = p_candidate_id
    and role_id = p_role_id
    and idempotency_key = p_idempotency_key;
  if found then
    return query select v_existing.id, v_existing.replacement_interview_id,
      (select i.attempt_number from public.interviews i where i.id = v_existing.replacement_interview_id),
      true, 0;
    return;
  end if;

  select * into v_candidate
  from public.candidates
  where id = p_candidate_id
  for update;
  if not found or v_candidate.role_id is distinct from p_role_id or v_candidate.client_id is distinct from p_client_id then
    raise exception using errcode = 'P0001', message = 'interview_reset_not_eligible';
  end if;

  if lower(coalesce(v_candidate.status, '')) like '%interview completed%'
    or lower(coalesce(v_candidate.interview_status, '')) like '%interview completed%' then
    raise exception using errcode = 'P0001', message = 'completed_interview_retake_blocked';
  end if;

  if exists (
    select 1 from public.interviews
    where candidate_id = p_candidate_id
      and role_id = p_role_id
      and lower(coalesce(status, '')) in ('completed', 'complete', 'analyzed')
      and has_substantive_response is true
  ) then
    raise exception using errcode = 'P0001', message = 'completed_interview_retake_blocked';
  end if;

  if exists (
    select 1 from public.interviews
    where candidate_id = p_candidate_id
      and role_id = p_role_id
      and lower(coalesce(status, '')) in ('completed', 'complete', 'analyzed')
      and has_substantive_response is null
  ) then
    raise exception using errcode = 'P0001', message = 'candidate_interview_state_requires_review';
  end if;

  if exists (
    select 1 from public.interviews
    where candidate_id = p_candidate_id and role_id = p_role_id and is_active
  ) then
    raise exception using errcode = 'P0001', message = 'active_interview_attempt_exists';
  end if;

  if exists (
    select 1 from public.interview_reset_events
    where candidate_id = p_candidate_id and role_id = p_role_id
  ) then
    raise exception using errcode = 'P0001', message = 'replacement_already_used';
  end if;

  select * into v_latest
  from public.interviews
  where candidate_id = p_candidate_id and role_id = p_role_id
  order by attempt_number desc, created_at desc
  limit 1
  for update;

  if not found then
    raise exception using errcode = 'P0001', message = 'replacement_not_authorized';
  end if;

  if not (
    lower(coalesce(v_latest.status, '')) in ('incomplete', 'failed', 'disconnected')
    or (
      lower(coalesce(v_latest.status, '')) in ('ended', 'transcriptionreceived')
      and (v_latest.has_substantive_response is false or v_latest.retryable is true or v_latest.replacement_eligible is true)
    )
    or v_latest.retryable is true
    or v_latest.replacement_eligible is true
  ) then
    if v_latest.has_substantive_response is null then
      raise exception using errcode = 'P0001', message = 'candidate_interview_state_requires_review';
    end if;
    raise exception using errcode = 'P0001', message = 'interview_reset_not_eligible';
  end if;

  v_attempt_number := v_latest.attempt_number + 1;

  insert into public.interview_reset_events (
    candidate_id, role_id, client_id, previous_interview_id,
    actor_user_id, actor_email, reason_code, reason_detail, reset_mode,
    idempotency_key, email_status
  ) values (
    p_candidate_id, p_role_id, p_client_id, v_latest.id,
    p_actor_user_id, nullif(btrim(coalesce(p_actor_email, '')), ''), v_reason,
    nullif(btrim(coalesce(p_reason_detail, '')), ''), v_mode,
    p_idempotency_key,
    case when v_mode = 'reset_and_send' then 'pending' else 'not_requested' end
  ) returning id into v_reset_id;

  insert into public.interviews (
    candidate_id, role_id, client_id, attempt_number, previous_attempt_id,
    replacement_authorization_id, status, is_active,
    has_substantive_response, substantive_response_count, candidate_utterance_count,
    conversation_progress_state, replacement_eligible,
    reset_actor_user_id, reset_reason_code, reset_reason_detail, reset_at, reset_mode
  ) values (
    p_candidate_id, p_role_id, p_client_id, v_attempt_number, v_latest.id,
    v_reset_id, 'Authorized', true,
    false, 0, 0, 'WaitingForAnswer', false,
    p_actor_user_id, v_reason, nullif(btrim(coalesce(p_reason_detail, '')), ''), now(), v_mode
  ) returning id into v_replacement_id;

  update public.interview_reset_events
  set replacement_interview_id = v_replacement_id, updated_at = now()
  where id = v_reset_id;

  update public.otp_tokens
  set invalidated_at = now(),
      invalidation_reason = 'stale_access_invalidated'
  where candidate_email = lower(v_candidate.email)
    and role_id = p_role_id
    and used is false
    and invalidated_at is null;
  get diagnostics v_invalidated = row_count;

  return query select v_reset_id, v_replacement_id, v_attempt_number, false, v_invalidated;
end
$$;

create or replace function public.claim_interview_reset_email(p_reset_event_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_claimed boolean;
begin
  update public.interview_reset_events
  set email_status = 'sending', email_claimed_at = now(), updated_at = now()
  where id = p_reset_event_id and reset_mode = 'reset_and_send' and email_status = 'pending'
  returning true into v_claimed;
  return coalesce(v_claimed, false);
end
$$;

create or replace function public.record_interview_lifecycle_event(
  p_interview_id uuid,
  p_client_id uuid,
  p_event_type text,
  p_vendor_event_id text,
  p_dedupe_key text,
  p_speaker_role text,
  p_utterance_classification text,
  p_observed_at timestamptz,
  p_metadata jsonb default '{}'::jsonb
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_event_id uuid;
  v_observed_at timestamptz := coalesce(p_observed_at, now());
  v_classification text := nullif(btrim(coalesce(p_utterance_classification, '')), '');
begin
  insert into public.interview_lifecycle_events (
    interview_id, client_id, event_type, vendor_event_id, dedupe_key,
    speaker_role, utterance_classification, observed_at, metadata
  ) values (
    p_interview_id, p_client_id, left(coalesce(p_event_type, 'unknown'), 80),
    nullif(left(coalesce(p_vendor_event_id, ''), 200), ''), left(p_dedupe_key, 300),
    nullif(p_speaker_role, ''), v_classification, v_observed_at, coalesce(p_metadata, '{}'::jsonb)
  )
  on conflict do nothing
  returning id into v_event_id;

  if v_event_id is null then
    return false;
  end if;

  if p_speaker_role = 'candidate' then
    update public.interviews
    set last_candidate_utterance_at = greatest(coalesce(last_candidate_utterance_at, v_observed_at), v_observed_at),
        candidate_utterance_count = coalesce(candidate_utterance_count, 0) + 1,
        substantive_response_count = coalesce(substantive_response_count, 0)
          + case when v_classification = 'substantive_answer' then 1 else 0 end,
        has_substantive_response = case
          when v_classification = 'substantive_answer' then true
          else coalesce(has_substantive_response, false)
        end,
        utterance_classification_counts = coalesce(utterance_classification_counts, '{}'::jsonb)
          || jsonb_build_object(
            coalesce(v_classification, 'unknown_non_substantive'),
            coalesce((utterance_classification_counts ->> coalesce(v_classification, 'unknown_non_substantive'))::integer, 0) + 1
          ),
        conversation_progress_state = case
          when v_classification = 'substantive_answer' then 'CandidateResponded'
          when v_classification in ('clarification_request', 'repeat_request', 'hearing_or_audio_issue') then 'ClarificationRequested'
          else coalesce(conversation_progress_state, 'WaitingForAnswer')
        end,
        updated_at = now()
    where id = p_interview_id and client_id = p_client_id;
  elsif p_speaker_role = 'ai' then
    update public.interviews
    set last_ai_utterance_at = greatest(coalesce(last_ai_utterance_at, v_observed_at), v_observed_at),
        conversation_progress_state = case
          when conversation_progress_state = 'ClarificationRequested' then 'QuestionRepeated'
          when conversation_progress_state = 'QuestionRepeated' then 'WaitingAfterRepeat'
          else coalesce(conversation_progress_state, 'WaitingForAnswer')
        end,
        updated_at = now()
    where id = p_interview_id and client_id = p_client_id;
  else
    update public.interviews
    set last_vendor_event_at = greatest(coalesce(last_vendor_event_at, v_observed_at), v_observed_at),
        updated_at = now()
    where id = p_interview_id and client_id = p_client_id;
  end if;

  return true;
end
$$;

revoke all on table public.interview_reset_events from anon, authenticated;
revoke all on table public.interview_lifecycle_events from anon, authenticated;
revoke all on function public.claim_candidate_interview_attempt(uuid, uuid, uuid) from public, anon, authenticated;
revoke all on function public.authorize_interview_replacement(uuid, uuid, uuid, uuid, text, text, text, text, uuid) from public, anon, authenticated;
revoke all on function public.claim_interview_reset_email(uuid) from public, anon, authenticated;
revoke all on function public.record_interview_lifecycle_event(uuid, uuid, text, text, text, text, text, timestamptz, jsonb) from public, anon, authenticated;

grant all on table public.interview_reset_events to service_role;
grant all on table public.interview_lifecycle_events to service_role;
grant execute on function public.claim_candidate_interview_attempt(uuid, uuid, uuid) to service_role;
grant execute on function public.authorize_interview_replacement(uuid, uuid, uuid, uuid, text, text, text, text, uuid) to service_role;
grant execute on function public.claim_interview_reset_email(uuid) to service_role;
grant execute on function public.record_interview_lifecycle_event(uuid, uuid, text, text, text, text, text, timestamptz, jsonb) to service_role;

comment on table public.interview_reset_events is
  'Immutable admin authorization and delivery audit for one replacement interview attempt.';
comment on table public.interview_lifecycle_events is
  'Bounded, deduplicated interview lifecycle telemetry; full transcript text is not stored here.';
