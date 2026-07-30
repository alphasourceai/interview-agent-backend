-- alphaScreen Phase B-Core: manual recovery for interrupted/incomplete video
-- interviews. This migration is additive to Phase B. It deliberately performs
-- no UPDATE/backfill of historical interviews, reports, transcripts, recordings,
-- or completion classifications.

alter table public.interviews
  add column if not exists attempt_mode text null,
  add column if not exists recovery_start_attempt_count integer not null default 0,
  add column if not exists vendor_start_state text null,
  add column if not exists vendor_operation text null,
  add column if not exists vendor_external_reference text null,
  add column if not exists vendor_create_claim_token uuid null,
  add column if not exists vendor_create_started_at timestamptz null,
  add column if not exists vendor_ambiguous_at timestamptz null,
  add column if not exists vendor_failure_category text null,
  add column if not exists vendor_failure_code text null,
  add column if not exists vendor_reconciliation_status text null,
  add column if not exists vendor_reconciliation_attempt_count integer null,
  add column if not exists vendor_reconciliation_claim_token uuid null,
  add column if not exists vendor_reconciliation_last_at timestamptz null,
  add column if not exists vendor_reconciliation_resolved_at timestamptz null,
  add column if not exists vendor_resolution_source text null,
  add column if not exists vendor_manual_review boolean null,
  add column if not exists vendor_reconciliation_total_exact_match_count integer null,
  add column if not exists vendor_reconciliation_stored_match_reference_count integer null,
  add column if not exists vendor_reconciliation_match_references_truncated boolean null,
  add column if not exists vendor_reconciliation_match_references text[] null,
  add column if not exists vendor_reconciliation_scan_complete boolean null,
  add column if not exists vendor_reconciliation_scan_status text null,
  add column if not exists vendor_reconciliation_pages_requested integer null,
  add column if not exists vendor_reconciliation_pages_completed integer null,
  add column if not exists vendor_reconciliation_total_count_reported integer null,
  add column if not exists vendor_binding_recovery_required boolean null,
  add column if not exists vendor_binding_recovery_recorded_at timestamptz null;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'interviews_recovery_core_attempt_mode_check'
      and conrelid = 'public.interviews'::regclass
  ) then
    alter table public.interviews add constraint interviews_recovery_core_attempt_mode_check
      check (attempt_mode is null or attempt_mode in ('video', 'text', 'text_accommodation'));
  end if;
  if not exists (
    select 1 from pg_constraint
    where conname = 'interviews_recovery_start_attempt_count_check'
      and conrelid = 'public.interviews'::regclass
  ) then
    alter table public.interviews add constraint interviews_recovery_start_attempt_count_check
      check (recovery_start_attempt_count between 0 and 3);
  end if;
  if not exists (
    select 1 from pg_constraint
    where conname = 'interviews_vendor_reconciliation_bounds_check'
      and conrelid = 'public.interviews'::regclass
  ) then
    alter table public.interviews add constraint interviews_vendor_reconciliation_bounds_check check (
      (vendor_start_state is null or vendor_start_state in (
        'claimed', 'definite_failure', 'reconciliation_required', 'reconciling',
        'binding_recovery_required', 'started', 'manual_review'
      )) and
      (vendor_operation is null or vendor_operation = 'create_conversation') and
      (vendor_external_reference is null or (
        char_length(vendor_external_reference) between 1 and 100 and
        vendor_external_reference ~ '^alphascreen-interview-[0-9a-f-]{36}$'
      )) and
      (vendor_failure_category is null or vendor_failure_category in (
        'definite_pre_acceptance', 'ambiguous_acceptance'
      )) and
      (vendor_failure_code is null or char_length(vendor_failure_code) <= 100) and
      (vendor_reconciliation_status is null or vendor_reconciliation_status in (
        'required', 'in_progress', 'no_match_pending', 'resolved',
        'multiple_matches', 'unavailable', 'binding_recovery_required'
      )) and
      (vendor_reconciliation_attempt_count is null or vendor_reconciliation_attempt_count between 0 and 20) and
      (vendor_resolution_source is null or char_length(vendor_resolution_source) <= 80) and
      (vendor_reconciliation_total_exact_match_count is null or vendor_reconciliation_total_exact_match_count >= 0) and
      (vendor_reconciliation_stored_match_reference_count is null or vendor_reconciliation_stored_match_reference_count between 0 and 10) and
      (vendor_reconciliation_match_references is null or (
        cardinality(vendor_reconciliation_match_references) <= 10 and
        octet_length(array_to_string(vendor_reconciliation_match_references, ',')) <= 2200
      )) and
      (vendor_reconciliation_scan_status is null or vendor_reconciliation_scan_status in (
        'complete', 'incomplete_missing_total', 'incomplete_unstable_total',
        'incomplete_repeated_page', 'incomplete_malformed_page',
        'incomplete_short_page', 'incomplete_page_limit',
        'incomplete_multi_page_unsupported', 'unavailable'
      )) and
      (vendor_reconciliation_pages_requested is null or vendor_reconciliation_pages_requested between 0 and 25) and
      (vendor_reconciliation_pages_completed is null or vendor_reconciliation_pages_completed between 0 and 25) and
      (vendor_reconciliation_pages_requested is null or vendor_reconciliation_pages_completed is null
        or vendor_reconciliation_pages_completed <= vendor_reconciliation_pages_requested) and
      (vendor_reconciliation_total_count_reported is null or vendor_reconciliation_total_count_reported >= 0)
    );
  end if;
end
$$;

alter table public.interview_reset_events
  add column if not exists adjudication_id uuid null,
  add column if not exists authorization_status text not null default 'authorized',
  add column if not exists consumed_at timestamptz null,
  add column if not exists expires_at timestamptz null,
  add column if not exists request_fingerprint text null,
  add column if not exists required_coverage_attested boolean not null default false,
  add column if not exists client_approval_status text not null default 'not_recorded',
  add column if not exists start_status text not null default 'not_started',
  add column if not exists start_attempt_count integer not null default 0,
  add column if not exists start_last_failed_at timestamptz null,
  add column if not exists start_last_failure_code text null,
  add column if not exists email_claim_token uuid null,
  add column if not exists email_claim_expires_at timestamptz null,
  add column if not exists email_attempt_count integer not null default 0;

alter table public.interview_reset_events
  drop constraint if exists interview_reset_events_reason_code_check;
alter table public.interview_reset_events
  add constraint interview_reset_events_reason_code_check check (reason_code in (
    'candidate_network_disconnect',
    'unknown_early_termination',
    'no_substantive_response',
    'partial_interview',
    'vendor_start_failure',
    'client_approved_exception',
    'other',
    -- Retained so a later decomposed B2R migration can read Phase B rows.
    'technical_issue',
    'candidate_disconnected',
    'incorrect_candidate_information',
    'admin_approved_replacement',
    'resume_upload_problem'
  ));

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'interview_reset_events_core_authorization_status_check'
      and conrelid = 'public.interview_reset_events'::regclass
  ) then
    alter table public.interview_reset_events
      add constraint interview_reset_events_core_authorization_status_check
      check (authorization_status in ('authorized', 'consumed', 'revoked'));
  end if;
  if not exists (
    select 1 from pg_constraint
    where conname = 'interview_reset_events_core_client_approval_check'
      and conrelid = 'public.interview_reset_events'::regclass
  ) then
    alter table public.interview_reset_events
      add constraint interview_reset_events_core_client_approval_check
      check (client_approval_status in ('not_recorded', 'acknowledged'));
  end if;
  if not exists (
    select 1 from pg_constraint
    where conname = 'interview_reset_events_core_start_status_check'
      and conrelid = 'public.interview_reset_events'::regclass
  ) then
    alter table public.interview_reset_events
      add constraint interview_reset_events_core_start_status_check
      check (start_status in (
        'not_started', 'starting', 'started', 'failed_retryable', 'failed_terminal',
        'reconciliation_required', 'reconciling', 'binding_recovery_required', 'manual_review'
      ));
  end if;
  if not exists (
    select 1 from pg_constraint
    where conname = 'interview_reset_events_core_bounds_check'
      and conrelid = 'public.interview_reset_events'::regclass
  ) then
    alter table public.interview_reset_events
      add constraint interview_reset_events_core_bounds_check check (
        (request_fingerprint is null or request_fingerprint ~ '^[a-f0-9]{64}$') and
        char_length(coalesce(reason_detail, '')) <= 500 and
        start_attempt_count between 0 and 3 and
        email_attempt_count between 0 and 3 and
        (start_last_failure_code is null or char_length(start_last_failure_code) <= 100)
      );
  end if;
end
$$;

create table if not exists public.interview_adjudications (
  id uuid primary key default gen_random_uuid(),
  actor_user_id uuid not null,
  actor_role text not null check (actor_role in ('admin', 'super_admin', 'system')),
  actor_email text null,
  client_id uuid not null references public.clients(id) on delete restrict,
  role_id uuid not null references public.roles(id) on delete restrict,
  candidate_id uuid not null references public.candidates(id) on delete restrict,
  interview_id uuid not null references public.interviews(id) on delete restrict,
  attempt_number integer not null check (attempt_number > 0),
  previous_system_outcome text not null,
  prior_system_state jsonb not null default '{}'::jsonb,
  decision text not null check (decision in (
    'authorize_one_video_replacement', 'deny_video_replacement',
    'replacement_authorized', 'replacement_denied', 'outcome_reviewed',
    'complete_with_late_interruption', 'retain_review_gated', 'processing_invalid',
    'report_marked_partial', 'report_approved_complete', 'report_rejected_normal_use',
    'historical_record_reviewed', 'candidate_ended_classification_accepted',
    'manual_report_access_approved', 'manual_eligibility_decision'
  )),
  reason_code text not null check (char_length(reason_code) between 1 and 80),
  reason_detail text null check (reason_detail is null or char_length(reason_detail) <= 500),
  required_coverage_attested boolean not null default false,
  client_approval_status text not null default 'not_recorded'
    check (client_approval_status in ('not_recorded', 'acknowledged')),
  resulting_eligibility_decision text null
    check (resulting_eligibility_decision is null or char_length(resulting_eligibility_decision) <= 80),
  request_id text not null check (char_length(request_id) between 1 and 200),
  request_fingerprint text not null check (request_fingerprint ~ '^[a-f0-9]{64}$'),
  audit_log_id uuid null,
  created_at timestamptz not null default now(),
  unique (interview_id, request_id, decision),
  check (octet_length(prior_system_state::text) <= 16384)
);

alter table public.interview_adjudications enable row level security;

create table if not exists public.interview_admin_audit_logs (
  id uuid primary key default gen_random_uuid(),
  actor_user_id uuid null,
  actor_role text not null check (char_length(actor_role) between 1 and 40),
  actor_email text null,
  client_id uuid not null references public.clients(id) on delete restrict,
  role_id uuid null references public.roles(id) on delete restrict,
  candidate_id uuid null references public.candidates(id) on delete restrict,
  interview_id uuid null references public.interviews(id) on delete restrict,
  attempt_number integer null check (attempt_number is null or attempt_number > 0),
  action text not null,
  prior_state jsonb not null default '{}'::jsonb,
  resulting_state jsonb not null default '{}'::jsonb,
  reason_code text null check (reason_code is null or char_length(reason_code) <= 80),
  request_id text not null check (char_length(request_id) between 1 and 200),
  success boolean not null,
  related_adjudication_id uuid null references public.interview_adjudications(id) on delete restrict,
  related_reset_id uuid null references public.interview_reset_events(id) on delete restrict,
  created_at timestamptz not null default now(),
  unique (action, request_id),
  constraint interview_admin_audit_logs_action_check check (action in (
    'replacement_authorized', 'replacement_denied', 'reset_only', 'reset_and_send',
    'authorization_consumed', 'authorization_revoked', 'replacement_attempt_created',
    'replacement_start_failed', 'replacement_start_succeeded',
    'recovery_email_claimed', 'recovery_email_sent', 'recovery_email_failed',
    'admin_review_opened', 'admin_review_completed', 'stale_access_invalidated',
    'retake_blocked', 'report_marked_partial', 'report_approved_normal_use',
    'report_rejected_normal_use', 'historical_reconciliation',
    'manual_eligibility_decision', 'recovery_email_lease_reclaimed',
    'recovery_email_permanently_failed',
    'vendor_create_claimed', 'vendor_create_definite_failure', 'vendor_create_ambiguous',
    'vendor_reconciliation_started', 'vendor_reconciliation_resolved',
    'vendor_reconciliation_no_match', 'vendor_reconciliation_multiple_matches',
    'vendor_reconciliation_unavailable', 'vendor_start_succeeded',
    'provider_create_succeeded_bind_failed', 'vendor_binding_recovery_started',
    'vendor_binding_recovery_resolved', 'vendor_binding_recovery_conflict'
  )),
  check (octet_length(prior_state::text) <= 16384),
  check (octet_length(resulting_state::text) <= 16384)
);

alter table public.interview_admin_audit_logs enable row level security;

create schema if not exists private;

create table if not exists private.interview_vendor_binding_recovery (
  interview_id uuid primary key references public.interviews(id) on delete restrict,
  authorization_id uuid not null unique references public.interview_reset_events(id) on delete restrict,
  vendor_create_claim_token uuid not null,
  vendor_external_reference text not null
    check (vendor_external_reference ~ '^alphascreen-interview-[0-9a-f-]{36}$'),
  vendor_conversation_id text not null
    check (char_length(vendor_conversation_id) between 1 and 200),
  vendor_conversation_url text not null
    check (char_length(vendor_conversation_url) between 1 and 1000),
  effective_persona_id text null check (effective_persona_id is null or char_length(effective_persona_id) <= 200),
  effective_replica_id text null check (effective_replica_id is null or char_length(effective_replica_id) <= 200),
  effective_document_id text null check (effective_document_id is null or char_length(effective_document_id) <= 200),
  failure_code text not null check (char_length(failure_code) between 1 and 100),
  recorded_at timestamptz not null default now(),
  resolved_at timestamptz null,
  updated_at timestamptz not null default now()
);

alter table private.interview_vendor_binding_recovery enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'interview_adjudications_audit_log_fk'
      and conrelid = 'public.interview_adjudications'::regclass
  ) then
    alter table public.interview_adjudications
      add constraint interview_adjudications_audit_log_fk foreign key (audit_log_id)
      references public.interview_admin_audit_logs(id) on delete restrict
      deferrable initially deferred;
  end if;
  if not exists (
    select 1 from pg_constraint
    where conname = 'interview_reset_events_adjudication_id_fkey'
      and conrelid = 'public.interview_reset_events'::regclass
  ) then
    alter table public.interview_reset_events
      add constraint interview_reset_events_adjudication_id_fkey foreign key (adjudication_id)
      references public.interview_adjudications(id) on delete restrict;
  end if;
end
$$;

create unique index if not exists interview_reset_events_one_prior_authorization_uidx
  on public.interview_reset_events (previous_interview_id);
create unique index if not exists interview_reset_events_one_consumed_prior_uidx
  on public.interview_reset_events (previous_interview_id)
  where authorization_status = 'consumed';
create index if not exists interview_adjudications_attempt_idx
  on public.interview_adjudications (interview_id, created_at desc);
create index if not exists interview_admin_audit_logs_created_idx
  on public.interview_admin_audit_logs (created_at desc);
create index if not exists interview_admin_audit_logs_attempt_idx
  on public.interview_admin_audit_logs (client_id, candidate_id, interview_id, created_at desc);

alter table public.reports
  add column if not exists attempt_number integer null,
  add column if not exists report_kind text null,
  add column if not exists report_generated_at timestamptz null;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'reports_recovery_core_attempt_check'
      and conrelid = 'public.reports'::regclass
  ) then
    alter table public.reports add constraint reports_recovery_core_attempt_check
      check (attempt_number is null or attempt_number > 0);
  end if;
  if not exists (
    select 1 from pg_constraint
    where conname = 'reports_recovery_core_kind_check'
      and conrelid = 'public.reports'::regclass
  ) then
    alter table public.reports add constraint reports_recovery_core_kind_check
      check (report_kind is null or report_kind in (
        'resume_only', 'partial_diagnostic', 'complete_interview', 'text_interview', 'legacy'
      ));
  end if;
  if not exists (
    select 1 from pg_constraint
    where conname = 'reports_recovery_core_shape_check'
      and conrelid = 'public.reports'::regclass
  ) then
    alter table public.reports add constraint reports_recovery_core_shape_check check (
      report_kind is null or
      (report_kind = 'resume_only' and interview_id is null and attempt_number is null) or
      (report_kind in ('partial_diagnostic', 'complete_interview', 'text_interview')
        and interview_id is not null and attempt_number is not null) or
      report_kind = 'legacy'
    );
  end if;
end
$$;

create unique index if not exists reports_interview_kind_uidx
  on public.reports (interview_id, report_kind)
  where interview_id is not null and report_kind is not null;
create index if not exists reports_attempt_bound_idx
  on public.reports (candidate_id, role_id, interview_id, attempt_number, created_at desc);

create or replace function public.prevent_interview_recovery_core_immutable_update()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception using errcode = '23514', message = 'interview_recovery_audit_record_immutable';
end
$$;

drop trigger if exists prevent_interview_adjudication_update on public.interview_adjudications;
create trigger prevent_interview_adjudication_update
before update or delete on public.interview_adjudications
for each row execute function public.prevent_interview_recovery_core_immutable_update();

drop trigger if exists prevent_interview_admin_audit_update on public.interview_admin_audit_logs;
create trigger prevent_interview_admin_audit_update
before update or delete on public.interview_admin_audit_logs
for each row execute function public.prevent_interview_recovery_core_immutable_update();

create or replace function public.protect_interview_recovery_authorization_identity()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.candidate_id is distinct from old.candidate_id
    or new.client_id is distinct from old.client_id
    or new.role_id is distinct from old.role_id
    or new.previous_interview_id is distinct from old.previous_interview_id
    or new.actor_user_id is distinct from old.actor_user_id
    or new.actor_email is distinct from old.actor_email
    or new.reason_code is distinct from old.reason_code
    or new.reason_detail is distinct from old.reason_detail
    or new.reset_mode is distinct from old.reset_mode
    or new.idempotency_key is distinct from old.idempotency_key
    or new.adjudication_id is distinct from old.adjudication_id
    or new.request_fingerprint is distinct from old.request_fingerprint
    or new.required_coverage_attested is distinct from old.required_coverage_attested
    or new.client_approval_status is distinct from old.client_approval_status
    or new.created_at is distinct from old.created_at then
    raise exception using errcode = '23514', message = 'interview_recovery_authorization_identity_immutable';
  end if;

  if old.replacement_interview_id is not null
    and new.replacement_interview_id is distinct from old.replacement_interview_id then
    raise exception using errcode = '23514', message = 'interview_recovery_replacement_link_immutable';
  end if;
  if old.authorization_status = 'consumed'
    and new.authorization_status is distinct from 'consumed' then
    raise exception using errcode = '23514', message = 'interview_recovery_consumption_immutable';
  end if;
  return new;
end
$$;

drop trigger if exists protect_interview_recovery_authorization_identity on public.interview_reset_events;
create trigger protect_interview_recovery_authorization_identity
before update on public.interview_reset_events
for each row execute function public.protect_interview_recovery_authorization_identity();

create or replace function public.validate_recovery_replacement_binding()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_authorization public.interview_reset_events%rowtype;
begin
  if new.replacement_authorization_id is null then
    return new;
  end if;
  select * into v_authorization
  from public.interview_reset_events
  where id = new.replacement_authorization_id;
  if not found
    or v_authorization.candidate_id is distinct from new.candidate_id
    or v_authorization.client_id is distinct from new.client_id
    or v_authorization.role_id is distinct from new.role_id
    or v_authorization.previous_interview_id is distinct from new.previous_attempt_id
    or (v_authorization.replacement_interview_id is not null
      and v_authorization.replacement_interview_id is distinct from new.id) then
    raise exception using errcode = '23514', message = 'interview_recovery_replacement_binding_mismatch';
  end if;
  if new.attempt_mode is distinct from 'video' then
    raise exception using errcode = '23514', message = 'interview_recovery_video_only';
  end if;
  return new;
end
$$;

drop trigger if exists validate_recovery_replacement_binding on public.interviews;
create trigger validate_recovery_replacement_binding
before insert or update of candidate_id, client_id, role_id, previous_attempt_id,
  replacement_authorization_id, attempt_mode on public.interviews
for each row execute function public.validate_recovery_replacement_binding();

create or replace function public.protect_attempt_bound_report_identity_core()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.interview_id is not null and (
    new.interview_id is distinct from old.interview_id
    or new.candidate_id is distinct from old.candidate_id
    or new.client_id is distinct from old.client_id
    or new.role_id is distinct from old.role_id
    or new.attempt_number is distinct from old.attempt_number
    or new.report_kind is distinct from old.report_kind
  ) then
    raise exception using errcode = '23514', message = 'attempt_bound_report_identity_immutable';
  end if;
  return new;
end
$$;

drop trigger if exists protect_attempt_bound_report_identity_core on public.reports;
create trigger protect_attempt_bound_report_identity_core
before update on public.reports
for each row execute function public.protect_attempt_bound_report_identity_core();

create or replace function public.validate_attempt_bound_report_binding_core()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_interview public.interviews%rowtype;
begin
  if new.report_kind not in ('partial_diagnostic', 'complete_interview', 'text_interview') then
    return new;
  end if;
  select * into v_interview from public.interviews where id = new.interview_id;
  if not found
    or v_interview.candidate_id is distinct from new.candidate_id
    or v_interview.client_id is distinct from new.client_id
    or v_interview.role_id is distinct from new.role_id
    or v_interview.attempt_number is distinct from new.attempt_number then
    raise exception using errcode = '23514', message = 'attempt_bound_report_binding_mismatch';
  end if;
  if new.report_kind in ('partial_diagnostic', 'complete_interview')
    and v_interview.attempt_mode in ('text', 'text_accommodation') then
    raise exception using errcode = '23514', message = 'video_report_mode_mismatch';
  end if;
  return new;
end
$$;

drop trigger if exists validate_attempt_bound_report_binding_core on public.reports;
create trigger validate_attempt_bound_report_binding_core
before insert or update on public.reports
for each row execute function public.validate_attempt_bound_report_binding_core();

create or replace function public.get_interview_recovery_core_eligibility(
  p_candidate_id uuid,
  p_role_id uuid,
  p_client_id uuid,
  p_prior_interview_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_candidate public.candidates%rowtype;
  v_role public.roles%rowtype;
  v_client public.clients%rowtype;
  v_prior public.interviews%rowtype;
  v_replacement public.interviews%rowtype;
  v_authorization public.interview_reset_events%rowtype;
  v_adjudication public.interview_adjudications%rowtype;
  v_authorization_exists boolean := false;
  v_blockers text[] := array[]::text[];
  v_transcript_present boolean;
  v_recording_present boolean;
  v_report_present boolean;
  v_complete_report_present boolean;
  v_duration_seconds numeric;
begin
  select * into v_candidate from public.candidates where id = p_candidate_id;
  if not found or v_candidate.client_id is distinct from p_client_id
    or v_candidate.role_id is distinct from p_role_id then
    return jsonb_build_object('eligible', false, 'blockers', jsonb_build_array('candidate_binding_mismatch'));
  end if;

  select * into v_role from public.roles where id = p_role_id and client_id = p_client_id;
  if not found then
    return jsonb_build_object('eligible', false, 'blockers', jsonb_build_array('candidate_binding_mismatch'));
  end if;
  select * into v_client from public.clients where id = p_client_id;
  if not found then
    return jsonb_build_object('eligible', false, 'blockers', jsonb_build_array('candidate_binding_mismatch'));
  end if;

  if p_prior_interview_id is null then
    select * into v_prior from public.interviews
    where candidate_id = p_candidate_id and client_id = p_client_id and role_id = p_role_id
    order by attempt_number desc nulls last, created_at desc limit 1;
  else
    select * into v_prior from public.interviews where id = p_prior_interview_id;
  end if;
  if not found or v_prior.candidate_id is distinct from p_candidate_id
    or v_prior.client_id is distinct from p_client_id
    or v_prior.role_id is distinct from p_role_id then
    return jsonb_build_object('eligible', false, 'blockers', jsonb_build_array('prior_interview_binding_mismatch'));
  end if;

  if v_prior.replacement_authorization_id is not null then
    v_replacement := v_prior;
    select * into v_authorization from public.interview_reset_events
    where id = v_replacement.replacement_authorization_id;
    v_authorization_exists := found;
    if not v_authorization_exists
      or v_authorization.replacement_interview_id is distinct from v_replacement.id
      or v_authorization.previous_interview_id is distinct from v_replacement.previous_attempt_id then
      return jsonb_build_object('eligible', false, 'blockers', jsonb_build_array('prior_interview_binding_mismatch'));
    end if;
    select * into v_prior from public.interviews where id = v_replacement.previous_attempt_id;
    if not found or v_prior.candidate_id is distinct from p_candidate_id
      or v_prior.client_id is distinct from p_client_id
      or v_prior.role_id is distinct from p_role_id then
      return jsonb_build_object('eligible', false, 'blockers', jsonb_build_array('prior_interview_binding_mismatch'));
    end if;
  else
    select * into v_authorization from public.interview_reset_events
    where previous_interview_id = v_prior.id limit 1;
    v_authorization_exists := found;
    if v_authorization_exists and v_authorization.replacement_interview_id is not null then
      select * into v_replacement from public.interviews
      where id = v_authorization.replacement_interview_id;
    end if;
  end if;

  v_transcript_present := nullif(btrim(coalesce(v_prior.transcript, '')), '') is not null
    or nullif(btrim(coalesce(v_prior.transcript_url, '')), '') is not null;
  v_recording_present := lower(coalesce(v_prior.recording_status, '')) = 'ready'
    or v_prior.recording_ready_at is not null
    or coalesce(v_prior.recording_metadata, '{}'::jsonb) <> '{}'::jsonb;
  if coalesce(v_prior.recording_metadata ->> 'duration_seconds', '') ~ '^[0-9]+([.][0-9]+)?$' then
    v_duration_seconds := (v_prior.recording_metadata ->> 'duration_seconds')::numeric;
  elsif v_prior.started_at is not null and v_prior.ended_at is not null then
    v_duration_seconds := greatest(0, extract(epoch from (v_prior.ended_at - v_prior.started_at)));
  end if;
  select exists (
    select 1 from public.reports where interview_id = v_prior.id
  ), exists (
    select 1 from public.reports
    where interview_id = v_prior.id and report_kind = 'complete_interview'
  ) into v_report_present, v_complete_report_present;

  if v_authorization_exists and v_authorization.adjudication_id is not null then
    select * into v_adjudication from public.interview_adjudications
    where id = v_authorization.adjudication_id;
  end if;

  if lower(coalesce(v_role.status, 'inactive')) <> 'active' then
    v_blockers := array_append(v_blockers, 'role_inactive');
  end if;
  if v_client.archived_at is not null
    or lower(coalesce(v_client.access_override_mode, 'inherit')) = 'force_inactive' then
    v_blockers := array_append(v_blockers, 'client_inactive');
  end if;
  if v_prior.attempt_mode in ('text', 'text_accommodation') then
    v_blockers := array_append(v_blockers, 'video_recovery_only');
  end if;
  if exists (
    select 1 from public.interviews
    where candidate_id = p_candidate_id and role_id = p_role_id and is_active
  ) then
    v_blockers := array_append(v_blockers, 'active_interview_attempt_exists');
  end if;
  if v_authorization_exists then
    v_blockers := array_append(v_blockers,
      case when v_authorization.authorization_status = 'consumed'
        then 'replacement_already_used' else 'replacement_already_authorized' end);
  end if;
  if lower(coalesce(v_candidate.status, '')) like '%interview completed%'
    or lower(coalesce(v_candidate.interview_status, '')) like '%interview completed%'
    or lower(coalesce(v_prior.status, '')) in ('complete', 'completed') then
    v_blockers := array_append(v_blockers, 'completed_interview_retake_blocked');
  end if;
  if v_complete_report_present then
    v_blockers := array_append(v_blockers, 'complete_report_bound');
  end if;

  return jsonb_build_object(
    'eligible', cardinality(v_blockers) = 0,
    'blockers', to_jsonb(v_blockers),
    'candidate', jsonb_build_object('id', v_candidate.id, 'name', v_candidate.name),
    'role', jsonb_build_object('id', v_role.id, 'title', v_role.title),
    'prior_interview', jsonb_build_object(
      'id', v_prior.id,
      'attempt_number', v_prior.attempt_number,
      'status', v_prior.status,
      'created_at', v_prior.created_at,
      'duration_seconds', v_duration_seconds,
      'transcript_present', v_transcript_present,
      'recording_present', v_recording_present,
      'report_present', v_report_present,
      'complete_report_present', v_complete_report_present
    ),
    'replacement', case when v_authorization.id is null then null else jsonb_build_object(
      'authorization_id', v_authorization.id,
      'status', v_authorization.authorization_status,
      'start_status', v_authorization.start_status,
      'replacement_interview_id', v_authorization.replacement_interview_id,
      'reset_mode', v_authorization.reset_mode,
      'email_status', v_authorization.email_status,
      'interview_status', v_replacement.status,
      'vendor_start_state', v_replacement.vendor_start_state,
      'vendor_reconciliation_status', v_replacement.vendor_reconciliation_status,
      'vendor_resolution_source', v_replacement.vendor_resolution_source,
      'manual_review_required', coalesce(v_replacement.vendor_manual_review, false),
      'total_exact_match_count', v_replacement.vendor_reconciliation_total_exact_match_count,
      'stored_match_reference_count', v_replacement.vendor_reconciliation_stored_match_reference_count,
      'match_references_truncated', v_replacement.vendor_reconciliation_match_references_truncated,
      'scan_complete', v_replacement.vendor_reconciliation_scan_complete,
      'scan_status', v_replacement.vendor_reconciliation_scan_status,
      'pages_requested', v_replacement.vendor_reconciliation_pages_requested,
      'pages_completed', v_replacement.vendor_reconciliation_pages_completed,
      'total_count_reported', v_replacement.vendor_reconciliation_total_count_reported,
      'reconciliation_at', v_replacement.vendor_reconciliation_last_at,
      'binding_recovery_required', coalesce(v_replacement.vendor_binding_recovery_required, false)
    ) end,
    'adjudication', case when v_adjudication.id is null then null else jsonb_build_object(
      'id', v_adjudication.id,
      'decision', v_adjudication.decision,
      'actor_email', v_adjudication.actor_email,
      'created_at', v_adjudication.created_at,
      'reason_code', v_adjudication.reason_code,
      'reason_detail', v_adjudication.reason_detail,
      'resulting_eligibility', v_adjudication.resulting_eligibility_decision,
      'audit_log_id', v_adjudication.audit_log_id
    ) end
  );
end
$$;

create or replace function public.authorize_interview_replacement_core(
  p_candidate_id uuid,
  p_role_id uuid,
  p_client_id uuid,
  p_prior_interview_id uuid,
  p_actor_user_id uuid,
  p_actor_email text,
  p_actor_role text,
  p_decision text,
  p_reason_code text,
  p_reason_detail text,
  p_reset_mode text,
  p_required_coverage_attested boolean,
  p_client_approval_acknowledged boolean,
  p_idempotency_key uuid
)
returns table (
  authorization_id uuid,
  adjudication_id uuid,
  prior_interview_id uuid,
  replacement_interview_id uuid,
  replayed boolean,
  email_status text,
  audit_log_id uuid
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_candidate public.candidates%rowtype;
  v_role public.roles%rowtype;
  v_client public.clients%rowtype;
  v_prior public.interviews%rowtype;
  v_existing public.interview_reset_events%rowtype;
  v_eligibility jsonb;
  v_reason text := lower(btrim(coalesce(p_reason_code, '')));
  v_detail text := nullif(btrim(coalesce(p_reason_detail, '')), '');
  v_mode text := lower(btrim(coalesce(p_reset_mode, '')));
  v_actor_role text := lower(btrim(coalesce(p_actor_role, 'admin')));
  v_request_id text := p_idempotency_key::text;
  v_fingerprint text;
  v_adjudication_id uuid;
  v_authorization_id uuid;
  v_audit_id uuid := gen_random_uuid();
  v_prior_state jsonb;
begin
  if p_idempotency_key is null then
    raise exception using errcode = 'P0001', message = 'reset_request_conflict';
  end if;
  if p_actor_user_id is null or v_actor_role not in ('admin', 'super_admin') then
    raise exception using errcode = 'P0001', message = 'admin_scope_required';
  end if;
  if p_decision is distinct from 'authorize_one_video_replacement' then
    raise exception using errcode = 'P0001', message = 'recovery_decision_invalid';
  end if;
  if v_reason not in (
    'candidate_network_disconnect', 'unknown_early_termination',
    'no_substantive_response', 'partial_interview', 'vendor_start_failure',
    'client_approved_exception', 'other'
  ) then
    raise exception using errcode = 'P0001', message = 'interview_reset_reason_required';
  end if;
  if v_reason = 'other' and v_detail is null then
    raise exception using errcode = 'P0001', message = 'interview_reset_other_detail_required';
  end if;
  if v_detail is not null and char_length(v_detail) > 500 then
    raise exception using errcode = 'P0001', message = 'interview_reset_reason_detail_too_long';
  end if;
  if v_mode not in ('reset_only', 'reset_and_send') then
    raise exception using errcode = 'P0001', message = 'reset_request_conflict';
  end if;
  if p_required_coverage_attested is not true then
    raise exception using errcode = 'P0001', message = 'recovery_attestation_required';
  end if;
  if p_client_approval_acknowledged is not true then
    raise exception using errcode = 'P0001', message = 'client_approval_required';
  end if;

  v_fingerprint := encode(public.digest(convert_to(concat_ws('|',
    p_candidate_id::text, p_role_id::text, p_client_id::text,
    p_prior_interview_id::text, p_decision, v_reason, coalesce(v_detail, ''),
    v_mode, p_required_coverage_attested::text,
    p_client_approval_acknowledged::text
  ), 'utf8'), 'sha256'), 'hex');

  perform pg_advisory_xact_lock(hashtextextended(p_candidate_id::text || ':' || p_role_id::text, 0));

  select * into v_existing from public.interview_reset_events
  where client_id = p_client_id and candidate_id = p_candidate_id
    and role_id = p_role_id and idempotency_key = p_idempotency_key;
  if found then
    if v_existing.request_fingerprint is distinct from v_fingerprint then
      raise exception using errcode = 'P0001', message = 'reset_request_conflict';
    end if;
    return query select v_existing.id, v_existing.adjudication_id,
      v_existing.previous_interview_id, v_existing.replacement_interview_id,
      true, v_existing.email_status,
      (select a.audit_log_id from public.interview_adjudications a where a.id = v_existing.adjudication_id);
    return;
  end if;

  select * into v_candidate from public.candidates where id = p_candidate_id for update;
  select * into v_role from public.roles where id = p_role_id;
  select * into v_client from public.clients where id = p_client_id;
  select * into v_prior from public.interviews where id = p_prior_interview_id for update;

  if v_candidate.id is null or v_role.id is null or v_client.id is null or v_prior.id is null
    or v_candidate.client_id is distinct from p_client_id
    or v_candidate.role_id is distinct from p_role_id
    or v_role.client_id is distinct from p_client_id
    or v_prior.candidate_id is distinct from p_candidate_id
    or v_prior.client_id is distinct from p_client_id
    or v_prior.role_id is distinct from p_role_id then
    raise exception using errcode = 'P0001', message = 'prior_interview_binding_mismatch';
  end if;

  v_eligibility := public.get_interview_recovery_core_eligibility(
    p_candidate_id, p_role_id, p_client_id, p_prior_interview_id
  );
  if coalesce((v_eligibility ->> 'eligible')::boolean, false) is not true then
    raise exception using errcode = 'P0001', message = coalesce(
      v_eligibility #>> '{blockers,0}', 'interview_reset_not_eligible'
    );
  end if;

  v_prior_state := jsonb_build_object(
    'status', v_prior.status,
    'created_at', v_prior.created_at,
    'attempt_number', v_prior.attempt_number,
    'has_substantive_response', v_prior.has_substantive_response,
    'transcript_present', v_eligibility #> '{prior_interview,transcript_present}',
    'recording_present', v_eligibility #> '{prior_interview,recording_present}',
    'report_present', v_eligibility #> '{prior_interview,report_present}'
  );

  insert into public.interview_adjudications (
    actor_user_id, actor_role, actor_email, client_id, role_id, candidate_id,
    interview_id, attempt_number, previous_system_outcome, prior_system_state,
    decision, reason_code, reason_detail, required_coverage_attested,
    client_approval_status, resulting_eligibility_decision, request_id,
    request_fingerprint, audit_log_id
  ) values (
    p_actor_user_id, v_actor_role, nullif(left(btrim(coalesce(p_actor_email, '')), 320), ''),
    p_client_id, p_role_id, p_candidate_id, p_prior_interview_id,
    coalesce(v_prior.attempt_number, 1), coalesce(nullif(v_prior.status, ''), 'unknown'),
    v_prior_state, p_decision, v_reason, v_detail, true, 'acknowledged',
    'one_video_replacement_authorized', v_request_id, v_fingerprint, v_audit_id
  ) returning id into v_adjudication_id;

  insert into public.interview_reset_events (
    candidate_id, role_id, client_id, previous_interview_id,
    actor_user_id, actor_email, reason_code, reason_detail, reset_mode,
    idempotency_key, email_status, adjudication_id, authorization_status,
    request_fingerprint, required_coverage_attested, client_approval_status,
    start_status, start_attempt_count
  ) values (
    p_candidate_id, p_role_id, p_client_id, p_prior_interview_id,
    p_actor_user_id, nullif(left(btrim(coalesce(p_actor_email, '')), 320), ''),
    v_reason, v_detail, v_mode, p_idempotency_key,
    case when v_mode = 'reset_and_send' then 'pending' else 'not_requested' end,
    v_adjudication_id, 'authorized', v_fingerprint, true, 'acknowledged',
    'not_started', 0
  ) returning id into v_authorization_id;

  insert into public.interview_admin_audit_logs (
    id, actor_user_id, actor_role, actor_email, client_id, role_id, candidate_id,
    interview_id, attempt_number, action, prior_state, resulting_state,
    reason_code, request_id, success, related_adjudication_id, related_reset_id
  ) values (
    v_audit_id, p_actor_user_id, v_actor_role, p_actor_email, p_client_id,
    p_role_id, p_candidate_id, p_prior_interview_id, coalesce(v_prior.attempt_number, 1),
    'replacement_authorized', v_prior_state,
    jsonb_build_object('authorization_id', v_authorization_id, 'reset_mode', v_mode,
      'replacement_interview_id', null),
    v_reason, v_request_id, true, v_adjudication_id, v_authorization_id
  );

  insert into public.interview_admin_audit_logs (
    actor_user_id, actor_role, actor_email, client_id, role_id, candidate_id,
    interview_id, attempt_number, action, prior_state, resulting_state,
    reason_code, request_id, success, related_adjudication_id, related_reset_id
  ) values (
    p_actor_user_id, v_actor_role, p_actor_email, p_client_id, p_role_id,
    p_candidate_id, p_prior_interview_id, coalesce(v_prior.attempt_number, 1),
    v_mode, '{}'::jsonb, jsonb_build_object('authorization_id', v_authorization_id),
    v_reason, v_request_id, true, v_adjudication_id, v_authorization_id
  );

  return query select v_authorization_id, v_adjudication_id,
    p_prior_interview_id, null::uuid, false,
    case when v_mode = 'reset_and_send' then 'pending' else 'not_requested' end,
    v_audit_id;
end
$$;

create or replace function public.claim_candidate_interview_attempt_core(
  p_candidate_id uuid,
  p_role_id uuid,
  p_client_id uuid
)
returns table (
  interview_id uuid,
  attempt_number integer,
  authorized_replacement boolean,
  start_claimed boolean,
  claim_state text,
  recovery_authorization_id uuid,
  vendor_claim_token uuid,
  vendor_external_reference text,
  vendor_state text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_candidate public.candidates%rowtype;
  v_role public.roles%rowtype;
  v_client public.clients%rowtype;
  v_active public.interviews%rowtype;
  v_prior public.interviews%rowtype;
  v_replacement public.interviews%rowtype;
  v_authorization public.interview_reset_events%rowtype;
  v_count integer;
  v_interview_id uuid;
  v_attempt integer;
  v_request_id text;
  v_claim_token uuid := gen_random_uuid();
  v_external_reference text;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_candidate_id::text || ':' || p_role_id::text, 0));

  select * into v_candidate from public.candidates where id = p_candidate_id for update;
  select * into v_role from public.roles where id = p_role_id;
  select * into v_client from public.clients where id = p_client_id;
  if v_candidate.id is null or v_role.id is null or v_client.id is null
    or v_candidate.role_id is distinct from p_role_id
    or v_candidate.client_id is distinct from p_client_id
    or v_role.client_id is distinct from p_client_id then
    raise exception using errcode = 'P0001', message = 'candidate_interview_state_requires_review';
  end if;
  if lower(coalesce(v_role.status, 'inactive')) <> 'active'
    or v_client.archived_at is not null
    or lower(coalesce(v_client.access_override_mode, 'inherit')) = 'force_inactive' then
    raise exception using errcode = 'P0001', message = 'candidate_interview_state_requires_review';
  end if;

  select * into v_active from public.interviews
  where candidate_id = p_candidate_id and role_id = p_role_id and is_active
  order by attempt_number desc nulls last, created_at desc limit 1 for update;
  if found then
    -- Grandfather a Phase B authorization that created its replacement row at
    -- admin time. New B-Core authorizations never take this path, but existing
    -- authorization and attempt identities remain usable after promotion.
    if v_active.replacement_authorization_id is not null
      and lower(coalesce(v_active.status, '')) = 'authorized' then
      select * into v_authorization from public.interview_reset_events
      where id = v_active.replacement_authorization_id for update;
      if not found
        or v_authorization.candidate_id is distinct from p_candidate_id
        or v_authorization.client_id is distinct from p_client_id
        or v_authorization.role_id is distinct from p_role_id
        or v_authorization.previous_interview_id is distinct from v_active.previous_attempt_id
        or v_authorization.replacement_interview_id is distinct from v_active.id
        or v_authorization.authorization_status <> 'authorized' then
        raise exception using errcode = 'P0001', message = 'recovery_start_binding_mismatch';
      end if;
      update public.interviews set
        status = 'Starting', attempt_mode = 'video', started_at = coalesce(started_at, now()),
        recovery_start_attempt_count = 1, vendor_start_state = 'claimed',
        vendor_operation = 'create_conversation',
        vendor_external_reference = 'alphascreen-interview-' || v_active.id::text,
        vendor_create_claim_token = v_claim_token, vendor_create_started_at = now(),
        vendor_failure_category = null, vendor_failure_code = null, updated_at = now()
      where id = v_active.id;
      update public.interview_reset_events set
        authorization_status = 'consumed', consumed_at = now(), start_status = 'starting',
        start_attempt_count = 1, updated_at = now()
      where id = v_authorization.id;
      insert into public.interview_admin_audit_logs (
        actor_user_id, actor_role, actor_email, client_id, role_id, candidate_id,
        interview_id, attempt_number, action, prior_state, resulting_state,
        reason_code, request_id, success, related_adjudication_id, related_reset_id
      ) values (
        null, 'system', null, p_client_id, p_role_id, p_candidate_id,
        v_active.previous_attempt_id, greatest(1, v_active.attempt_number - 1),
        'authorization_consumed', jsonb_build_object('authorization_status', 'authorized'),
        jsonb_build_object('authorization_status', 'consumed', 'replacement_interview_id', v_active.id,
          'grandfathered_phase_b', true),
        v_authorization.reason_code, v_authorization.id::text || ':consume', true,
        v_authorization.adjudication_id, v_authorization.id
      );
      insert into public.interview_admin_audit_logs (
        actor_user_id, actor_role, actor_email, client_id, role_id, candidate_id,
        interview_id, attempt_number, action, prior_state, resulting_state,
        reason_code, request_id, success, related_adjudication_id, related_reset_id
      ) values (
        null, 'system', null, p_client_id, p_role_id, p_candidate_id,
        v_active.id, v_active.attempt_number, 'vendor_create_claimed', '{}'::jsonb,
        jsonb_build_object('vendor_start_state', 'claimed', 'external_reference', 'alphascreen-interview-' || v_active.id::text),
        v_authorization.reason_code, v_authorization.id::text || ':vendor:create:1:claimed', true,
        v_authorization.adjudication_id, v_authorization.id
      );
      return query select v_active.id, v_active.attempt_number, true, true,
        'grandfathered_replacement_claimed'::text, v_authorization.id, v_claim_token,
        'alphascreen-interview-' || v_active.id::text, 'claimed'::text;
      return;
    end if;
    if v_active.replacement_authorization_id is not null
      and v_active.vendor_start_state = 'reconciliation_required' then
      return query select v_active.id, v_active.attempt_number, true, false,
        'replacement_reconciliation_required'::text, v_active.replacement_authorization_id,
        null::uuid, v_active.vendor_external_reference, v_active.vendor_start_state;
      return;
    end if;
    if v_active.replacement_authorization_id is not null
      and v_active.vendor_start_state = 'reconciling' then
      return query select v_active.id, v_active.attempt_number, true, false,
        'replacement_reconciling'::text, v_active.replacement_authorization_id,
        null::uuid, v_active.vendor_external_reference, v_active.vendor_start_state;
      return;
    end if;
    if v_active.replacement_authorization_id is not null
      and v_active.vendor_start_state = 'manual_review' then
      return query select v_active.id, v_active.attempt_number, true, false,
        'replacement_manual_review'::text, v_active.replacement_authorization_id,
        null::uuid, v_active.vendor_external_reference, v_active.vendor_start_state;
      return;
    end if;
    if v_active.replacement_authorization_id is not null
      and v_active.vendor_start_state = 'binding_recovery_required' then
      return query select v_active.id, v_active.attempt_number, true, false,
        'replacement_binding_recovery_required'::text, v_active.replacement_authorization_id,
        null::uuid, v_active.vendor_external_reference, v_active.vendor_start_state;
      return;
    end if;
    if v_active.replacement_authorization_id is not null
      and lower(coalesce(v_active.status, '')) = 'starting'
      and v_active.tavus_conversation_id is null
      and v_active.tavus_application_id is null then
      return query select v_active.id, v_active.attempt_number, true, false,
        'replacement_start_in_progress'::text, v_active.replacement_authorization_id,
        null::uuid, v_active.vendor_external_reference, v_active.vendor_start_state;
      return;
    end if;
    raise exception using errcode = 'P0001', message = 'active_interview_attempt_exists';
  end if;

  select count(*)::integer into v_count from public.interviews
  where candidate_id = p_candidate_id and role_id = p_role_id;
  if v_count = 0 then
    return query
    insert into public.interviews (
      candidate_id, role_id, client_id, attempt_number, attempt_mode,
      status, is_active, has_substantive_response, substantive_response_count,
      candidate_utterance_count, conversation_progress_state, started_at,
      recovery_start_attempt_count
    ) values (
      p_candidate_id, p_role_id, p_client_id, 1, 'video',
      'Starting', true, false, 0, 0, 'WaitingForAnswer', now(), 1
    ) returning id, public.interviews.attempt_number, false, true,
      'phase_a_created'::text, null::uuid, null::uuid, null::text, null::text;
    return;
  end if;

  select * into v_authorization from public.interview_reset_events
  where candidate_id = p_candidate_id and client_id = p_client_id and role_id = p_role_id
  order by created_at desc limit 1 for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'replacement_not_authorized';
  end if;

  select * into v_prior from public.interviews
  where id = v_authorization.previous_interview_id for update;
  if not found or v_prior.candidate_id is distinct from p_candidate_id
    or v_prior.client_id is distinct from p_client_id
    or v_prior.role_id is distinct from p_role_id then
    raise exception using errcode = 'P0001', message = 'prior_interview_binding_mismatch';
  end if;

  if lower(coalesce(v_candidate.status, '')) like '%interview completed%'
    or lower(coalesce(v_candidate.interview_status, '')) like '%interview completed%'
    or lower(coalesce(v_prior.status, '')) in ('complete', 'completed')
    or exists (
      select 1 from public.reports r
      where r.interview_id = v_prior.id and r.report_kind = 'complete_interview'
    ) then
    raise exception using errcode = 'P0001', message = 'completed_interview_retake_blocked';
  end if;

  if v_authorization.authorization_status = 'consumed'
    and v_authorization.replacement_interview_id is not null
    and v_authorization.start_status = 'failed_retryable' then
    select * into v_replacement from public.interviews
    where id = v_authorization.replacement_interview_id for update;
    if not found or v_replacement.candidate_id is distinct from p_candidate_id
      or v_replacement.client_id is distinct from p_client_id
      or v_replacement.role_id is distinct from p_role_id
      or v_replacement.previous_attempt_id is distinct from v_prior.id
      or v_replacement.replacement_authorization_id is distinct from v_authorization.id
      or v_replacement.tavus_conversation_id is not null
      or v_replacement.tavus_application_id is not null then
      raise exception using errcode = 'P0001', message = 'replacement_already_used';
    end if;
    if v_authorization.start_attempt_count >= 3 then
      raise exception using errcode = 'P0001', message = 'replacement_start_retry_exhausted';
    end if;
    update public.interviews set
      status = 'Starting', retryable = true, started_at = coalesce(started_at, now()),
      recovery_start_attempt_count = recovery_start_attempt_count + 1,
      vendor_start_state = 'claimed', vendor_create_claim_token = v_claim_token,
      vendor_create_started_at = now(), vendor_failure_category = null,
      vendor_failure_code = null, vendor_reconciliation_status = null,
      vendor_reconciliation_claim_token = null,
      updated_at = now()
    where id = v_replacement.id;
    update public.interview_reset_events set
      start_status = 'starting', start_attempt_count = start_attempt_count + 1,
      updated_at = now()
    where id = v_authorization.id;
    insert into public.interview_admin_audit_logs (
      actor_user_id, actor_role, actor_email, client_id, role_id, candidate_id,
      interview_id, attempt_number, action, prior_state, resulting_state,
      reason_code, request_id, success, related_adjudication_id, related_reset_id
    ) values (
      null, 'system', null, p_client_id, p_role_id, p_candidate_id,
      v_replacement.id, v_replacement.attempt_number, 'vendor_create_claimed',
      jsonb_build_object('vendor_start_state', v_replacement.vendor_start_state),
      jsonb_build_object('vendor_start_state', 'claimed', 'external_reference', v_replacement.vendor_external_reference),
      v_authorization.reason_code,
      v_authorization.id::text || ':vendor:create:' || (v_authorization.start_attempt_count + 1)::text || ':claimed',
      true, v_authorization.adjudication_id, v_authorization.id
    );
    return query select v_replacement.id, v_replacement.attempt_number, true, true,
      'replacement_retry_claimed'::text, v_authorization.id, v_claim_token,
      v_replacement.vendor_external_reference, 'claimed'::text;
    return;
  end if;

  if v_authorization.authorization_status = 'consumed'
    and v_authorization.replacement_interview_id is not null
    and v_authorization.start_status = 'failed_terminal' then
    raise exception using errcode = 'P0001', message = 'replacement_start_retry_exhausted';
  end if;

  if v_authorization.authorization_status <> 'authorized'
    or v_authorization.replacement_interview_id is not null
    or v_authorization.start_status <> 'not_started'
    or (v_authorization.expires_at is not null and v_authorization.expires_at <= now()) then
    raise exception using errcode = 'P0001', message = 'replacement_already_used';
  end if;
  if v_count <> 1 then
    raise exception using errcode = 'P0001', message = 'replacement_already_used';
  end if;

  v_attempt := coalesce(v_prior.attempt_number, 1) + 1;
  if v_attempt <> 2 then
    raise exception using errcode = 'P0001', message = 'replacement_already_used';
  end if;
  v_interview_id := gen_random_uuid();
  v_external_reference := 'alphascreen-interview-' || v_interview_id::text;
  insert into public.interviews (
    id, candidate_id, role_id, client_id, attempt_number, attempt_mode,
    previous_attempt_id, replacement_authorization_id, status, is_active,
    has_substantive_response, substantive_response_count, candidate_utterance_count,
    conversation_progress_state, replacement_eligible, reset_actor_user_id,
    reset_reason_code, reset_reason_detail, reset_at, reset_mode, started_at,
    recovery_start_attempt_count, vendor_start_state, vendor_operation,
    vendor_external_reference, vendor_create_claim_token, vendor_create_started_at,
    vendor_reconciliation_attempt_count, vendor_manual_review
  ) values (
    v_interview_id, p_candidate_id, p_role_id, p_client_id, v_attempt, 'video',
    v_prior.id, v_authorization.id, 'Starting', true,
    false, 0, 0, 'WaitingForAnswer', false, v_authorization.actor_user_id,
    v_authorization.reason_code, v_authorization.reason_detail, now(),
    v_authorization.reset_mode, now(), 1, 'claimed', 'create_conversation',
    v_external_reference, v_claim_token, now(), 0, false
  );

  update public.interview_reset_events set
    authorization_status = 'consumed', consumed_at = now(),
    replacement_interview_id = v_interview_id, start_status = 'starting',
    start_attempt_count = 1, updated_at = now()
  where id = v_authorization.id and authorization_status = 'authorized'
    and replacement_interview_id is null;
  if not found then
    raise exception using errcode = 'P0001', message = 'replacement_already_used';
  end if;

  v_request_id := v_authorization.id::text || ':consume';
  insert into public.interview_admin_audit_logs (
    actor_user_id, actor_role, actor_email, client_id, role_id, candidate_id,
    interview_id, attempt_number, action, prior_state, resulting_state,
    reason_code, request_id, success, related_adjudication_id, related_reset_id
  ) values (
    null, 'system', null, p_client_id, p_role_id, p_candidate_id,
    v_prior.id, coalesce(v_prior.attempt_number, 1), 'authorization_consumed',
    jsonb_build_object('authorization_status', 'authorized'),
    jsonb_build_object('authorization_status', 'consumed', 'replacement_interview_id', v_interview_id),
    v_authorization.reason_code, v_request_id, true,
    v_authorization.adjudication_id, v_authorization.id
  );
  insert into public.interview_admin_audit_logs (
    actor_user_id, actor_role, actor_email, client_id, role_id, candidate_id,
    interview_id, attempt_number, action, prior_state, resulting_state,
    reason_code, request_id, success, related_adjudication_id, related_reset_id
  ) values (
    null, 'system', null, p_client_id, p_role_id, p_candidate_id,
    v_interview_id, v_attempt, 'replacement_attempt_created',
    jsonb_build_object('previous_interview_id', v_prior.id),
    jsonb_build_object('status', 'Starting', 'attempt_mode', 'video'),
    v_authorization.reason_code, v_authorization.id::text || ':create', true,
    v_authorization.adjudication_id, v_authorization.id
  );
  insert into public.interview_admin_audit_logs (
    actor_user_id, actor_role, actor_email, client_id, role_id, candidate_id,
    interview_id, attempt_number, action, prior_state, resulting_state,
    reason_code, request_id, success, related_adjudication_id, related_reset_id
  ) values (
    null, 'system', null, p_client_id, p_role_id, p_candidate_id,
    v_interview_id, v_attempt, 'vendor_create_claimed', '{}'::jsonb,
    jsonb_build_object('vendor_start_state', 'claimed', 'external_reference', v_external_reference),
    v_authorization.reason_code, v_authorization.id::text || ':vendor:create:1:claimed', true,
    v_authorization.adjudication_id, v_authorization.id
  );

  return query select v_interview_id, v_attempt, true, true,
    'replacement_created'::text, v_authorization.id, v_claim_token,
    v_external_reference, 'claimed'::text;
end
$$;

create or replace function public.complete_interview_recovery_start_core(
  p_interview_id uuid,
  p_authorization_id uuid,
  p_success boolean,
  p_failure_code text default null,
  p_vendor_conversation_id text default null,
  p_vendor_conversation_url text default null,
  p_effective_persona_id text default null,
  p_effective_replica_id text default null,
  p_effective_document_id text default null,
  p_failure_category text default null,
  p_vendor_external_reference text default null,
  p_resolution_source text default null,
  p_claim_token uuid default null,
  p_request_id text default null
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_authorization public.interview_reset_events%rowtype;
  v_interview public.interviews%rowtype;
  v_status text;
  v_failure_code text := left(coalesce(nullif(btrim(p_failure_code), ''), 'INTERVIEW_VENDOR_START_FAILED'), 100);
  v_failure_category text := lower(coalesce(nullif(btrim(p_failure_category), ''), 'definite_pre_acceptance'));
  v_request_id text;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_authorization_id::text, 0));
  select * into v_authorization from public.interview_reset_events
  where id = p_authorization_id for update;
  select * into v_interview from public.interviews where id = p_interview_id for update;
  if not found or v_authorization.id is null
    or v_authorization.replacement_interview_id is distinct from p_interview_id
    or v_interview.replacement_authorization_id is distinct from p_authorization_id
    or v_authorization.authorization_status <> 'consumed' then
    raise exception using errcode = 'P0001', message = 'recovery_start_binding_mismatch';
  end if;

  if p_success then
    if nullif(btrim(coalesce(p_vendor_conversation_id, '')), '') is null
      or nullif(btrim(coalesce(p_vendor_conversation_url, '')), '') is null then
      raise exception using errcode = 'P0001', message = 'recovery_start_vendor_identity_required';
    end if;
    if v_authorization.start_status = 'started' then
      if v_interview.tavus_conversation_id is distinct from p_vendor_conversation_id then
        raise exception using errcode = 'P0001', message = 'recovery_start_result_conflict';
      end if;
      return 'started';
    end if;
    if v_authorization.start_status <> 'starting' then
      raise exception using errcode = 'P0001', message = 'recovery_start_result_conflict';
    end if;
    if p_claim_token is null or v_interview.vendor_create_claim_token is distinct from p_claim_token then
      raise exception using errcode = 'P0001', message = 'recovery_start_result_conflict';
    end if;
    if p_vendor_external_reference is distinct from v_interview.vendor_external_reference then
      raise exception using errcode = 'P0001', message = 'recovery_start_result_conflict';
    end if;
    update public.interviews set
      video_url = p_vendor_conversation_url,
      tavus_application_id = p_vendor_conversation_id,
      tavus_conversation_id = p_vendor_conversation_id,
      effective_persona_id = p_effective_persona_id,
      effective_replica_id = p_effective_replica_id,
      effective_tavus_document_id = p_effective_document_id,
      status = 'Pending', retryable = false, failure_code = null,
      failure_stage = null, failure_summary = null, failure_at = null,
      vendor_start_state = 'started', vendor_failure_category = null,
      vendor_failure_code = null, vendor_reconciliation_status = 'resolved',
      vendor_reconciliation_resolved_at = now(), vendor_resolution_source = left(coalesce(nullif(btrim(p_resolution_source), ''), 'create_response'), 80),
      vendor_manual_review = false, vendor_binding_recovery_required = false,
      updated_at = now()
    where id = p_interview_id and vendor_create_claim_token = p_claim_token
      and tavus_conversation_id is null;
    if not found then
      raise exception using errcode = 'P0001', message = 'recovery_start_result_conflict';
    end if;
    update public.interview_reset_events set
      start_status = 'started', start_last_failure_code = null, updated_at = now()
    where id = p_authorization_id;
    v_status := 'started';
  else
    if v_authorization.start_status = 'started' or v_interview.tavus_conversation_id is not null then
      return 'started';
    end if;
    if v_authorization.start_status <> 'starting' then
      return v_authorization.start_status;
    end if;
    if p_claim_token is null or v_interview.vendor_create_claim_token is distinct from p_claim_token then
      raise exception using errcode = 'P0001', message = 'recovery_start_result_conflict';
    end if;
    if v_failure_category not in ('definite_pre_acceptance', 'ambiguous_acceptance') then
      raise exception using errcode = 'P0001', message = 'recovery_start_result_conflict';
    end if;
    if v_failure_category = 'ambiguous_acceptance' then
      v_status := 'reconciliation_required';
      update public.interviews set
        status = 'Starting', failure_code = v_failure_code, failure_stage = 'vendor_start',
        failure_summary = 'The vendor create result is being reconciled.', failure_at = now(),
        retryable = false, vendor_start_state = 'reconciliation_required',
        vendor_ambiguous_at = now(), vendor_failure_category = v_failure_category,
        vendor_failure_code = v_failure_code, vendor_reconciliation_status = 'required',
        vendor_reconciliation_claim_token = null, vendor_manual_review = false, updated_at = now()
      where id = p_interview_id and vendor_create_claim_token = p_claim_token
        and tavus_conversation_id is null;
      update public.interview_reset_events set
        start_status = v_status, start_last_failed_at = now(),
        start_last_failure_code = v_failure_code, updated_at = now()
      where id = p_authorization_id and start_status = 'starting';
    else
      v_status := case when v_authorization.start_attempt_count < 3
        then 'failed_retryable' else 'failed_terminal' end;
      update public.interviews set
        status = 'Failed', failure_code = v_failure_code, failure_stage = 'vendor_start',
        failure_summary = 'The interview vendor rejected the create request before acceptance.',
        failure_at = now(), retryable = (v_status = 'failed_retryable'),
        vendor_start_state = 'definite_failure', vendor_failure_category = v_failure_category,
        vendor_failure_code = v_failure_code, updated_at = now()
      where id = p_interview_id and vendor_create_claim_token = p_claim_token
        and tavus_conversation_id is null;
      update public.interview_reset_events set
        start_status = v_status, start_last_failed_at = now(),
        start_last_failure_code = v_failure_code, updated_at = now()
      where id = p_authorization_id and start_status = 'starting';
    end if;
  end if;

  v_request_id := left(coalesce(nullif(btrim(p_request_id), ''),
    p_authorization_id::text || ':vendor:start:' || v_authorization.start_attempt_count::text), 200);
  insert into public.interview_admin_audit_logs (
    actor_user_id, actor_role, actor_email, client_id, role_id, candidate_id,
    interview_id, attempt_number, action, prior_state, resulting_state,
    reason_code, request_id, success, related_adjudication_id, related_reset_id
  ) values (
    null, 'system', null, v_authorization.client_id, v_authorization.role_id,
    v_authorization.candidate_id, p_interview_id, v_interview.attempt_number,
    case when p_success then 'vendor_start_succeeded'
      when v_failure_category = 'ambiguous_acceptance' then 'vendor_create_ambiguous'
      else 'vendor_create_definite_failure' end,
    jsonb_build_object('start_status', 'starting', 'start_attempt_count', v_authorization.start_attempt_count),
    jsonb_build_object('start_status', v_status,
      'vendor_start_state', case when p_success then 'started'
        when v_failure_category = 'ambiguous_acceptance' then 'reconciliation_required'
        else 'definite_failure' end,
      'failure_category', case when p_success then null else v_failure_category end,
      'failure_code', case when p_success then null else v_failure_code end,
      'vendor_conversation_id', case when p_success then left(p_vendor_conversation_id, 200) else null end),
    case when p_success then v_authorization.reason_code else 'vendor_start_failure' end,
    v_request_id,
    p_success, v_authorization.adjudication_id, p_authorization_id
  );
  return v_status;
end
$$;

create or replace function public.record_interview_recovery_binding_failure_core(
  p_interview_id uuid,
  p_authorization_id uuid,
  p_claim_token uuid,
  p_vendor_external_reference text,
  p_vendor_conversation_id text,
  p_vendor_conversation_url text,
  p_effective_persona_id text default null,
  p_effective_replica_id text default null,
  p_effective_document_id text default null,
  p_failure_code text default null,
  p_request_id text default null
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_authorization public.interview_reset_events%rowtype;
  v_interview public.interviews%rowtype;
  v_existing private.interview_vendor_binding_recovery%rowtype;
  v_request_id text := left(coalesce(nullif(btrim(p_request_id), ''), p_authorization_id::text), 150);
  v_failure_code text := left(coalesce(nullif(btrim(p_failure_code), ''), 'database_binding_failed'), 100);
begin
  perform pg_advisory_xact_lock(hashtextextended(p_authorization_id::text, 0));
  select * into v_authorization from public.interview_reset_events
    where id = p_authorization_id for update;
  select * into v_interview from public.interviews
    where id = p_interview_id for update;
  if v_authorization.id is null or v_interview.id is null
    or v_authorization.replacement_interview_id is distinct from p_interview_id
    or v_interview.replacement_authorization_id is distinct from p_authorization_id
    or v_interview.attempt_number is distinct from 2
    or p_claim_token is null
    or v_interview.vendor_create_claim_token is distinct from p_claim_token
    or p_vendor_external_reference is distinct from v_interview.vendor_external_reference
    or p_vendor_external_reference is distinct from ('alphascreen-interview-' || p_interview_id::text)
    or nullif(btrim(coalesce(p_vendor_conversation_id, '')), '') is null
    or char_length(p_vendor_conversation_id) > 200
    or nullif(btrim(coalesce(p_vendor_conversation_url, '')), '') is null
    or char_length(p_vendor_conversation_url) > 1000 then
    raise exception using errcode = 'P0001', message = 'recovery_start_binding_mismatch';
  end if;

  if v_interview.tavus_conversation_id is not null then
    if v_interview.tavus_conversation_id = p_vendor_conversation_id then
      return 'started';
    end if;
    update public.interviews set vendor_manual_review = true,
      vendor_binding_recovery_required = false, retryable = false, updated_at = now()
      where id = p_interview_id;
    insert into public.interview_admin_audit_logs (
      actor_user_id, actor_role, actor_email, client_id, role_id, candidate_id,
      interview_id, attempt_number, action, prior_state, resulting_state,
      reason_code, request_id, success, related_adjudication_id, related_reset_id
    ) values (
      null, 'system', null, v_authorization.client_id, v_authorization.role_id,
      v_authorization.candidate_id, p_interview_id, v_interview.attempt_number,
      'vendor_binding_recovery_conflict', '{}'::jsonb,
      jsonb_build_object('manual_review', true), 'vendor_start_failure',
      left(v_request_id || ':binding:conflict', 200), false,
      v_authorization.adjudication_id, p_authorization_id
    ) on conflict do nothing;
    return 'vendor_binding_recovery_conflict';
  end if;

  if v_authorization.start_status not in ('starting', 'binding_recovery_required')
    or v_interview.vendor_start_state not in ('claimed', 'binding_recovery_required') then
    raise exception using errcode = 'P0001', message = 'recovery_start_result_conflict';
  end if;

  select * into v_existing from private.interview_vendor_binding_recovery
    where interview_id = p_interview_id for update;
  if found and (v_existing.authorization_id is distinct from p_authorization_id
    or v_existing.vendor_conversation_id is distinct from p_vendor_conversation_id
    or v_existing.vendor_external_reference is distinct from p_vendor_external_reference) then
    update public.interviews set vendor_start_state = 'manual_review',
      vendor_reconciliation_status = 'unavailable', vendor_manual_review = true,
      vendor_binding_recovery_required = false, retryable = false, updated_at = now()
      where id = p_interview_id;
    update public.interview_reset_events set start_status = 'manual_review', updated_at = now()
      where id = p_authorization_id;
    insert into public.interview_admin_audit_logs (
      actor_user_id, actor_role, actor_email, client_id, role_id, candidate_id,
      interview_id, attempt_number, action, prior_state, resulting_state,
      reason_code, request_id, success, related_adjudication_id, related_reset_id
    ) values (
      null, 'system', null, v_authorization.client_id, v_authorization.role_id,
      v_authorization.candidate_id, p_interview_id, v_interview.attempt_number,
      'vendor_binding_recovery_conflict', '{}'::jsonb,
      jsonb_build_object('manual_review', true), 'vendor_start_failure',
      left(v_request_id || ':binding:conflict', 200), false,
      v_authorization.adjudication_id, p_authorization_id
    ) on conflict do nothing;
    return 'vendor_binding_recovery_conflict';
  end if;

  insert into private.interview_vendor_binding_recovery (
    interview_id, authorization_id, vendor_create_claim_token,
    vendor_external_reference, vendor_conversation_id, vendor_conversation_url,
    effective_persona_id, effective_replica_id, effective_document_id,
    failure_code, updated_at
  ) values (
    p_interview_id, p_authorization_id, p_claim_token,
    p_vendor_external_reference, left(p_vendor_conversation_id, 200),
    left(p_vendor_conversation_url, 1000), left(p_effective_persona_id, 200),
    left(p_effective_replica_id, 200), left(p_effective_document_id, 200),
    v_failure_code, now()
  ) on conflict (interview_id) do update set
    vendor_conversation_url = excluded.vendor_conversation_url,
    effective_persona_id = excluded.effective_persona_id,
    effective_replica_id = excluded.effective_replica_id,
    effective_document_id = excluded.effective_document_id,
    failure_code = excluded.failure_code,
    updated_at = now();

  update public.interviews set status = 'Starting', retryable = false,
    failure_code = v_failure_code, failure_stage = 'database_binding',
    failure_summary = 'The provider conversation requires database binding recovery.',
    failure_at = now(), vendor_start_state = 'binding_recovery_required',
    vendor_reconciliation_status = 'binding_recovery_required',
    vendor_binding_recovery_required = true,
    vendor_binding_recovery_recorded_at = coalesce(vendor_binding_recovery_recorded_at, now()),
    vendor_manual_review = false, updated_at = now()
    where id = p_interview_id and tavus_conversation_id is null;
  update public.interview_reset_events set start_status = 'binding_recovery_required',
    start_last_failed_at = now(), start_last_failure_code = v_failure_code,
    updated_at = now()
    where id = p_authorization_id and start_status in ('starting', 'binding_recovery_required');

  insert into public.interview_admin_audit_logs (
    actor_user_id, actor_role, actor_email, client_id, role_id, candidate_id,
    interview_id, attempt_number, action, prior_state, resulting_state,
    reason_code, request_id, success, related_adjudication_id, related_reset_id
  ) values (
    null, 'system', null, v_authorization.client_id, v_authorization.role_id,
    v_authorization.candidate_id, p_interview_id, v_interview.attempt_number,
    'provider_create_succeeded_bind_failed',
    jsonb_build_object('vendor_start_state', v_interview.vendor_start_state),
    jsonb_build_object('vendor_start_state', 'binding_recovery_required',
      'vendor_conversation_id', left(p_vendor_conversation_id, 200)),
    'vendor_start_failure', left(v_request_id || ':binding:recorded', 200), false,
    v_authorization.adjudication_id, p_authorization_id
  ) on conflict do nothing;
  return 'vendor_binding_recovery_required';
end
$$;

create or replace function public.recover_interview_vendor_binding_core(
  p_interview_id uuid,
  p_authorization_id uuid,
  p_actor_user_id uuid,
  p_actor_email text default null,
  p_request_id text default null
)
returns table (status text, conversation_id text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_authorization public.interview_reset_events%rowtype;
  v_interview public.interviews%rowtype;
  v_recovery private.interview_vendor_binding_recovery%rowtype;
  v_request_id text := left(coalesce(nullif(btrim(p_request_id), ''), p_authorization_id::text), 150);
begin
  if p_actor_user_id is null or not exists (
    select 1 from public.admins a
    where a.is_active is true and (
      a.user_id = p_actor_user_id
      or (p_actor_email is not null and lower(a.email) = lower(p_actor_email))
    )
  ) then
    raise exception using errcode = 'P0001', message = 'admin_scope_required';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_authorization_id::text, 0));
  select * into v_authorization from public.interview_reset_events
    where id = p_authorization_id for update;
  select * into v_interview from public.interviews
    where id = p_interview_id for update;
  select * into v_recovery from private.interview_vendor_binding_recovery
    where interview_id = p_interview_id for update;
  if v_authorization.id is null or v_interview.id is null or v_recovery.interview_id is null
    or v_authorization.replacement_interview_id is distinct from p_interview_id
    or v_interview.replacement_authorization_id is distinct from p_authorization_id
    or v_recovery.authorization_id is distinct from p_authorization_id
    or v_interview.attempt_number is distinct from 2
    or v_recovery.vendor_create_claim_token is distinct from v_interview.vendor_create_claim_token
    or v_recovery.vendor_external_reference is distinct from v_interview.vendor_external_reference
    or v_recovery.vendor_external_reference is distinct from ('alphascreen-interview-' || p_interview_id::text) then
    raise exception using errcode = 'P0001', message = 'recovery_start_binding_mismatch';
  end if;

  if v_interview.tavus_conversation_id is not null then
    if v_interview.tavus_conversation_id = v_recovery.vendor_conversation_id then
      update private.interview_vendor_binding_recovery set
        resolved_at = coalesce(resolved_at, now()), updated_at = now()
        where interview_id = p_interview_id;
      return query select 'started'::text, v_recovery.vendor_conversation_id;
      return;
    end if;
    update public.interviews set vendor_manual_review = true,
      vendor_binding_recovery_required = false, retryable = false, updated_at = now()
      where id = p_interview_id;
    insert into public.interview_admin_audit_logs (
      actor_user_id, actor_role, actor_email, client_id, role_id, candidate_id,
      interview_id, attempt_number, action, prior_state, resulting_state,
      reason_code, request_id, success, related_adjudication_id, related_reset_id
    ) values (
      p_actor_user_id, 'admin', p_actor_email, v_authorization.client_id,
      v_authorization.role_id, v_authorization.candidate_id, p_interview_id,
      v_interview.attempt_number, 'vendor_binding_recovery_conflict', '{}'::jsonb,
      jsonb_build_object('manual_review', true), 'vendor_start_failure',
      left(v_request_id || ':binding:conflict', 200), false,
      v_authorization.adjudication_id, p_authorization_id
    ) on conflict do nothing;
    return query select 'vendor_binding_recovery_conflict'::text, null::text;
    return;
  end if;

  if v_interview.vendor_start_state <> 'binding_recovery_required'
    or v_authorization.start_status <> 'binding_recovery_required'
    or v_interview.vendor_binding_recovery_required is not true then
    raise exception using errcode = 'P0001', message = 'vendor_binding_recovery_required';
  end if;

  insert into public.interview_admin_audit_logs (
    actor_user_id, actor_role, actor_email, client_id, role_id, candidate_id,
    interview_id, attempt_number, action, prior_state, resulting_state,
    reason_code, request_id, success, related_adjudication_id, related_reset_id
  ) values (
    p_actor_user_id, 'admin', p_actor_email, v_authorization.client_id,
    v_authorization.role_id, v_authorization.candidate_id, p_interview_id,
    v_interview.attempt_number, 'vendor_binding_recovery_started',
    jsonb_build_object('vendor_start_state', 'binding_recovery_required'),
    jsonb_build_object('binding_started', true), 'vendor_start_failure',
    left(v_request_id || ':binding:started', 200), true,
    v_authorization.adjudication_id, p_authorization_id
  ) on conflict do nothing;

  update public.interviews set
    video_url = v_recovery.vendor_conversation_url,
    tavus_application_id = v_recovery.vendor_conversation_id,
    tavus_conversation_id = v_recovery.vendor_conversation_id,
    effective_persona_id = v_recovery.effective_persona_id,
    effective_replica_id = v_recovery.effective_replica_id,
    effective_tavus_document_id = v_recovery.effective_document_id,
    status = 'Pending', retryable = false, failure_code = null,
    failure_stage = null, failure_summary = null, failure_at = null,
    vendor_start_state = 'started', vendor_failure_category = null,
    vendor_failure_code = null, vendor_reconciliation_status = 'resolved',
    vendor_reconciliation_resolved_at = now(),
    vendor_resolution_source = 'database_binding_recovery',
    vendor_binding_recovery_required = false, vendor_manual_review = false,
    updated_at = now()
    where id = p_interview_id and tavus_conversation_id is null
      and vendor_start_state = 'binding_recovery_required';
  if not found then
    raise exception using errcode = 'P0001', message = 'recovery_start_result_conflict';
  end if;
  update public.interview_reset_events set start_status = 'started',
    start_last_failure_code = null, updated_at = now()
    where id = p_authorization_id and start_status = 'binding_recovery_required';
  update public.candidates set interview_status = 'Started',
    interview_video_url = v_recovery.vendor_conversation_url,
    candidate_external_id = v_recovery.vendor_conversation_id
    where id = v_authorization.candidate_id;
  update private.interview_vendor_binding_recovery set resolved_at = now(), updated_at = now()
    where interview_id = p_interview_id;
  insert into public.interview_admin_audit_logs (
    actor_user_id, actor_role, actor_email, client_id, role_id, candidate_id,
    interview_id, attempt_number, action, prior_state, resulting_state,
    reason_code, request_id, success, related_adjudication_id, related_reset_id
  ) values (
    p_actor_user_id, 'admin', p_actor_email, v_authorization.client_id,
    v_authorization.role_id, v_authorization.candidate_id, p_interview_id,
    v_interview.attempt_number, 'vendor_binding_recovery_resolved',
    jsonb_build_object('vendor_start_state', 'binding_recovery_required'),
    jsonb_build_object('vendor_start_state', 'started',
      'vendor_conversation_id', v_recovery.vendor_conversation_id),
    v_authorization.reason_code, left(v_request_id || ':binding:resolved', 200), true,
    v_authorization.adjudication_id, p_authorization_id
  ) on conflict do nothing;
  return query select 'started'::text, v_recovery.vendor_conversation_id;
end
$$;

create or replace function public.claim_interview_recovery_reconciliation_core(
  p_interview_id uuid,
  p_authorization_id uuid,
  p_request_id text default null
)
returns table (
  claimed boolean,
  claim_token uuid,
  vendor_external_reference text,
  ambiguous_at timestamptz,
  reconciliation_attempt_count integer,
  state text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_authorization public.interview_reset_events%rowtype;
  v_interview public.interviews%rowtype;
  v_token uuid := gen_random_uuid();
  v_count integer;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_authorization_id::text, 0));
  select * into v_authorization from public.interview_reset_events
    where id = p_authorization_id for update;
  select * into v_interview from public.interviews
    where id = p_interview_id for update;
  if v_authorization.id is null or v_interview.id is null
    or v_authorization.replacement_interview_id is distinct from p_interview_id
    or v_interview.replacement_authorization_id is distinct from p_authorization_id then
    raise exception using errcode = 'P0001', message = 'recovery_start_binding_mismatch';
  end if;
  if v_authorization.start_status = 'started' or v_interview.tavus_conversation_id is not null then
    return query select false, null::uuid, v_interview.vendor_external_reference,
      v_interview.vendor_ambiguous_at, coalesce(v_interview.vendor_reconciliation_attempt_count, 0),
      'started'::text;
    return;
  end if;
  if v_authorization.start_status = 'manual_review' or v_interview.vendor_manual_review is true then
    return query select false, null::uuid, v_interview.vendor_external_reference,
      v_interview.vendor_ambiguous_at, coalesce(v_interview.vendor_reconciliation_attempt_count, 0),
      'vendor_reconciliation_manual_review'::text;
    return;
  end if;
  if v_authorization.start_status = 'binding_recovery_required'
    or v_interview.vendor_start_state = 'binding_recovery_required' then
    return query select false, null::uuid, v_interview.vendor_external_reference,
      v_interview.vendor_ambiguous_at, coalesce(v_interview.vendor_reconciliation_attempt_count, 0),
      'vendor_binding_recovery_required'::text;
    return;
  end if;
  if v_authorization.start_status = 'reconciling' then
    return query select false, null::uuid, v_interview.vendor_external_reference,
      v_interview.vendor_ambiguous_at, coalesce(v_interview.vendor_reconciliation_attempt_count, 0),
      'vendor_reconciliation_in_progress'::text;
    return;
  end if;
  if v_authorization.start_status <> 'reconciliation_required'
    or v_interview.vendor_start_state <> 'reconciliation_required'
    or v_interview.vendor_external_reference is null then
    raise exception using errcode = 'P0001', message = 'vendor_reconciliation_required';
  end if;
  v_count := coalesce(v_interview.vendor_reconciliation_attempt_count, 0) + 1;
  if v_count > 20 then
    raise exception using errcode = 'P0001', message = 'vendor_reconciliation_manual_review';
  end if;
  update public.interviews set
    vendor_start_state = 'reconciling', vendor_reconciliation_status = 'in_progress',
    vendor_reconciliation_claim_token = v_token,
    vendor_reconciliation_attempt_count = v_count,
    vendor_reconciliation_last_at = now(), updated_at = now()
  where id = p_interview_id and tavus_conversation_id is null;
  update public.interview_reset_events set start_status = 'reconciling', updated_at = now()
    where id = p_authorization_id and start_status = 'reconciliation_required';
  if not found then
    return query select false, null::uuid, v_interview.vendor_external_reference,
      v_interview.vendor_ambiguous_at, v_count - 1, 'vendor_reconciliation_in_progress'::text;
    return;
  end if;
  insert into public.interview_admin_audit_logs (
    actor_user_id, actor_role, actor_email, client_id, role_id, candidate_id,
    interview_id, attempt_number, action, prior_state, resulting_state,
    reason_code, request_id, success, related_adjudication_id, related_reset_id
  ) values (
    null, 'system', null, v_authorization.client_id, v_authorization.role_id,
    v_authorization.candidate_id, p_interview_id, v_interview.attempt_number,
    'vendor_reconciliation_started',
    jsonb_build_object('vendor_start_state', 'reconciliation_required'),
    jsonb_build_object('vendor_start_state', 'reconciling', 'reconciliation_attempt_count', v_count),
    'vendor_start_failure',
    left(coalesce(nullif(btrim(p_request_id), ''), p_authorization_id::text) || ':reconcile:' || v_count::text || ':started', 200),
    true, v_authorization.adjudication_id, p_authorization_id
  );
  return query select true, v_token, v_interview.vendor_external_reference,
    v_interview.vendor_ambiguous_at, v_count, 'vendor_reconciliation_in_progress'::text;
end
$$;

create or replace function public.complete_interview_recovery_reconciliation_core(
  p_interview_id uuid,
  p_authorization_id uuid,
  p_claim_token uuid,
  p_outcome text,
  p_vendor_conversation_id text default null,
  p_vendor_conversation_url text default null,
  p_request_id text default null,
  p_match_references text[] default null,
  p_total_exact_match_count integer default null,
  p_stored_match_reference_count integer default 0,
  p_match_references_truncated boolean default false,
  p_scan_complete boolean default false,
  p_scan_status text default 'unavailable',
  p_pages_requested integer default 0,
  p_pages_completed integer default 0,
  p_total_count_reported integer default null
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_authorization public.interview_reset_events%rowtype;
  v_interview public.interviews%rowtype;
  v_outcome text := lower(coalesce(nullif(btrim(p_outcome), ''), 'unavailable'));
  v_status text;
  v_action text;
  v_result_state text;
  v_scan_status text := lower(coalesce(nullif(btrim(p_scan_status), ''), 'unavailable'));
  v_match_references text[];
begin
  perform pg_advisory_xact_lock(hashtextextended(p_authorization_id::text, 0));
  select * into v_authorization from public.interview_reset_events
    where id = p_authorization_id for update;
  select * into v_interview from public.interviews
    where id = p_interview_id for update;
  if v_authorization.id is null or v_interview.id is null
    or v_authorization.replacement_interview_id is distinct from p_interview_id
    or v_interview.replacement_authorization_id is distinct from p_authorization_id then
    raise exception using errcode = 'P0001', message = 'recovery_start_binding_mismatch';
  end if;
  if v_authorization.start_status = 'started' or v_interview.tavus_conversation_id is not null then
    return 'started';
  end if;
  if v_authorization.start_status <> 'reconciling'
    or v_interview.vendor_start_state <> 'reconciling'
    or p_claim_token is null
    or v_interview.vendor_reconciliation_claim_token is distinct from p_claim_token then
    raise exception using errcode = 'P0001', message = 'recovery_start_result_conflict';
  end if;
  if v_outcome not in ('resolved', 'no_match', 'multiple_matches', 'unavailable') then
    raise exception using errcode = 'P0001', message = 'recovery_start_result_conflict';
  end if;

  v_match_references := array(
    select left(reference_value, 200)
    from unnest(coalesce(p_match_references, array[]::text[])) as reference_value
    where nullif(btrim(reference_value), '') is not null
    limit 10
  );
  if p_stored_match_reference_count <> cardinality(v_match_references)
    or p_stored_match_reference_count not between 0 and 10
    or p_pages_requested not between 0 and 25
    or p_pages_completed not between 0 and p_pages_requested
    or (p_total_count_reported is not null and p_total_count_reported < 0)
    or v_scan_status not in (
      'complete', 'incomplete_missing_total', 'incomplete_unstable_total',
      'incomplete_repeated_page', 'incomplete_malformed_page',
      'incomplete_short_page', 'incomplete_page_limit',
      'incomplete_multi_page_unsupported', 'unavailable'
    ) then
    raise exception using errcode = 'P0001', message = 'recovery_start_result_conflict';
  end if;

  if p_scan_complete is true then
    if v_scan_status <> 'complete' or p_total_exact_match_count is null
      or p_total_exact_match_count < 0 or p_total_count_reported is null then
      raise exception using errcode = 'P0001', message = 'recovery_start_result_conflict';
    end if;
    if (v_outcome = 'resolved' and (
        p_total_exact_match_count is distinct from 1
        or p_stored_match_reference_count is distinct from 1
        or cardinality(v_match_references) is distinct from 1
        or v_match_references[1] is distinct from p_vendor_conversation_id
        or p_match_references_truncated is distinct from false
        or p_pages_requested is distinct from 1
        or p_pages_completed is distinct from 1
        or p_total_count_reported is null
        or p_total_count_reported < 1
        or p_total_count_reported > 100))
      or (v_outcome = 'no_match' and p_total_exact_match_count <> 0)
      or (v_outcome = 'multiple_matches' and p_total_exact_match_count <= 1)
      or v_outcome = 'unavailable' then
      raise exception using errcode = 'P0001', message = 'recovery_start_result_conflict';
    end if;
  elsif v_outcome <> 'unavailable' or v_scan_status = 'complete'
    or p_total_exact_match_count is not null then
    raise exception using errcode = 'P0001', message = 'recovery_start_result_conflict';
  end if;

  if v_outcome = 'resolved' then
    if nullif(btrim(coalesce(p_vendor_conversation_id, '')), '') is null
      or nullif(btrim(coalesce(p_vendor_conversation_url, '')), '') is null then
      raise exception using errcode = 'P0001', message = 'recovery_start_vendor_identity_required';
    end if;
    update public.interviews set
      video_url = left(p_vendor_conversation_url, 1000),
      tavus_application_id = left(p_vendor_conversation_id, 200),
      tavus_conversation_id = left(p_vendor_conversation_id, 200),
      status = 'Pending', retryable = false, failure_code = null,
      failure_stage = null, failure_summary = null, failure_at = null,
      vendor_start_state = 'started', vendor_reconciliation_status = 'resolved',
      vendor_reconciliation_resolved_at = now(), vendor_resolution_source = 'list_exact_conversation_name',
      vendor_reconciliation_claim_token = null, vendor_manual_review = false,
      vendor_reconciliation_total_exact_match_count = p_total_exact_match_count,
      vendor_reconciliation_stored_match_reference_count = p_stored_match_reference_count,
      vendor_reconciliation_match_references_truncated = p_match_references_truncated,
      vendor_reconciliation_match_references = v_match_references,
      vendor_reconciliation_scan_complete = p_scan_complete,
      vendor_reconciliation_scan_status = v_scan_status,
      vendor_reconciliation_pages_requested = p_pages_requested,
      vendor_reconciliation_pages_completed = p_pages_completed,
      vendor_reconciliation_total_count_reported = p_total_count_reported,
      vendor_binding_recovery_required = false, updated_at = now()
    where id = p_interview_id and tavus_conversation_id is null
      and vendor_reconciliation_claim_token = p_claim_token;
    if not found then
      raise exception using errcode = 'P0001', message = 'recovery_start_result_conflict';
    end if;
    update public.interview_reset_events set start_status = 'started',
      start_last_failure_code = null, updated_at = now()
      where id = p_authorization_id and start_status = 'reconciling';
    update public.candidates set interview_status = 'Started',
      interview_video_url = left(p_vendor_conversation_url, 1000),
      candidate_external_id = left(p_vendor_conversation_id, 200)
      where id = v_authorization.candidate_id;
    v_status := 'started';
    v_action := 'vendor_reconciliation_resolved';
    v_result_state := 'started';
  else
    update public.interviews set status = 'Starting', vendor_start_state = 'manual_review',
      vendor_reconciliation_status = case
        when v_outcome = 'no_match' then 'no_match_pending'
        when v_outcome = 'multiple_matches' then 'multiple_matches'
        else 'unavailable' end,
      vendor_reconciliation_claim_token = null, vendor_manual_review = true,
      vendor_reconciliation_total_exact_match_count = p_total_exact_match_count,
      vendor_reconciliation_stored_match_reference_count = p_stored_match_reference_count,
      vendor_reconciliation_match_references_truncated = p_match_references_truncated,
      vendor_reconciliation_match_references = case when cardinality(v_match_references) = 0 then null else v_match_references end,
      vendor_reconciliation_scan_complete = p_scan_complete,
      vendor_reconciliation_scan_status = v_scan_status,
      vendor_reconciliation_pages_requested = p_pages_requested,
      vendor_reconciliation_pages_completed = p_pages_completed,
      vendor_reconciliation_total_count_reported = p_total_count_reported,
      retryable = false, updated_at = now()
      where id = p_interview_id and vendor_reconciliation_claim_token = p_claim_token;
    update public.interview_reset_events set start_status = 'manual_review', updated_at = now()
      where id = p_authorization_id and start_status = 'reconciling';
    v_status := 'vendor_reconciliation_manual_review';
    v_action := case
      when v_outcome = 'no_match' then 'vendor_reconciliation_no_match'
      when v_outcome = 'multiple_matches' then 'vendor_reconciliation_multiple_matches'
      else 'vendor_reconciliation_unavailable' end;
    v_result_state := 'manual_review';
  end if;

  insert into public.interview_admin_audit_logs (
    actor_user_id, actor_role, actor_email, client_id, role_id, candidate_id,
    interview_id, attempt_number, action, prior_state, resulting_state,
    reason_code, request_id, success, related_adjudication_id, related_reset_id
  ) values (
    null, 'system', null, v_authorization.client_id, v_authorization.role_id,
    v_authorization.candidate_id, p_interview_id, v_interview.attempt_number,
    v_action, jsonb_build_object('vendor_start_state', 'reconciling'),
    jsonb_build_object('vendor_start_state', v_result_state,
      'vendor_conversation_id', case when v_outcome = 'resolved' then left(p_vendor_conversation_id, 200) else null end,
      'total_exact_match_count', p_total_exact_match_count,
      'stored_match_reference_count', p_stored_match_reference_count,
      'match_references_truncated', p_match_references_truncated,
      'match_references', case when cardinality(v_match_references) > 0 then to_jsonb(v_match_references) else null end,
      'scan_complete', p_scan_complete,
      'scan_status', v_scan_status,
      'pages_requested', p_pages_requested,
      'pages_completed', p_pages_completed,
      'total_count_reported', p_total_count_reported),
    'vendor_start_failure',
    left(coalesce(nullif(btrim(p_request_id), ''), p_authorization_id::text) || ':reconcile:' ||
      coalesce(v_interview.vendor_reconciliation_attempt_count, 0)::text || ':' || v_outcome, 200),
    v_outcome = 'resolved', v_authorization.adjudication_id, p_authorization_id
  );
  return v_status;
end
$$;

create or replace function public.claim_interview_recovery_email_core(p_authorization_id uuid)
returns table (claimed boolean, claim_token uuid, attempt_count integer)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_authorization public.interview_reset_events%rowtype;
  v_token uuid := gen_random_uuid();
begin
  perform pg_advisory_xact_lock(hashtextextended(p_authorization_id::text, 0));
  select * into v_authorization from public.interview_reset_events
  where id = p_authorization_id for update;
  if not found or v_authorization.reset_mode <> 'reset_and_send'
    or v_authorization.email_status <> 'pending'
    or v_authorization.email_attempt_count >= 1 then
    return query select false, null::uuid, coalesce(v_authorization.email_attempt_count, 0);
    return;
  end if;
  update public.interview_reset_events set
    email_status = 'sending', email_claimed_at = now(),
    email_claim_token = v_token, email_claim_expires_at = now() + interval '10 minutes',
    email_attempt_count = email_attempt_count + 1, updated_at = now()
  where id = p_authorization_id;
  insert into public.interview_admin_audit_logs (
    actor_user_id, actor_role, actor_email, client_id, role_id, candidate_id,
    interview_id, attempt_number, action, prior_state, resulting_state,
    reason_code, request_id, success, related_adjudication_id, related_reset_id
  ) values (
    null, 'system', null, v_authorization.client_id, v_authorization.role_id,
    v_authorization.candidate_id, v_authorization.previous_interview_id,
    null, 'recovery_email_claimed', jsonb_build_object('email_status', 'pending'),
    jsonb_build_object('email_status', 'sending'), v_authorization.reason_code,
    p_authorization_id::text || ':email:claim', true,
    v_authorization.adjudication_id, p_authorization_id
  );
  return query select true, v_token, v_authorization.email_attempt_count + 1;
end
$$;

create or replace function public.complete_interview_recovery_email_core(
  p_authorization_id uuid,
  p_claim_token uuid,
  p_success boolean,
  p_failure_code text default null
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_authorization public.interview_reset_events%rowtype;
  v_status text;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_authorization_id::text, 0));
  select * into v_authorization from public.interview_reset_events
  where id = p_authorization_id for update;
  if not found or v_authorization.email_status <> 'sending'
    or v_authorization.email_claim_token is distinct from p_claim_token then
    raise exception using errcode = 'P0001', message = 'recovery_email_claim_mismatch';
  end if;
  v_status := case when p_success then 'sent' else 'failed' end;
  update public.interview_reset_events set
    email_status = v_status,
    email_sent_at = case when p_success then now() else email_sent_at end,
    email_failed_at = case when p_success then email_failed_at else now() end,
    email_failure_summary = case when p_success then null
      else left(coalesce(nullif(btrim(p_failure_code), ''), 'delivery_failed'), 500) end,
    email_claim_token = null, email_claim_expires_at = null, updated_at = now()
  where id = p_authorization_id;
  insert into public.interview_admin_audit_logs (
    actor_user_id, actor_role, actor_email, client_id, role_id, candidate_id,
    interview_id, attempt_number, action, prior_state, resulting_state,
    reason_code, request_id, success, related_adjudication_id, related_reset_id
  ) values (
    null, 'system', null, v_authorization.client_id, v_authorization.role_id,
    v_authorization.candidate_id, v_authorization.previous_interview_id,
    null, case when p_success then 'recovery_email_sent' else 'recovery_email_failed' end,
    jsonb_build_object('email_status', 'sending'),
    jsonb_build_object('email_status', v_status,
      'failure_code', case when p_success then null else left(coalesce(p_failure_code, 'delivery_failed'), 100) end),
    v_authorization.reason_code, p_authorization_id::text || ':email:complete',
    p_success, v_authorization.adjudication_id, p_authorization_id
  );
  return v_status;
end
$$;

revoke all on table public.interview_adjudications from anon, authenticated;
revoke all on table public.interview_admin_audit_logs from anon, authenticated;
revoke all on table private.interview_vendor_binding_recovery from public, anon, authenticated, service_role;
revoke all on function public.get_interview_recovery_core_eligibility(uuid, uuid, uuid, uuid) from public, anon, authenticated;
revoke all on function public.authorize_interview_replacement_core(uuid, uuid, uuid, uuid, uuid, text, text, text, text, text, text, boolean, boolean, uuid) from public, anon, authenticated;
revoke all on function public.claim_candidate_interview_attempt_core(uuid, uuid, uuid) from public, anon, authenticated;
revoke all on function public.complete_interview_recovery_start_core(uuid, uuid, boolean, text, text, text, text, text, text, text, text, text, uuid, text) from public, anon, authenticated;
revoke all on function public.record_interview_recovery_binding_failure_core(uuid, uuid, uuid, text, text, text, text, text, text, text, text) from public, anon, authenticated;
revoke all on function public.recover_interview_vendor_binding_core(uuid, uuid, uuid, text, text) from public, anon, authenticated;
revoke all on function public.claim_interview_recovery_reconciliation_core(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.complete_interview_recovery_reconciliation_core(uuid, uuid, uuid, text, text, text, text, text[], integer, integer, boolean, boolean, text, integer, integer, integer) from public, anon, authenticated;
revoke all on function public.claim_interview_recovery_email_core(uuid) from public, anon, authenticated;
revoke all on function public.complete_interview_recovery_email_core(uuid, uuid, boolean, text) from public, anon, authenticated;

grant all on table public.interview_adjudications to service_role;
grant all on table public.interview_admin_audit_logs to service_role;
grant execute on function public.get_interview_recovery_core_eligibility(uuid, uuid, uuid, uuid) to service_role;
grant execute on function public.authorize_interview_replacement_core(uuid, uuid, uuid, uuid, uuid, text, text, text, text, text, text, boolean, boolean, uuid) to service_role;
grant execute on function public.claim_candidate_interview_attempt_core(uuid, uuid, uuid) to service_role;
grant execute on function public.complete_interview_recovery_start_core(uuid, uuid, boolean, text, text, text, text, text, text, text, text, text, uuid, text) to service_role;
grant execute on function public.record_interview_recovery_binding_failure_core(uuid, uuid, uuid, text, text, text, text, text, text, text, text) to service_role;
grant execute on function public.recover_interview_vendor_binding_core(uuid, uuid, uuid, text, text) to service_role;
grant execute on function public.claim_interview_recovery_reconciliation_core(uuid, uuid, text) to service_role;
grant execute on function public.complete_interview_recovery_reconciliation_core(uuid, uuid, uuid, text, text, text, text, text[], integer, integer, boolean, boolean, text, integer, integer, integer) to service_role;
grant execute on function public.claim_interview_recovery_email_core(uuid) to service_role;
grant execute on function public.complete_interview_recovery_email_core(uuid, uuid, boolean, text) to service_role;

comment on table public.interview_adjudications is
  'Immutable manual interview adjudications. Phase B-Core is the predecessor for the full B2R table.';
comment on table public.interview_admin_audit_logs is
  'Immutable bounded records of consequential recovery and integrity actions; not a raw event stream.';
comment on column public.interview_reset_events.authorization_status is
  'Manual replacement authorization lifecycle. The replacement interview is created only on candidate Start.';
