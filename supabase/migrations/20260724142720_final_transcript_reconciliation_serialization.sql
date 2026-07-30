-- Database-serialized final-transcript reconciliation.
-- This migration is additive and does not classify or mutate historical rows.

create schema if not exists private;

alter table public.interviews
  add column if not exists conversation_id text null,
  add column if not exists transcript_scores jsonb not null default '{}'::jsonb,
  add column if not exists interview_summary text null,
  add column if not exists unanswered_candidate_questions text[] not null default '{}'::text[],
  add column if not exists interview_analysis_v2 jsonb null;

do $$
declare
  v_expected record;
  v_actual_type oid;
  v_actual_typmod integer;
  v_not_null boolean;
  v_default_expression text;
  v_generated text;
  v_identity text;
  v_dimensions integer;
  v_collation oid;
begin
  for v_expected in
    select *
    from (values
      (
        'conversation_id',
        'text'::regtype::oid,
        -1,
        false,
        null::text,
        0,
        'pg_catalog."default"'::regcollation::oid
      ),
      (
        'transcript_scores',
        'jsonb'::regtype::oid,
        -1,
        true,
        '''{}''::jsonb',
        0,
        0::oid
      ),
      (
        'interview_summary',
        'text'::regtype::oid,
        -1,
        false,
        null::text,
        0,
        'pg_catalog."default"'::regcollation::oid
      ),
      (
        'unanswered_candidate_questions',
        'text[]'::regtype::oid,
        -1,
        true,
        '''{}''::text[]',
        1,
        'pg_catalog."default"'::regcollation::oid
      ),
      (
        'interview_analysis_v2',
        'jsonb'::regtype::oid,
        -1,
        false,
        null::text,
        0,
        0::oid
      )
    ) as expected(
      column_name,
      expected_type,
      expected_typmod,
      expected_not_null,
      expected_default_expression,
      expected_dimensions,
      expected_collation
    )
  loop
    select
      attribute.atttypid,
      attribute.atttypmod,
      attribute.attnotnull,
      pg_catalog.pg_get_expr(
        default_definition.adbin,
        default_definition.adrelid
      ),
      attribute.attgenerated::text,
      attribute.attidentity::text,
      attribute.attndims,
      attribute.attcollation
    into
      v_actual_type,
      v_actual_typmod,
      v_not_null,
      v_default_expression,
      v_generated,
      v_identity,
      v_dimensions,
      v_collation
    from pg_catalog.pg_attribute as attribute
    left join pg_catalog.pg_attrdef as default_definition
      on default_definition.adrelid = attribute.attrelid
      and default_definition.adnum = attribute.attnum
    where attribute.attrelid = 'public.interviews'::regclass
      and attribute.attname = v_expected.column_name
      and attribute.attnum > 0
      and not attribute.attisdropped;

    if not found
      or v_actual_type <> v_expected.expected_type
      or v_actual_typmod <> v_expected.expected_typmod
      or v_not_null <> v_expected.expected_not_null
      or v_default_expression is distinct from
        v_expected.expected_default_expression
      or v_generated <> ''
      or v_identity <> ''
      or v_dimensions <> v_expected.expected_dimensions
      or v_collation <> v_expected.expected_collation then
      raise exception using
        errcode = 'P0001',
        message = 'final_transcript_interview_column_contract_mismatch',
        detail = format('column=%I category=definition', v_expected.column_name);
    end if;
  end loop;
end
$$;

create or replace function private.is_valid_interview_unanswered_questions(
  p_questions jsonb
)
returns boolean
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_question jsonb;
  v_question_text text;
  v_seen text[] := array[]::text[];
  v_count integer := 0;
begin
  if p_questions is null
    or jsonb_typeof(p_questions) <> 'array' then
    return false;
  end if;
  if jsonb_array_length(p_questions) not between 1 and 10
    or octet_length(p_questions::text) > 10000 then
    return false;
  end if;

  for v_question in select value from jsonb_array_elements(p_questions)
  loop
    if jsonb_typeof(v_question) <> 'string' then
      return false;
    end if;
    v_question_text := v_question #>> '{}';
    if v_question_text is null
      or char_length(v_question_text) not between 1 and 1000
      or v_question_text ~ '^[[:space:]]'
      or v_question_text ~ '[[:space:]]$'
      or v_question_text = any(v_seen) then
      return false;
    end if;
    v_seen := array_append(v_seen, v_question_text);
    v_count := v_count + 1;
  end loop;

  return v_count between 1 and 10;
exception
  when others then
    return false;
end
$$;

create or replace function private.is_valid_interview_analysis_v2(
  p_analysis jsonb
)
returns boolean
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_key text;
  v_value jsonb;
  v_has_numeric_score boolean := false;
begin
  if p_analysis is null
    or jsonb_typeof(p_analysis) <> 'object'
    or octet_length(p_analysis::text) > 32768
    or (select count(*) from pg_catalog.jsonb_object_keys(p_analysis)) <> 7
    or not (p_analysis ?& array[
      'version',
      'scores',
      'conditions',
      'risk',
      'evidence_summary',
      'evidence',
      'limitations'
    ])
    or p_analysis ->> 'version' <> 'path_a_v1'
    or jsonb_typeof(p_analysis -> 'scores') <> 'object'
    or jsonb_typeof(p_analysis -> 'conditions') <> 'object'
    or jsonb_typeof(p_analysis -> 'risk') <> 'object'
    or jsonb_typeof(p_analysis -> 'evidence_summary') <> 'string'
    or jsonb_typeof(p_analysis -> 'evidence') <> 'array'
    or jsonb_typeof(p_analysis -> 'limitations') <> 'array'
    or char_length(p_analysis ->> 'evidence_summary') > 1200 then
    return false;
  end if;

  if (select count(*) from pg_catalog.jsonb_object_keys(p_analysis -> 'scores')) <> 4
    or not ((p_analysis -> 'scores') ?& array[
      'response_specificity',
      'answer_directness',
      'answer_consistency',
      'communication_structure'
    ]) then
    return false;
  end if;
  for v_key, v_value in select key, value from jsonb_each(p_analysis -> 'scores')
  loop
    if jsonb_typeof(v_value) = 'number' then
      if (v_value #>> '{}')::numeric < 0
        or (v_value #>> '{}')::numeric > 100 then
        return false;
      end if;
      v_has_numeric_score := true;
    elsif jsonb_typeof(v_value) <> 'null' then
      return false;
    end if;
  end loop;

  if (select count(*) from pg_catalog.jsonb_object_keys(p_analysis -> 'conditions')) <> 4
    or not ((p_analysis -> 'conditions') ?& array[
      'evaluation_conditions',
      'audio_quality_issues',
      'distraction_risk',
      'signal_confidence'
    ])
    or jsonb_typeof(p_analysis -> 'conditions' -> 'evaluation_conditions') <> 'string'
    or jsonb_typeof(p_analysis -> 'conditions' -> 'audio_quality_issues') <> 'string'
    or jsonb_typeof(p_analysis -> 'conditions' -> 'distraction_risk') <> 'string'
    or jsonb_typeof(p_analysis -> 'conditions' -> 'signal_confidence') <> 'string'
    or p_analysis -> 'conditions' ->> 'evaluation_conditions'
      not in ('good', 'mixed', 'limited', 'unavailable')
    or p_analysis -> 'conditions' ->> 'audio_quality_issues'
      not in ('none', 'low', 'medium', 'high', 'unavailable')
    or p_analysis -> 'conditions' ->> 'distraction_risk'
      not in ('low', 'medium', 'high', 'unavailable')
    or p_analysis -> 'conditions' ->> 'signal_confidence'
      not in ('low', 'medium', 'high', 'unavailable') then
    return false;
  end if;

  if (select count(*) from pg_catalog.jsonb_object_keys(p_analysis -> 'risk')) <> 2
    or not ((p_analysis -> 'risk') ?& array['integrity_risk', 'reason'])
    or jsonb_typeof(p_analysis -> 'risk' -> 'integrity_risk') <> 'string'
    or p_analysis -> 'risk' ->> 'integrity_risk'
      not in ('low', 'medium', 'high', 'unavailable')
    or jsonb_typeof(p_analysis -> 'risk' -> 'reason') <> 'string'
    or char_length(p_analysis -> 'risk' ->> 'reason') > 700 then
    return false;
  end if;

  if jsonb_array_length(p_analysis -> 'evidence') > 12
    or jsonb_array_length(p_analysis -> 'limitations') > 8 then
    return false;
  end if;
  for v_value in select value from jsonb_array_elements(p_analysis -> 'evidence')
  loop
    if jsonb_typeof(v_value) <> 'string'
      or char_length(v_value #>> '{}') not between 1 and 260 then
      return false;
    end if;
  end loop;
  for v_value in select value from jsonb_array_elements(p_analysis -> 'limitations')
  loop
    if jsonb_typeof(v_value) <> 'string'
      or char_length(v_value #>> '{}') not between 1 and 260 then
      return false;
    end if;
  end loop;

  if v_has_numeric_score
    and (
      btrim(p_analysis ->> 'evidence_summary') = ''
      or jsonb_array_length(p_analysis -> 'evidence') = 0
    ) then
    return false;
  end if;

  return true;
exception
  when others then
    return false;
end
$$;

create or replace function private.is_valid_interview_transcript_scores(
  p_scores jsonb
)
returns boolean
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_key text;
  v_value jsonb;
  v_numeric numeric;
  v_null_primary_count integer := 0;
  v_trim_characters text := E' \t\n\r\v\f'
    || pg_catalog.chr(160)
    || pg_catalog.chr(5760)
    || pg_catalog.chr(8192)
    || pg_catalog.chr(8193)
    || pg_catalog.chr(8194)
    || pg_catalog.chr(8195)
    || pg_catalog.chr(8196)
    || pg_catalog.chr(8197)
    || pg_catalog.chr(8198)
    || pg_catalog.chr(8199)
    || pg_catalog.chr(8200)
    || pg_catalog.chr(8201)
    || pg_catalog.chr(8202)
    || pg_catalog.chr(8232)
    || pg_catalog.chr(8233)
    || pg_catalog.chr(8239)
    || pg_catalog.chr(8287)
    || pg_catalog.chr(12288)
    || pg_catalog.chr(65279);
begin
  if p_scores is null
    or pg_catalog.jsonb_typeof(p_scores) <> 'object'
    or pg_catalog.octet_length(p_scores::text) > 16384
    or (
      select pg_catalog.count(*)
      from pg_catalog.jsonb_object_keys(p_scores)
    ) <> 7
    or not (p_scores ?& array[
      'overall',
      'role_fit',
      'technical_strength',
      'communication_quality',
      'confidence',
      'ai_aided_risk',
      'ai_aided_risk_reason'
    ]) then
    return false;
  end if;

  foreach v_key in array array[
    'overall',
    'role_fit',
    'technical_strength',
    'communication_quality'
  ]
  loop
    v_value := p_scores -> v_key;
    if pg_catalog.jsonb_typeof(v_value) = 'null' then
      v_null_primary_count := v_null_primary_count + 1;
    elsif pg_catalog.jsonb_typeof(v_value) = 'number' then
      v_numeric := (v_value #>> '{}')::numeric;
      if v_numeric <> pg_catalog.trunc(v_numeric)
        or v_numeric < 0
        or v_numeric > 100 then
        return false;
      end if;
    else
      return false;
    end if;
  end loop;
  if v_null_primary_count not in (0, 4) then
    return false;
  end if;

  v_value := p_scores -> 'confidence';
  if pg_catalog.jsonb_typeof(v_value) = 'number' then
    v_numeric := (v_value #>> '{}')::numeric;
    if v_numeric <> pg_catalog.trunc(v_numeric)
      or v_numeric < 0
      or v_numeric > 100 then
      return false;
    end if;
  elsif pg_catalog.jsonb_typeof(v_value) <> 'null' then
    return false;
  end if;

  if pg_catalog.jsonb_typeof(p_scores -> 'ai_aided_risk') <> 'string'
    or p_scores ->> 'ai_aided_risk' not in ('low', 'medium', 'high')
    or pg_catalog.jsonb_typeof(p_scores -> 'ai_aided_risk_reason') <> 'string'
    or p_scores ->> 'ai_aided_risk_reason'
      is distinct from pg_catalog.btrim(
        p_scores ->> 'ai_aided_risk_reason',
        v_trim_characters
      )
    or pg_catalog.char_length(p_scores ->> 'ai_aided_risk_reason') > 300 then
    return false;
  end if;

  return true;
exception
  when others then
    return false;
end
$$;

create or replace function private.is_valid_interview_final_transcript_snapshot(
  p_snapshot jsonb
)
returns boolean
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_key text;
  v_value jsonb;
  v_candidate_count numeric;
  v_substantive_count numeric;
  v_word_count numeric;
  v_classification_total numeric;
  v_classification_substantive numeric;
begin
  if p_snapshot is null
    or jsonb_typeof(p_snapshot) <> 'object'
    or octet_length(p_snapshot::text) > 4096 then
    return false;
  end if;

  for v_key in select jsonb_object_keys(p_snapshot)
  loop
    if v_key <> all (array[
      'has_substantive_response',
      'substantive_response_count',
      'candidate_utterance_count',
      'candidate_word_count',
      'classification_counts',
      'conversation_progress_state'
    ]) then
      return false;
    end if;
  end loop;

  if not (
    p_snapshot ? 'has_substantive_response'
    and p_snapshot ? 'substantive_response_count'
    and p_snapshot ? 'candidate_utterance_count'
    and p_snapshot ? 'candidate_word_count'
    and p_snapshot ? 'classification_counts'
    and p_snapshot ? 'conversation_progress_state'
  ) then
    return false;
  end if;

  if jsonb_typeof(p_snapshot -> 'has_substantive_response') <> 'boolean'
    or jsonb_typeof(p_snapshot -> 'substantive_response_count') <> 'number'
    or jsonb_typeof(p_snapshot -> 'candidate_utterance_count') <> 'number'
    or jsonb_typeof(p_snapshot -> 'candidate_word_count') <> 'number'
    or jsonb_typeof(p_snapshot -> 'classification_counts') <> 'object'
    or jsonb_typeof(p_snapshot -> 'conversation_progress_state') <> 'string' then
    return false;
  end if;

  if (p_snapshot ->> 'substantive_response_count') !~ '^(0|[1-9][0-9]*)$'
    or (p_snapshot ->> 'candidate_utterance_count') !~ '^(0|[1-9][0-9]*)$'
    or (p_snapshot ->> 'candidate_word_count') !~ '^(0|[1-9][0-9]*)$' then
    return false;
  end if;

  v_substantive_count := (p_snapshot ->> 'substantive_response_count')::numeric;
  v_candidate_count := (p_snapshot ->> 'candidate_utterance_count')::numeric;
  v_word_count := (p_snapshot ->> 'candidate_word_count')::numeric;
  if v_substantive_count > 2147483647
    or v_candidate_count > 2147483647
    or v_word_count > 2147483647 then
    return false;
  end if;

  v_classification_total := 0;
  v_classification_substantive := 0;
  for v_key, v_value in
    select key, value from jsonb_each(p_snapshot -> 'classification_counts')
  loop
    if v_key <> all (array[
      'acknowledgment',
      'repeat_request',
      'hearing_or_audio_issue',
      'clarification_request',
      'filler',
      'silence_or_empty',
      'unknown_non_substantive',
      'substantive_answer'
    ]) then
      return false;
    end if;
    if jsonb_typeof(v_value) <> 'number'
      or (v_value #>> '{}') !~ '^(0|[1-9][0-9]*)$'
      or (v_value #>> '{}')::numeric > 2147483647 then
      return false;
    end if;
    v_classification_total := v_classification_total + (v_value #>> '{}')::numeric;
    if v_key = 'substantive_answer' then
      v_classification_substantive := (v_value #>> '{}')::numeric;
    end if;
  end loop;

  if v_classification_total <> v_candidate_count
    or v_classification_substantive <> v_substantive_count
    or v_substantive_count > v_candidate_count
    or ((p_snapshot ->> 'has_substantive_response')::boolean
      is distinct from (v_substantive_count > 0)) then
    return false;
  end if;

  if (p_snapshot ->> 'conversation_progress_state') is distinct from
    (case when v_substantive_count > 0
      then 'CandidateResponded'
      else 'NoSubstantiveCandidateResponse'
    end) then
    return false;
  end if;

  return true;
exception
  when others then
    return false;
end
$$;

create or replace function private.interview_final_transcript_snapshot_strength(
  p_snapshot jsonb
)
returns bigint[]
language sql
immutable
strict
set search_path = ''
as $$
  select array[
    case when (p_snapshot ->> 'has_substantive_response')::boolean then 1 else 0 end,
    (p_snapshot ->> 'substantive_response_count')::bigint,
    (p_snapshot ->> 'candidate_utterance_count')::bigint,
    (p_snapshot ->> 'candidate_word_count')::bigint
  ]::bigint[]
$$;

create or replace function private.is_valid_interview_final_transcript_legacy_snapshot(
  p_snapshot jsonb
)
returns boolean
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_key text;
  v_value jsonb;
  v_candidate_count numeric;
  v_substantive_count numeric;
  v_classification_total numeric;
  v_classification_substantive numeric;
begin
  if p_snapshot is null
    or jsonb_typeof(p_snapshot) <> 'object'
    or octet_length(p_snapshot::text) > 4096 then
    return false;
  end if;

  for v_key in select jsonb_object_keys(p_snapshot)
  loop
    if v_key <> all (array[
      'has_substantive_response',
      'substantive_response_count',
      'candidate_utterance_count',
      'classification_counts',
      'conversation_progress_state'
    ]) then
      return false;
    end if;
  end loop;

  if not (
    p_snapshot ? 'has_substantive_response'
    and p_snapshot ? 'substantive_response_count'
    and p_snapshot ? 'candidate_utterance_count'
    and p_snapshot ? 'classification_counts'
    and p_snapshot ? 'conversation_progress_state'
  ) then
    return false;
  end if;

  if jsonb_typeof(p_snapshot -> 'has_substantive_response') <> 'boolean'
    or jsonb_typeof(p_snapshot -> 'substantive_response_count') <> 'number'
    or jsonb_typeof(p_snapshot -> 'candidate_utterance_count') <> 'number'
    or jsonb_typeof(p_snapshot -> 'classification_counts') <> 'object'
    or jsonb_typeof(p_snapshot -> 'conversation_progress_state') <> 'string' then
    return false;
  end if;

  if (p_snapshot ->> 'substantive_response_count') !~ '^(0|[1-9][0-9]*)$'
    or (p_snapshot ->> 'candidate_utterance_count') !~ '^(0|[1-9][0-9]*)$' then
    return false;
  end if;

  v_substantive_count := (p_snapshot ->> 'substantive_response_count')::numeric;
  v_candidate_count := (p_snapshot ->> 'candidate_utterance_count')::numeric;
  if v_substantive_count > 2147483647
    or v_candidate_count > 2147483647 then
    return false;
  end if;

  v_classification_total := 0;
  v_classification_substantive := 0;
  for v_key, v_value in
    select key, value from jsonb_each(p_snapshot -> 'classification_counts')
  loop
    if v_key <> all (array[
      'acknowledgment',
      'repeat_request',
      'hearing_or_audio_issue',
      'clarification_request',
      'filler',
      'silence_or_empty',
      'unknown_non_substantive',
      'substantive_answer'
    ]) then
      return false;
    end if;
    if jsonb_typeof(v_value) <> 'number'
      or (v_value #>> '{}') !~ '^(0|[1-9][0-9]*)$'
      or (v_value #>> '{}')::numeric > 2147483647 then
      return false;
    end if;
    v_classification_total := v_classification_total + (v_value #>> '{}')::numeric;
    if v_key = 'substantive_answer' then
      v_classification_substantive := (v_value #>> '{}')::numeric;
    end if;
  end loop;

  if v_classification_total <> v_candidate_count
    or v_classification_substantive <> v_substantive_count
    or v_substantive_count > v_candidate_count
    or ((p_snapshot ->> 'has_substantive_response')::boolean
      is distinct from (v_substantive_count > 0)) then
    return false;
  end if;

  if (p_snapshot ->> 'conversation_progress_state') is distinct from
    (case when v_substantive_count > 0
      then 'CandidateResponded'
      else 'NoSubstantiveCandidateResponse'
    end) then
    return false;
  end if;

  return true;
exception
  when others then
    return false;
end
$$;

create or replace function private.interview_final_transcript_known_prefix_strength(
  p_snapshot jsonb
)
returns bigint[]
language sql
immutable
strict
set search_path = ''
as $$
  select array[
    case when (p_snapshot ->> 'has_substantive_response')::boolean then 1 else 0 end,
    (p_snapshot ->> 'substantive_response_count')::bigint,
    (p_snapshot ->> 'candidate_utterance_count')::bigint
  ]::bigint[]
$$;

revoke all on function private.is_valid_interview_final_transcript_snapshot(jsonb)
  from public, anon, authenticated, service_role;
revoke all on function private.interview_final_transcript_snapshot_strength(jsonb)
  from public, anon, authenticated, service_role;
revoke all on function private.is_valid_interview_final_transcript_legacy_snapshot(jsonb)
  from public, anon, authenticated, service_role;
revoke all on function private.interview_final_transcript_known_prefix_strength(jsonb)
  from public, anon, authenticated, service_role;
revoke all on function private.is_valid_interview_unanswered_questions(jsonb)
  from public, anon, authenticated, service_role;
revoke all on function private.is_valid_interview_analysis_v2(jsonb)
  from public, anon, authenticated, service_role;
revoke all on function private.is_valid_interview_transcript_scores(jsonb)
  from public, anon, authenticated, service_role;

create table if not exists private.interview_final_transcript_reconciliation_claims (
  interview_id uuid primary key references public.interviews(id) on delete restrict,
  processing_state text not null default 'available'
    check (processing_state in ('available', 'claimed', 'completed')),
  claim_token uuid null,
  last_released_claim_token uuid null,
  claim_version bigint not null default 0 check (claim_version >= 0),
  lease_expires_at timestamptz null,
  claimed_at timestamptz null,
  completed_at timestamptz null,
  pending_transcript_hash text null
    check (pending_transcript_hash is null or pending_transcript_hash ~ '^[a-f0-9]{64}$'),
  pending_evidence_snapshot jsonb null
    check (
      pending_evidence_snapshot is null
      or private.is_valid_interview_final_transcript_snapshot(pending_evidence_snapshot)
    ),
  pending_provider_event_key text null
    check (pending_provider_event_key is null or pending_provider_event_key ~ '^[a-f0-9]{64}$'),
  scoring_required boolean null,
  authoritative_transcript_hash text null
    check (
      authoritative_transcript_hash is null
      or authoritative_transcript_hash ~ '^[a-f0-9]{64}$'
    ),
  authoritative_transcript_storage_ref text null
    check (
      authoritative_transcript_storage_ref is null
      or char_length(authoritative_transcript_storage_ref) between 1 and 1000
    ),
  authoritative_evidence_snapshot jsonb null
    check (
      authoritative_evidence_snapshot is null
      or private.is_valid_interview_final_transcript_snapshot(authoritative_evidence_snapshot)
    ),
  authoritative_provider_event_key text null
    check (
      authoritative_provider_event_key is null
      or authoritative_provider_event_key ~ '^[a-f0-9]{64}$'
    ),
  last_failure_category text null
    check (
      last_failure_category is null
      or last_failure_category in (
        'scoring_failed',
        'storage_failed',
        'finalize_failed',
        'worker_shutdown'
      )
    ),
  analysis_processing_state text not null default 'available'
    check (analysis_processing_state in ('available', 'claimed', 'completed')),
  analysis_claim_token uuid null,
  analysis_last_released_claim_token uuid null,
  analysis_last_completed_claim_token uuid null,
  analysis_claim_version bigint not null default 0
    check (analysis_claim_version >= 0),
  analysis_lease_expires_at timestamptz null,
  analysis_claimed_at timestamptz null,
  analysis_completed_at timestamptz null,
  analysis_expected_transcript_claim_version bigint null
    check (
      analysis_expected_transcript_claim_version is null
      or analysis_expected_transcript_claim_version >= 0
    ),
  analysis_expected_transcript_hash text null
    check (
      analysis_expected_transcript_hash is null
      or analysis_expected_transcript_hash ~ '^[a-f0-9]{64}$'
    ),
  analysis_completed_transcript_claim_version bigint null
    check (
      analysis_completed_transcript_claim_version is null
      or analysis_completed_transcript_claim_version >= 0
    ),
  analysis_completed_transcript_hash text null
    check (
      analysis_completed_transcript_hash is null
      or analysis_completed_transcript_hash ~ '^[a-f0-9]{64}$'
    ),
  analysis_last_failure_category text null
    check (
      analysis_last_failure_category is null
      or analysis_last_failure_category in (
        'analysis_generation_failed',
        'analysis_finalize_failed',
        'analysis_superseded',
        'worker_shutdown'
      )
    ),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (
    (processing_state = 'available'
      and claim_token is null
      and lease_expires_at is null
      and claimed_at is null
      and pending_transcript_hash is null
      and pending_evidence_snapshot is null
      and pending_provider_event_key is null
      and scoring_required is null)
    or
    (processing_state = 'claimed'
      and claim_token is not null
      and lease_expires_at is not null
      and claimed_at is not null
      and lease_expires_at > claimed_at
      and pending_transcript_hash is not null
      and pending_evidence_snapshot is not null
      and pending_provider_event_key is not null
      and scoring_required is true)
    or
    (processing_state = 'completed'
      and lease_expires_at is null
      and pending_transcript_hash is null
      and pending_evidence_snapshot is null
      and pending_provider_event_key is null
      and scoring_required is null
      and completed_at is not null
      and authoritative_transcript_hash is not null
      and authoritative_transcript_storage_ref is not null
      and authoritative_evidence_snapshot is not null
      and authoritative_provider_event_key is not null)
  ),
  check (
    (
      analysis_completed_transcript_claim_version is null
      and analysis_completed_transcript_hash is null
      and analysis_last_completed_claim_token is null
      and analysis_completed_at is null
    )
    or
    (
      analysis_completed_transcript_claim_version is not null
      and analysis_completed_transcript_hash is not null
      and analysis_last_completed_claim_token is not null
      and analysis_completed_at is not null
    )
  ),
  check (
    (analysis_processing_state = 'available'
      and analysis_claim_token is null
      and analysis_lease_expires_at is null
      and analysis_claimed_at is null
      and analysis_expected_transcript_claim_version is null
      and analysis_expected_transcript_hash is null
      and analysis_completed_transcript_claim_version is null)
    or
    (analysis_processing_state = 'claimed'
      and analysis_claim_token is not null
      and analysis_lease_expires_at is not null
      and analysis_claimed_at is not null
      and analysis_lease_expires_at > analysis_claimed_at
      and analysis_expected_transcript_claim_version is not null
      and analysis_expected_transcript_hash is not null)
    or
    (analysis_processing_state = 'completed'
      and analysis_claim_token is null
      and analysis_lease_expires_at is null
      and analysis_claimed_at is null
      and analysis_expected_transcript_claim_version is null
      and analysis_expected_transcript_hash is null
      and analysis_completed_transcript_claim_version is not null)
  )
);

-- Fail closed before defining the RPC boundary when a same-name private object is
-- not the exact ownership table this migration creates. The temporary template is
-- migration-only and lets PostgreSQL canonicalize column and check expressions.
do $ownership_contract$
declare
  v_actual_oid oid;
  v_expected_oid oid;
  v_actual_contract jsonb;
  v_expected_contract jsonb;
  v_primary_index_oid oid;
begin
  perform pg_catalog.set_config('search_path', '', true);

  select c.oid
  into v_actual_oid
  from pg_catalog.pg_class c
  join pg_catalog.pg_namespace n
    on n.oid = c.relnamespace
  where n.nspname = 'private'
    and c.relname = 'interview_final_transcript_reconciliation_claims';

  if v_actual_oid is null then
    raise exception using
      errcode = 'P0001',
      message = 'final_transcript_ownership_table_contract_mismatch',
      detail = 'category=missing_table';
  end if;

  if not exists (
    select 1
    from pg_catalog.pg_class c
    join pg_catalog.pg_am am
      on am.oid = c.relam
    where c.oid = v_actual_oid
      and c.relkind = 'r'
      and c.relpersistence = 'p'
      and c.relowner = (
        select r.oid
        from pg_catalog.pg_roles r
        where r.rolname = current_user
      )
      and am.amname = 'heap'
      and c.relispartition is false
      and c.reltablespace = 0
      and c.reloftype = 0
      and c.relreplident = 'd'
      and c.reloptions is null
  )
  or exists (
    select 1
    from pg_catalog.pg_inherits i
    where i.inhrelid = v_actual_oid
      or i.inhparent = v_actual_oid
  ) then
    raise exception using
      errcode = 'P0001',
      message = 'final_transcript_ownership_table_contract_mismatch',
      detail = 'category=incompatible_table';
  end if;

  create temporary table pg_temp.expected_final_transcript_ownership_contract (
    interview_id uuid
      constraint interview_final_transcript_reconciliation_claims_pkey
      primary key,
    processing_state text not null default 'available'
      constraint interview_final_transcript_reconciliatio_processing_state_check
      check (processing_state in ('available', 'claimed', 'completed')),
    claim_token uuid null,
    last_released_claim_token uuid null,
    claim_version bigint not null default 0
      constraint interview_final_transcript_reconciliation_c_claim_version_check
      check (claim_version >= 0),
    lease_expires_at timestamptz null,
    claimed_at timestamptz null,
    completed_at timestamptz null,
    pending_transcript_hash text null
      constraint interview_final_transcript_reconc_pending_transcript_hash_check
      check (
        pending_transcript_hash is null
        or pending_transcript_hash ~ '^[a-f0-9]{64}$'
      ),
    pending_evidence_snapshot jsonb null
      constraint interview_final_transcript_reco_pending_evidence_snapshot_check
      check (
        pending_evidence_snapshot is null
        or private.is_valid_interview_final_transcript_snapshot(
          pending_evidence_snapshot
        )
      ),
    pending_provider_event_key text null
      constraint interview_final_transcript_rec_pending_provider_event_key_check
      check (
        pending_provider_event_key is null
        or pending_provider_event_key ~ '^[a-f0-9]{64}$'
      ),
    scoring_required boolean null,
    authoritative_transcript_hash text null
      constraint interview_final_transcript_r_authoritative_transcript_has_check
      check (
        authoritative_transcript_hash is null
        or authoritative_transcript_hash ~ '^[a-f0-9]{64}$'
      ),
    authoritative_transcript_storage_ref text null
      constraint interview_final_transcript_r_authoritative_transcript_sto_check
      check (
        authoritative_transcript_storage_ref is null
        or char_length(authoritative_transcript_storage_ref) between 1 and 1000
      ),
    authoritative_evidence_snapshot jsonb null
      constraint interview_final_transcript_r_authoritative_evidence_snaps_check
      check (
        authoritative_evidence_snapshot is null
        or private.is_valid_interview_final_transcript_snapshot(
          authoritative_evidence_snapshot
        )
      ),
    authoritative_provider_event_key text null
      constraint interview_final_transcript_r_authoritative_provider_event_check
      check (
        authoritative_provider_event_key is null
        or authoritative_provider_event_key ~ '^[a-f0-9]{64}$'
      ),
    last_failure_category text null
      constraint interview_final_transcript_reconcil_last_failure_category_check
      check (
        last_failure_category is null
        or last_failure_category in (
          'scoring_failed',
          'storage_failed',
          'finalize_failed',
          'worker_shutdown'
        )
      ),
    analysis_processing_state text not null default 'available'
      constraint interview_final_transcript_reco_analysis_processing_state_check
      check (analysis_processing_state in ('available', 'claimed', 'completed')),
    analysis_claim_token uuid null,
    analysis_last_released_claim_token uuid null,
    analysis_last_completed_claim_token uuid null,
    analysis_claim_version bigint not null default 0
      constraint interview_final_transcript_reconci_analysis_claim_version_check
      check (analysis_claim_version >= 0),
    analysis_lease_expires_at timestamptz null,
    analysis_claimed_at timestamptz null,
    analysis_completed_at timestamptz null,
    analysis_expected_transcript_claim_version bigint null
      constraint interview_final_transcript_r_analysis_expected_transcript_check
      check (
        analysis_expected_transcript_claim_version is null
        or analysis_expected_transcript_claim_version >= 0
      ),
    analysis_expected_transcript_hash text null
      constraint interview_final_transcript_r_analysis_expected_transcrip_check1
      check (
        analysis_expected_transcript_hash is null
        or analysis_expected_transcript_hash ~ '^[a-f0-9]{64}$'
      ),
    analysis_completed_transcript_claim_version bigint null
      constraint interview_final_transcript_r_analysis_completed_transcrip_check
      check (
        analysis_completed_transcript_claim_version is null
        or analysis_completed_transcript_claim_version >= 0
      ),
    analysis_completed_transcript_hash text null
      constraint interview_final_transcript_r_analysis_completed_transcri_check1
      check (
        analysis_completed_transcript_hash is null
        or analysis_completed_transcript_hash ~ '^[a-f0-9]{64}$'
      ),
    analysis_last_failure_category text null
      constraint interview_final_transcript_r_analysis_last_failure_catego_check
      check (
        analysis_last_failure_category is null
        or analysis_last_failure_category in (
          'analysis_generation_failed',
          'analysis_finalize_failed',
          'analysis_superseded',
          'worker_shutdown'
        )
      ),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    constraint interview_final_transcript_reconciliation_claims_check
      check (
        (processing_state = 'available'
          and claim_token is null
          and lease_expires_at is null
          and claimed_at is null
          and pending_transcript_hash is null
          and pending_evidence_snapshot is null
          and pending_provider_event_key is null
          and scoring_required is null)
        or
        (processing_state = 'claimed'
          and claim_token is not null
          and lease_expires_at is not null
          and claimed_at is not null
          and lease_expires_at > claimed_at
          and pending_transcript_hash is not null
          and pending_evidence_snapshot is not null
          and pending_provider_event_key is not null
          and scoring_required is true)
        or
        (processing_state = 'completed'
          and lease_expires_at is null
          and pending_transcript_hash is null
          and pending_evidence_snapshot is null
          and pending_provider_event_key is null
          and scoring_required is null
          and completed_at is not null
          and authoritative_transcript_hash is not null
          and authoritative_transcript_storage_ref is not null
          and authoritative_evidence_snapshot is not null
          and authoritative_provider_event_key is not null)
      ),
    constraint interview_final_transcript_reconciliation_claims_check1
      check (
        (
          analysis_completed_transcript_claim_version is null
          and analysis_completed_transcript_hash is null
          and analysis_last_completed_claim_token is null
          and analysis_completed_at is null
        )
        or
        (
          analysis_completed_transcript_claim_version is not null
          and analysis_completed_transcript_hash is not null
          and analysis_last_completed_claim_token is not null
          and analysis_completed_at is not null
        )
      ),
    constraint interview_final_transcript_reconciliation_claims_check2
      check (
        (analysis_processing_state = 'available'
          and analysis_claim_token is null
          and analysis_lease_expires_at is null
          and analysis_claimed_at is null
          and analysis_expected_transcript_claim_version is null
          and analysis_expected_transcript_hash is null
          and analysis_completed_transcript_claim_version is null)
        or
        (analysis_processing_state = 'claimed'
          and analysis_claim_token is not null
          and analysis_lease_expires_at is not null
          and analysis_claimed_at is not null
          and analysis_lease_expires_at > analysis_claimed_at
          and analysis_expected_transcript_claim_version is not null
          and analysis_expected_transcript_hash is not null)
        or
        (analysis_processing_state = 'completed'
          and analysis_claim_token is null
          and analysis_lease_expires_at is null
          and analysis_claimed_at is null
          and analysis_expected_transcript_claim_version is null
          and analysis_expected_transcript_hash is null
          and analysis_completed_transcript_claim_version is not null)
      )
  ) on commit drop;

  select c.oid
  into v_expected_oid
  from pg_catalog.pg_class c
  join pg_catalog.pg_namespace n
    on n.oid = c.relnamespace
  where n.oid = pg_catalog.pg_my_temp_schema()
    and c.relname = 'expected_final_transcript_ownership_contract';

  select coalesce(
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'position', a.attnum,
        'name', a.attname,
        'type', a.atttypid,
        'typmod', a.atttypmod,
        'dimensions', a.attndims,
        'not_null', a.attnotnull,
        'default', pg_catalog.pg_get_expr(d.adbin, d.adrelid),
        'generated', a.attgenerated,
        'identity', a.attidentity,
        'collation', a.attcollation,
        'storage', a.attstorage,
        'compression', a.attcompression,
        'options', a.attoptions,
        'local', a.attislocal,
        'inheritance_count', a.attinhcount
      )
      order by a.attnum
    ),
    '[]'::jsonb
  )
  into v_actual_contract
  from pg_catalog.pg_attribute a
  left join pg_catalog.pg_attrdef d
    on d.adrelid = a.attrelid
    and d.adnum = a.attnum
  where a.attrelid = v_actual_oid
    and a.attnum > 0
    and a.attisdropped is false;

  select coalesce(
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'position', a.attnum,
        'name', a.attname,
        'type', a.atttypid,
        'typmod', a.atttypmod,
        'dimensions', a.attndims,
        'not_null', a.attnotnull,
        'default', pg_catalog.pg_get_expr(d.adbin, d.adrelid),
        'generated', a.attgenerated,
        'identity', a.attidentity,
        'collation', a.attcollation,
        'storage', a.attstorage,
        'compression', a.attcompression,
        'options', a.attoptions,
        'local', a.attislocal,
        'inheritance_count', a.attinhcount
      )
      order by a.attnum
    ),
    '[]'::jsonb
  )
  into v_expected_contract
  from pg_catalog.pg_attribute a
  left join pg_catalog.pg_attrdef d
    on d.adrelid = a.attrelid
    and d.adnum = a.attnum
  where a.attrelid = v_expected_oid
    and a.attnum > 0
    and a.attisdropped is false;

  if v_actual_contract is distinct from v_expected_contract then
    raise exception using
      errcode = 'P0001',
      message = 'final_transcript_ownership_table_contract_mismatch',
      detail = 'category=column_contract';
  end if;

  select coalesce(
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'name', con.conname,
        'type', con.contype,
        'definition', pg_catalog.regexp_replace(
          pg_catalog.pg_get_constraintdef(con.oid, false),
          '[[:space:]]+',
          ' ',
          'g'
        ),
        'validated', con.convalidated,
        'deferrable', con.condeferrable,
        'deferred', con.condeferred,
        'local', con.conislocal,
        'inheritance_count', con.coninhcount,
        'no_inherit', con.connoinherit,
        'parent', con.conparentid
      )
      order by con.conname
    ),
    '[]'::jsonb
  )
  into v_actual_contract
  from pg_catalog.pg_constraint con
  where con.conrelid = v_actual_oid
    and con.contype <> 'f';

  select coalesce(
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'name', con.conname,
        'type', con.contype,
        'definition', pg_catalog.regexp_replace(
          pg_catalog.pg_get_constraintdef(con.oid, false),
          '[[:space:]]+',
          ' ',
          'g'
        ),
        'validated', con.convalidated,
        'deferrable', con.condeferrable,
        'deferred', con.condeferred,
        'local', con.conislocal,
        'inheritance_count', con.coninhcount,
        'no_inherit', con.connoinherit,
        'parent', con.conparentid
      )
      order by con.conname
    ),
    '[]'::jsonb
  )
  into v_expected_contract
  from pg_catalog.pg_constraint con
  where con.conrelid = v_expected_oid;

  if v_actual_contract is distinct from v_expected_contract then
    raise exception using
      errcode = 'P0001',
      message = 'final_transcript_ownership_table_contract_mismatch',
      detail = 'category=constraint_contract';
  end if;

  if not exists (
    select 1
    from pg_catalog.pg_constraint con
    join pg_catalog.pg_attribute referenced_column
      on referenced_column.attrelid = con.confrelid
      and referenced_column.attname = 'id'
      and referenced_column.attnum > 0
      and referenced_column.attisdropped is false
    where con.conrelid = v_actual_oid
      and con.conname =
        'interview_final_transcript_reconciliation_cla_interview_id_fkey'
      and con.contype = 'f'
      and con.convalidated
      and con.condeferrable is false
      and con.condeferred is false
      and con.conislocal
      and con.coninhcount = 0
      and con.connoinherit
      and con.conparentid = 0
      and con.confrelid = 'public.interviews'::pg_catalog.regclass
      and con.conkey = array[1]::smallint[]
      and con.confkey = array[referenced_column.attnum]::smallint[]
      and con.confupdtype = 'a'
      and con.confdeltype = 'r'
      and con.confmatchtype = 's'
      and pg_catalog.pg_get_constraintdef(con.oid, false) =
        'FOREIGN KEY (interview_id) REFERENCES public.interviews(id) ON DELETE RESTRICT'
  )
  or (
    select pg_catalog.count(*)
    from pg_catalog.pg_constraint con
    where con.conrelid = v_actual_oid
      and con.contype = 'f'
  ) <> 1 then
    raise exception using
      errcode = 'P0001',
      message = 'final_transcript_ownership_table_contract_mismatch',
      detail = 'category=foreign_key_contract';
  end if;

  select con.conindid
  into v_primary_index_oid
  from pg_catalog.pg_constraint con
  where con.conrelid = v_actual_oid
    and con.conname = 'interview_final_transcript_reconciliation_claims_pkey'
    and con.contype = 'p';

  if v_primary_index_oid is null
  or not exists (
    select 1
    from pg_catalog.pg_index i
    join pg_catalog.pg_class index_class
      on index_class.oid = i.indexrelid
    join pg_catalog.pg_namespace index_namespace
      on index_namespace.oid = index_class.relnamespace
    join pg_catalog.pg_am am
      on am.oid = index_class.relam
    where i.indexrelid = v_primary_index_oid
      and i.indrelid = v_actual_oid
      and index_namespace.nspname = 'private'
      and index_class.relname =
        'interview_final_transcript_reconciliation_claims_pkey'
      and index_class.relkind = 'i'
      and index_class.relpersistence = 'p'
      and index_class.relowner = (
        select r.oid
        from pg_catalog.pg_roles r
        where r.rolname = current_user
      )
      and index_class.reloptions is null
      and am.amname = 'btree'
      and i.indnatts = 1
      and i.indnkeyatts = 1
      and i.indisunique
      and i.indisprimary
      and i.indisexclusion is false
      and i.indimmediate
      and i.indisclustered is false
      and i.indisvalid
      and i.indcheckxmin is false
      and i.indisready
      and i.indislive
      and i.indisreplident is false
      and i.indkey::text = '1'
      and i.indcollation::text = '0'
      and i.indoption::text = '0'
      and i.indexprs is null
      and i.indpred is null
  )
  or exists (
    select 1
    from pg_catalog.pg_index i
    join pg_catalog.pg_class extra_index
      on extra_index.oid = i.indexrelid
    join pg_catalog.pg_am extra_index_method
      on extra_index_method.oid = extra_index.relam
    where i.indrelid = v_actual_oid
      and i.indexrelid <> v_primary_index_oid
      and (
        i.indisunique
        or i.indisexclusion
        or i.indisprimary
        or i.indisvalid is false
        or i.indisready is false
        or i.indislive is false
        or i.indexprs is not null
        or i.indpred is not null
        or extra_index.relkind <> 'i'
        or extra_index.relpersistence <> 'p'
        or extra_index.relowner <> (
          select r.oid
          from pg_catalog.pg_roles r
          where r.rolname = current_user
        )
        or extra_index.reloptions is not null
        or extra_index_method.amname <> 'btree'
      )
  ) then
    raise exception using
      errcode = 'P0001',
      message = 'final_transcript_ownership_table_contract_mismatch',
      detail = 'category=index_contract';
  end if;

  if exists (
    select 1
    from pg_catalog.pg_policy p
    where p.polrelid = v_actual_oid
  ) then
    raise exception using
      errcode = 'P0001',
      message = 'final_transcript_ownership_table_contract_mismatch',
      detail = 'category=policy_contract';
  end if;

  if exists (
    select 1
    from pg_catalog.pg_attribute a
    where a.attrelid = v_actual_oid
      and a.attnum > 0
      and a.attisdropped is false
      and a.attacl is not null
  ) then
    raise exception using
      errcode = 'P0001',
      message = 'final_transcript_ownership_table_contract_mismatch',
      detail = 'category=column_privilege_contract';
  end if;

  if exists (
    select 1
    from pg_catalog.pg_trigger t
    where t.tgrelid = v_actual_oid
      and t.tgisinternal is false
  ) then
    raise exception using
      errcode = 'P0001',
      message = 'final_transcript_ownership_table_contract_mismatch',
      detail = 'category=trigger_contract';
  end if;

  drop table pg_temp.expected_final_transcript_ownership_contract;
end
$ownership_contract$;

alter table private.interview_final_transcript_reconciliation_claims enable row level security;
alter table private.interview_final_transcript_reconciliation_claims force row level security;
revoke all on table private.interview_final_transcript_reconciliation_claims
  from public, anon, authenticated, service_role;

do $ownership_security_contract$
declare
  v_table_oid oid;
begin
  perform pg_catalog.set_config('search_path', '', true);

  select c.oid
  into v_table_oid
  from pg_catalog.pg_class c
  join pg_catalog.pg_namespace n
    on n.oid = c.relnamespace
  where n.nspname = 'private'
    and c.relname = 'interview_final_transcript_reconciliation_claims'
    and c.relkind = 'r';

  if not exists (
    select 1
    from pg_catalog.pg_class c
    where c.oid = v_table_oid
      and c.relrowsecurity
      and c.relforcerowsecurity
  )
  or exists (
    select 1
    from pg_catalog.pg_policy p
    where p.polrelid = v_table_oid
  )
  or exists (
    select 1
    from pg_catalog.aclexplode(
      coalesce(
        (
          select c.relacl
          from pg_catalog.pg_class c
          where c.oid = v_table_oid
        ),
        pg_catalog.acldefault(
          'r',
          (
            select c.relowner
            from pg_catalog.pg_class c
            where c.oid = v_table_oid
          )
        )
      )
    ) acl
    where acl.grantee = 0
      or acl.grantee in (
        select r.oid
        from pg_catalog.pg_roles r
        where r.rolname in ('anon', 'authenticated', 'service_role')
      )
  )
  or exists (
    select 1
    from pg_catalog.pg_attribute a
    cross join lateral pg_catalog.aclexplode(a.attacl) acl
    where a.attrelid = v_table_oid
      and a.attnum > 0
      and a.attisdropped is false
      and a.attacl is not null
      and (
        acl.grantee = 0
        or acl.grantee in (
          select r.oid
          from pg_catalog.pg_roles r
          where r.rolname in ('anon', 'authenticated', 'service_role')
        )
      )
  ) then
    raise exception using
      errcode = 'P0001',
      message = 'final_transcript_ownership_table_contract_mismatch',
      detail = 'category=security_contract';
  end if;
end
$ownership_security_contract$;

create or replace function public.claim_interview_final_transcript_reconciliation(
  p_interview_id uuid,
  p_provider_conversation_id text,
  p_provider_event_key text,
  p_transcript_hash text,
  p_evidence_snapshot jsonb,
  p_lease_seconds integer default 60
)
returns table (
  outcome text,
  claim_token uuid,
  claim_version bigint,
  lease_expires_at timestamptz,
  scoring_required boolean
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_claim private.interview_final_transcript_reconciliation_claims%rowtype;
  v_interview public.interviews%rowtype;
  v_current_legacy_snapshot jsonb;
  v_has_current_evidence boolean;
  v_recovered boolean := false;
  v_scoring_required boolean;
  v_token uuid;
begin
  if p_interview_id is null
    or p_provider_conversation_id is null
    or char_length(p_provider_conversation_id) not between 1 and 200
    or p_provider_event_key is null
    or p_provider_event_key !~ '^[a-f0-9]{64}$'
    or p_transcript_hash is null
    or p_transcript_hash !~ '^[a-f0-9]{64}$'
    or p_lease_seconds is null
    or p_lease_seconds not between 1 and 300
    or not private.is_valid_interview_final_transcript_snapshot(p_evidence_snapshot) then
    return query select
      'invalid_snapshot'::text, null::uuid, null::bigint, null::timestamptz, null::boolean;
    return;
  end if;

  insert into private.interview_final_transcript_reconciliation_claims (interview_id)
  select i.id from public.interviews i where i.id = p_interview_id
  on conflict (interview_id) do nothing;

  select c.* into v_claim
  from private.interview_final_transcript_reconciliation_claims c
  where c.interview_id = p_interview_id
  for update;
  if not found then
    return query select
      'binding_not_found'::text, null::uuid, null::bigint, null::timestamptz, null::boolean;
    return;
  end if;

  select i.* into v_interview
  from public.interviews i
  where i.id = p_interview_id
  for update;
  if not found
    or not (
      p_provider_conversation_id is not distinct from nullif(v_interview.tavus_application_id, '')
      or p_provider_conversation_id is not distinct from nullif(v_interview.tavus_conversation_id, '')
      or p_provider_conversation_id is not distinct from nullif(v_interview.conversation_id, '')
    ) then
    return query select
      'binding_not_found'::text, null::uuid, v_claim.claim_version, null::timestamptz, null::boolean;
    return;
  end if;

  if v_claim.processing_state = 'claimed' and v_claim.lease_expires_at > now() then
    return query select
      'busy'::text, null::uuid, v_claim.claim_version, v_claim.lease_expires_at, null::boolean;
    return;
  end if;

  if v_claim.processing_state = 'claimed' then
    v_recovered := true;
    update private.interview_final_transcript_reconciliation_claims c
    set processing_state = case
          when c.authoritative_transcript_hash is null then 'available'
          else 'completed'
        end,
        claim_token = null,
        lease_expires_at = null,
        claimed_at = null,
        pending_transcript_hash = null,
        pending_evidence_snapshot = null,
        pending_provider_event_key = null,
        scoring_required = null,
        updated_at = now()
    where c.interview_id = p_interview_id;
    select c.* into v_claim
    from private.interview_final_transcript_reconciliation_claims c
    where c.interview_id = p_interview_id;
  end if;

  if v_claim.authoritative_transcript_hash = p_transcript_hash then
    if v_claim.authoritative_evidence_snapshot is distinct from p_evidence_snapshot then
      return query select
        'invalid_snapshot'::text, null::uuid, v_claim.claim_version, null::timestamptz, null::boolean;
    else
      return query select
        'already_reconciled'::text, null::uuid, v_claim.claim_version, null::timestamptz, false;
    end if;
    return;
  end if;

  if v_claim.authoritative_evidence_snapshot is not null
    and private.interview_final_transcript_snapshot_strength(v_claim.authoritative_evidence_snapshot)
      >= private.interview_final_transcript_snapshot_strength(p_evidence_snapshot) then
    return query select
      'superseded_by_stronger_evidence'::text, null::uuid, v_claim.claim_version, null::timestamptz, false;
    return;
  end if;

  v_current_legacy_snapshot := jsonb_build_object(
    'has_substantive_response', coalesce(v_interview.has_substantive_response, false),
    'substantive_response_count', coalesce(v_interview.substantive_response_count, 0),
    'candidate_utterance_count', coalesce(v_interview.candidate_utterance_count, 0),
    'classification_counts', coalesce(v_interview.utterance_classification_counts, '{}'::jsonb),
    'conversation_progress_state',
      case when coalesce(v_interview.substantive_response_count, 0) > 0
        then 'CandidateResponded'
        else 'NoSubstantiveCandidateResponse'
      end
  );
  v_has_current_evidence :=
    v_interview.has_substantive_response is true
    or coalesce(v_interview.substantive_response_count, 0) > 0
    or coalesce(v_interview.candidate_utterance_count, 0) > 0
    or coalesce(v_interview.utterance_classification_counts, '{}'::jsonb) <> '{}'::jsonb;

  if v_has_current_evidence then
    if not private.is_valid_interview_final_transcript_legacy_snapshot(v_current_legacy_snapshot)
      or private.interview_final_transcript_known_prefix_strength(v_current_legacy_snapshot)
        >= private.interview_final_transcript_known_prefix_strength(p_evidence_snapshot) then
      return query select
        'superseded_by_stronger_evidence'::text, null::uuid, v_claim.claim_version, null::timestamptz, false;
      return;
    end if;
  end if;

  -- Every claimed transcript is either the first versioned authority or has a
  -- different hash from the completed authority. Historical score artifacts
  -- have no source tuple, so only an already-reconciled same-hash callback may
  -- skip scoring.
  v_scoring_required := true;
  v_token := gen_random_uuid();

  update private.interview_final_transcript_reconciliation_claims c
  set processing_state = 'claimed',
      claim_token = v_token,
      last_released_claim_token = null,
      claim_version = c.claim_version + 1,
      lease_expires_at = now() + make_interval(secs => p_lease_seconds),
      claimed_at = now(),
      pending_transcript_hash = p_transcript_hash,
      pending_evidence_snapshot = p_evidence_snapshot,
      pending_provider_event_key = p_provider_event_key,
      scoring_required = v_scoring_required,
      last_failure_category = null,
      updated_at = now()
  where c.interview_id = p_interview_id
  returning c.* into v_claim;

  return query select
    case when v_recovered then 'recovered_expired_claim' else 'claimed' end,
    v_claim.claim_token,
    v_claim.claim_version,
    v_claim.lease_expires_at,
    v_claim.scoring_required;
end
$$;

create or replace function public.finalize_interview_final_transcript_reconciliation(
  p_interview_id uuid,
  p_provider_conversation_id text,
  p_claim_token uuid,
  p_claim_version bigint,
  p_provider_event_key text,
  p_transcript_hash text,
  p_transcript_storage_ref text,
  p_normalized_transcript text,
  p_evidence_snapshot jsonb,
  p_transcript_scores jsonb,
  p_interview_summary text
)
returns table (
  outcome text,
  authoritative_snapshot_source text,
  canonical_repair_applied boolean,
  status_before text,
  status_after text,
  progress_before text,
  progress_after text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_claim private.interview_final_transcript_reconciliation_claims%rowtype;
  v_interview public.interviews%rowtype;
  v_current_legacy_snapshot jsonb;
  v_has_current_evidence boolean;
  v_status_after text;
  v_progress_after text;
  v_canonical_repair boolean;
  v_is_completed boolean;
  v_preserve_failure boolean;
begin
  select c.* into v_claim
  from private.interview_final_transcript_reconciliation_claims c
  where c.interview_id = p_interview_id
  for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'final_transcript_claim_mismatch';
  end if;

  if v_claim.processing_state = 'completed'
    and v_claim.claim_token is not distinct from p_claim_token
    and v_claim.claim_version = p_claim_version
    and v_claim.authoritative_transcript_hash = p_transcript_hash then
    return query select
      'already_reconciled'::text,
      'existing_authoritative'::text,
      false,
      null::text,
      null::text,
      null::text,
      null::text;
    return;
  end if;

  if v_claim.processing_state <> 'claimed'
    or v_claim.claim_token is distinct from p_claim_token
    or v_claim.claim_version <> p_claim_version
    or v_claim.lease_expires_at is null
    or v_claim.lease_expires_at <= now()
    or v_claim.pending_provider_event_key is distinct from p_provider_event_key
    or v_claim.pending_transcript_hash is distinct from p_transcript_hash
    or v_claim.pending_evidence_snapshot is distinct from p_evidence_snapshot then
    raise exception using errcode = 'P0001', message = 'final_transcript_claim_mismatch';
  end if;

  select i.* into v_interview
  from public.interviews i
  where i.id = p_interview_id
  for update;
  if not found
    or not (
      p_provider_conversation_id is not distinct from nullif(v_interview.tavus_application_id, '')
      or p_provider_conversation_id is not distinct from nullif(v_interview.tavus_conversation_id, '')
      or p_provider_conversation_id is not distinct from nullif(v_interview.conversation_id, '')
    ) then
    raise exception using errcode = 'P0001', message = 'final_transcript_binding_mismatch';
  end if;

  if p_provider_event_key !~ '^[a-f0-9]{64}$'
    or p_transcript_hash !~ '^[a-f0-9]{64}$'
    or not private.is_valid_interview_final_transcript_snapshot(p_evidence_snapshot)
    or p_transcript_storage_ref is null
    or char_length(p_transcript_storage_ref) not between 1 and 1000
    or p_transcript_storage_ref !~ (
      '^[A-Za-z0-9._-]{1,100}/interviews/' || p_interview_id::text ||
      '/final-transcripts/' || p_transcript_hash || E'\\.txt$'
    )
    or p_normalized_transcript is null
    or octet_length(p_normalized_transcript) > 65536
    or encode(public.digest(convert_to(p_normalized_transcript, 'UTF8'), 'sha256'), 'hex')
      is distinct from p_transcript_hash then
    raise exception using errcode = 'P0001', message = 'final_transcript_finalize_input_invalid';
  end if;

  if v_claim.scoring_required is distinct from true
    or not private.is_valid_interview_transcript_scores(p_transcript_scores) then
    raise exception using errcode = 'P0001', message = 'invalid_transcript_scores';
  end if;

  if p_interview_summary is null
    or char_length(btrim(p_interview_summary)) not between 1 and 4000 then
    raise exception using errcode = 'P0001', message = 'final_transcript_scoring_input_invalid';
  end if;

  v_current_legacy_snapshot := jsonb_build_object(
    'has_substantive_response', coalesce(v_interview.has_substantive_response, false),
    'substantive_response_count', coalesce(v_interview.substantive_response_count, 0),
    'candidate_utterance_count', coalesce(v_interview.candidate_utterance_count, 0),
    'classification_counts', coalesce(v_interview.utterance_classification_counts, '{}'::jsonb),
    'conversation_progress_state',
      case when coalesce(v_interview.substantive_response_count, 0) > 0
        then 'CandidateResponded'
        else 'NoSubstantiveCandidateResponse'
      end
  );
  v_has_current_evidence :=
    v_interview.has_substantive_response is true
    or coalesce(v_interview.substantive_response_count, 0) > 0
    or coalesce(v_interview.candidate_utterance_count, 0) > 0
    or coalesce(v_interview.utterance_classification_counts, '{}'::jsonb) <> '{}'::jsonb;

  if v_has_current_evidence and (
    not private.is_valid_interview_final_transcript_legacy_snapshot(v_current_legacy_snapshot)
    or private.interview_final_transcript_known_prefix_strength(v_current_legacy_snapshot)
      >= private.interview_final_transcript_known_prefix_strength(p_evidence_snapshot)
  ) then
    update private.interview_final_transcript_reconciliation_claims c
    set processing_state = case
          when c.authoritative_transcript_hash is null then 'available'
          else 'completed'
        end,
        claim_token = null,
        lease_expires_at = null,
        claimed_at = null,
        pending_transcript_hash = null,
        pending_evidence_snapshot = null,
        pending_provider_event_key = null,
        scoring_required = null,
        updated_at = now()
    where c.interview_id = p_interview_id;
    return query select
      'superseded_by_stronger_evidence'::text,
      'current'::text,
      false,
      v_interview.status,
      v_interview.status,
      v_interview.conversation_progress_state,
      v_interview.conversation_progress_state;
    return;
  end if;

  v_is_completed := lower(btrim(coalesce(v_interview.status, ''))) in
    ('completed', 'complete', 'analyzed');
  v_preserve_failure := upper(btrim(coalesce(v_interview.failure_code, ''))) in
    ('INTERVIEW_PROGRESS_STALLED', 'INTERVIEW_DISCONNECTED');
  v_status_after := case
    when v_is_completed or v_preserve_failure then v_interview.status
    when (p_evidence_snapshot ->> 'has_substantive_response')::boolean
      then 'ReadyForAnalysis'
    else 'Incomplete'
  end;
  v_progress_after := p_evidence_snapshot ->> 'conversation_progress_state';
  v_canonical_repair :=
    v_interview.has_substantive_response is distinct from
      (p_evidence_snapshot ->> 'has_substantive_response')::boolean
    or v_interview.substantive_response_count is distinct from
      (p_evidence_snapshot ->> 'substantive_response_count')::integer
    or v_interview.candidate_utterance_count is distinct from
      (p_evidence_snapshot ->> 'candidate_utterance_count')::integer
    or v_interview.utterance_classification_counts is distinct from
      (p_evidence_snapshot -> 'classification_counts')
    or v_interview.conversation_progress_state is distinct from v_progress_after;

  update public.interviews i
  set transcript = p_normalized_transcript,
      transcript_url = p_transcript_storage_ref,
      transcript_scores = p_transcript_scores,
      interview_summary = btrim(p_interview_summary),
      has_substantive_response =
        (p_evidence_snapshot ->> 'has_substantive_response')::boolean,
      substantive_response_count =
        (p_evidence_snapshot ->> 'substantive_response_count')::integer,
      candidate_utterance_count =
        (p_evidence_snapshot ->> 'candidate_utterance_count')::integer,
      utterance_classification_counts =
        p_evidence_snapshot -> 'classification_counts',
      conversation_progress_state = v_progress_after,
      status = v_status_after,
      updated_at = now()
  where i.id = p_interview_id;

  update private.interview_final_transcript_reconciliation_claims c
  set processing_state = 'completed',
      lease_expires_at = null,
      claimed_at = null,
      pending_transcript_hash = null,
      pending_evidence_snapshot = null,
      pending_provider_event_key = null,
      scoring_required = null,
      completed_at = now(),
      authoritative_transcript_hash = p_transcript_hash,
      authoritative_transcript_storage_ref = p_transcript_storage_ref,
      authoritative_evidence_snapshot = p_evidence_snapshot,
      authoritative_provider_event_key = p_provider_event_key,
      last_failure_category = null,
      updated_at = now()
  where c.interview_id = p_interview_id;

  return query select
    'finalized'::text,
    'incoming'::text,
    v_canonical_repair,
    v_interview.status,
    v_status_after,
    v_interview.conversation_progress_state,
    v_progress_after;
end
$$;

create or replace function public.persist_interview_unanswered_questions_if_authoritative(
  p_interview_id uuid,
  p_expected_claim_version bigint,
  p_expected_transcript_hash text,
  p_questions jsonb
)
returns table (
  outcome text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_claim private.interview_final_transcript_reconciliation_claims%rowtype;
  v_interview public.interviews%rowtype;
  v_questions text[];
begin
  if p_interview_id is null
    or p_expected_claim_version is null
    or p_expected_claim_version < 0
    or p_expected_transcript_hash is null
    or p_expected_transcript_hash !~ '^[a-f0-9]{64}$' then
    raise exception using
      errcode = 'P0001',
      message = 'final_transcript_question_persistence_input_invalid';
  end if;

  if not private.is_valid_interview_unanswered_questions(p_questions) then
    return query select 'invalid_questions'::text;
    return;
  end if;

  select pg_catalog.array_agg(
    question.value #>> '{}'
    order by question.ordinality
  )
  into v_questions
  from pg_catalog.jsonb_array_elements(p_questions)
    with ordinality as question(value, ordinality);

  select c.* into v_claim
  from private.interview_final_transcript_reconciliation_claims c
  where c.interview_id = p_interview_id
  for update;
  if not found then
    if exists (
      select 1
      from public.interviews i
      where i.id = p_interview_id
    ) then
      return query select 'superseded'::text;
    else
      return query select 'interview_not_found'::text;
    end if;
    return;
  end if;

  if v_claim.processing_state <> 'completed'
    or v_claim.claim_version <> p_expected_claim_version
    or v_claim.authoritative_transcript_hash is distinct from p_expected_transcript_hash then
    return query select 'superseded'::text;
    return;
  end if;

  select i.* into v_interview
  from public.interviews i
  where i.id = p_interview_id
  for update;
  if not found then
    return query select 'interview_not_found'::text;
    return;
  end if;

  if pg_catalog.cardinality(v_interview.unanswered_candidate_questions) > 0 then
    return query select 'already_present'::text;
    return;
  end if;

  update public.interviews i
  set unanswered_candidate_questions = v_questions
  where i.id = p_interview_id;

  return query select 'stored'::text;
end
$$;

create or replace function public.claim_interview_analysis_v2_if_authoritative(
  p_interview_id uuid,
  p_expected_transcript_claim_version bigint,
  p_expected_transcript_hash text,
  p_lease_seconds integer default 300
)
returns table (
  outcome text,
  analysis_claim_token uuid,
  analysis_claim_version bigint,
  lease_expires_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_claim private.interview_final_transcript_reconciliation_claims%rowtype;
  v_interview public.interviews%rowtype;
  v_token uuid;
  v_recovered boolean := false;
begin
  if p_interview_id is null
    or p_expected_transcript_claim_version is null
    or p_expected_transcript_claim_version < 0
    or p_expected_transcript_hash is null
    or p_expected_transcript_hash !~ '^[a-f0-9]{64}$'
    or p_lease_seconds is null
    or p_lease_seconds not between 1 and 900 then
    return query select
      'invalid_request'::text, null::uuid, null::bigint, null::timestamptz;
    return;
  end if;

  select c.* into v_claim
  from private.interview_final_transcript_reconciliation_claims c
  where c.interview_id = p_interview_id
  for update;
  if not found then
    if exists (select 1 from public.interviews i where i.id = p_interview_id) then
      return query select
        'superseded'::text, null::uuid, null::bigint, null::timestamptz;
    else
      return query select
        'interview_not_found'::text, null::uuid, null::bigint, null::timestamptz;
    end if;
    return;
  end if;

  select i.* into v_interview
  from public.interviews i
  where i.id = p_interview_id
  for update;
  if not found then
    return query select
      'interview_not_found'::text, null::uuid, v_claim.analysis_claim_version, null::timestamptz;
    return;
  end if;

  if v_claim.processing_state <> 'completed'
    or v_claim.claim_version <> p_expected_transcript_claim_version
    or v_claim.authoritative_transcript_hash is distinct from p_expected_transcript_hash then
    return query select
      'superseded'::text, null::uuid, v_claim.analysis_claim_version, null::timestamptz;
    return;
  end if;

  if coalesce((v_claim.authoritative_evidence_snapshot ->> 'has_substantive_response')::boolean, false) is not true
    or nullif(btrim(coalesce(v_interview.transcript, '')), '') is null
    or jsonb_typeof(v_interview.transcript_scores) <> 'object'
    or v_interview.transcript_scores = '{}'::jsonb
    or nullif(btrim(coalesce(v_interview.interview_summary, '')), '') is null then
    return query select
      'invalid_request'::text, null::uuid, v_claim.analysis_claim_version, null::timestamptz;
    return;
  end if;

  if v_claim.analysis_processing_state = 'completed'
    and v_claim.analysis_completed_transcript_claim_version = p_expected_transcript_claim_version
    and v_claim.analysis_completed_transcript_hash = p_expected_transcript_hash
    and private.is_valid_interview_analysis_v2(v_interview.interview_analysis_v2) then
    return query select
      'already_current'::text, null::uuid, v_claim.analysis_claim_version, null::timestamptz;
    return;
  end if;

  if v_interview.interview_analysis_v2 is not null
    and v_claim.analysis_completed_transcript_claim_version is null
    and v_claim.analysis_completed_transcript_hash is null then
    return query select
      'analysis_present_unversioned'::text,
      null::uuid,
      v_claim.analysis_claim_version,
      null::timestamptz;
    return;
  end if;

  if v_claim.analysis_processing_state = 'completed'
    and (
      v_interview.interview_analysis_v2 is null
      or v_claim.analysis_completed_transcript_claim_version >= p_expected_transcript_claim_version
    ) then
    return query select
      'invalid_request'::text, null::uuid, v_claim.analysis_claim_version, null::timestamptz;
    return;
  end if;

  if v_claim.analysis_processing_state = 'claimed' then
    if v_claim.analysis_expected_transcript_claim_version = p_expected_transcript_claim_version
      and v_claim.analysis_expected_transcript_hash = p_expected_transcript_hash then
      if v_claim.analysis_lease_expires_at > now() then
        return query select
          'busy'::text,
          null::uuid,
          v_claim.analysis_claim_version,
          v_claim.analysis_lease_expires_at;
        return;
      end if;
      v_recovered := true;
    elsif v_claim.analysis_expected_transcript_claim_version >= p_expected_transcript_claim_version then
      return query select
        'superseded'::text, null::uuid, v_claim.analysis_claim_version, null::timestamptz;
      return;
    end if;
  end if;

  v_token := gen_random_uuid();
  update private.interview_final_transcript_reconciliation_claims c
  set analysis_processing_state = 'claimed',
      analysis_claim_token = v_token,
      analysis_last_released_claim_token = null,
      analysis_claim_version = c.analysis_claim_version + 1,
      analysis_lease_expires_at = now() + make_interval(secs => p_lease_seconds),
      analysis_claimed_at = now(),
      analysis_expected_transcript_claim_version = p_expected_transcript_claim_version,
      analysis_expected_transcript_hash = p_expected_transcript_hash,
      analysis_last_failure_category = null,
      updated_at = now()
  where c.interview_id = p_interview_id
  returning c.* into v_claim;

  return query select
    case when v_recovered then 'recovered_expired_claim' else 'claimed' end,
    v_claim.analysis_claim_token,
    v_claim.analysis_claim_version,
    v_claim.analysis_lease_expires_at;
end
$$;

create or replace function public.finalize_interview_analysis_v2_if_authoritative(
  p_interview_id uuid,
  p_analysis_claim_token uuid,
  p_analysis_claim_version bigint,
  p_expected_transcript_claim_version bigint,
  p_expected_transcript_hash text,
  p_analysis jsonb
)
returns table (outcome text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_claim private.interview_final_transcript_reconciliation_claims%rowtype;
  v_interview public.interviews%rowtype;
begin
  if not private.is_valid_interview_analysis_v2(p_analysis) then
    return query select 'invalid_analysis'::text;
    return;
  end if;

  select c.* into v_claim
  from private.interview_final_transcript_reconciliation_claims c
  where c.interview_id = p_interview_id
  for update;
  if not found then
    if exists (select 1 from public.interviews i where i.id = p_interview_id) then
      return query select 'stale_claim'::text;
    else
      return query select 'interview_not_found'::text;
    end if;
    return;
  end if;

  if v_claim.analysis_processing_state = 'completed'
    and v_claim.analysis_last_completed_claim_token is not distinct from p_analysis_claim_token
    and v_claim.analysis_claim_version = p_analysis_claim_version
    and v_claim.analysis_completed_transcript_claim_version = p_expected_transcript_claim_version
    and v_claim.analysis_completed_transcript_hash = p_expected_transcript_hash then
    return query select 'already_current'::text;
    return;
  end if;

  if v_claim.analysis_processing_state <> 'claimed'
    or v_claim.analysis_claim_token is distinct from p_analysis_claim_token
    or v_claim.analysis_claim_version <> p_analysis_claim_version
    or v_claim.analysis_lease_expires_at is null
    or v_claim.analysis_lease_expires_at <= now()
    or v_claim.analysis_expected_transcript_claim_version
      is distinct from p_expected_transcript_claim_version
    or v_claim.analysis_expected_transcript_hash
      is distinct from p_expected_transcript_hash then
    return query select 'stale_claim'::text;
    return;
  end if;

  if v_claim.processing_state <> 'completed'
    or v_claim.claim_version <> p_expected_transcript_claim_version
    or v_claim.authoritative_transcript_hash is distinct from p_expected_transcript_hash then
    update private.interview_final_transcript_reconciliation_claims c
    set analysis_processing_state = case
          when c.analysis_completed_transcript_claim_version is null
            then 'available'
          else 'completed'
        end,
        analysis_last_released_claim_token = p_analysis_claim_token,
        analysis_claim_token = null,
        analysis_lease_expires_at = null,
        analysis_claimed_at = null,
        analysis_expected_transcript_claim_version = null,
        analysis_expected_transcript_hash = null,
        analysis_last_failure_category = 'analysis_superseded',
        updated_at = now()
    where c.interview_id = p_interview_id;
    return query select 'superseded'::text;
    return;
  end if;

  select i.* into v_interview
  from public.interviews i
  where i.id = p_interview_id
  for update;
  if not found then
    return query select 'interview_not_found'::text;
    return;
  end if;

  update public.interviews i
  set interview_analysis_v2 = p_analysis,
      updated_at = now()
  where i.id = p_interview_id;

  update private.interview_final_transcript_reconciliation_claims c
  set analysis_processing_state = 'completed',
      analysis_last_completed_claim_token = p_analysis_claim_token,
      analysis_claim_token = null,
      analysis_lease_expires_at = null,
      analysis_claimed_at = null,
      analysis_expected_transcript_claim_version = null,
      analysis_expected_transcript_hash = null,
      analysis_completed_transcript_claim_version = p_expected_transcript_claim_version,
      analysis_completed_transcript_hash = p_expected_transcript_hash,
      analysis_completed_at = now(),
      analysis_last_failure_category = null,
      updated_at = now()
  where c.interview_id = p_interview_id;

  return query select 'stored'::text;
end
$$;

create or replace function public.release_interview_analysis_v2_claim(
  p_interview_id uuid,
  p_analysis_claim_token uuid,
  p_analysis_claim_version bigint,
  p_failure_category text
)
returns table (outcome text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_claim private.interview_final_transcript_reconciliation_claims%rowtype;
  v_restore_completed boolean;
begin
  if p_failure_category is null
    or p_failure_category not in (
      'analysis_generation_failed',
      'analysis_finalize_failed',
      'analysis_superseded',
      'worker_shutdown'
    ) then
    raise exception using
      errcode = 'P0001',
      message = 'analysis_v2_failure_category_invalid';
  end if;

  select c.* into v_claim
  from private.interview_final_transcript_reconciliation_claims c
  where c.interview_id = p_interview_id
  for update;
  if not found then
    return query select 'claim_mismatch'::text;
    return;
  end if;

  if v_claim.analysis_processing_state = 'completed'
    and v_claim.analysis_last_completed_claim_token is not distinct from p_analysis_claim_token
    and v_claim.analysis_claim_version = p_analysis_claim_version then
    return query select 'already_completed'::text;
    return;
  end if;

  if v_claim.analysis_processing_state in ('available', 'completed')
    and v_claim.analysis_last_released_claim_token is not distinct from p_analysis_claim_token
    and v_claim.analysis_claim_version = p_analysis_claim_version then
    return query select 'already_released'::text;
    return;
  end if;

  if v_claim.analysis_processing_state <> 'claimed'
    or v_claim.analysis_claim_token is distinct from p_analysis_claim_token
    or v_claim.analysis_claim_version <> p_analysis_claim_version then
    return query select 'claim_mismatch'::text;
    return;
  end if;

  v_restore_completed :=
    v_claim.analysis_completed_transcript_claim_version is not null
    and exists (
      select 1
      from public.interviews i
      where i.id = p_interview_id
        and i.interview_analysis_v2 is not null
    );

  update private.interview_final_transcript_reconciliation_claims c
  set analysis_processing_state = case
        when v_restore_completed then 'completed'
        else 'available'
      end,
      analysis_last_released_claim_token = p_analysis_claim_token,
      analysis_claim_token = null,
      analysis_lease_expires_at = null,
      analysis_claimed_at = null,
      analysis_expected_transcript_claim_version = null,
      analysis_expected_transcript_hash = null,
      analysis_completed_transcript_claim_version = case
        when v_restore_completed then c.analysis_completed_transcript_claim_version
        else null
      end,
      analysis_completed_transcript_hash = case
        when v_restore_completed then c.analysis_completed_transcript_hash
        else null
      end,
      analysis_last_completed_claim_token = case
        when v_restore_completed then c.analysis_last_completed_claim_token
        else null
      end,
      analysis_completed_at = case
        when v_restore_completed then c.analysis_completed_at
        else null
      end,
      analysis_last_failure_category = p_failure_category,
      updated_at = now()
  where c.interview_id = p_interview_id;

  return query select 'released'::text;
end
$$;

create or replace function public.release_interview_final_transcript_reconciliation(
  p_interview_id uuid,
  p_claim_token uuid,
  p_claim_version bigint,
  p_failure_category text
)
returns table (outcome text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_claim private.interview_final_transcript_reconciliation_claims%rowtype;
begin
  if p_failure_category is null
    or p_failure_category not in (
      'scoring_failed',
      'storage_failed',
      'finalize_failed',
      'worker_shutdown'
    ) then
    raise exception using errcode = 'P0001', message = 'final_transcript_failure_category_invalid';
  end if;

  select c.* into v_claim
  from private.interview_final_transcript_reconciliation_claims c
  where c.interview_id = p_interview_id
  for update;
  if not found then
    return query select 'claim_mismatch'::text;
    return;
  end if;

  if v_claim.processing_state = 'completed'
    and v_claim.claim_token is not distinct from p_claim_token
    and v_claim.claim_version = p_claim_version then
    return query select 'already_completed'::text;
    return;
  end if;

  if v_claim.processing_state = 'available'
    and v_claim.last_released_claim_token is not distinct from p_claim_token
    and v_claim.claim_version = p_claim_version then
    return query select 'already_released'::text;
    return;
  end if;

  if v_claim.processing_state <> 'claimed'
    or v_claim.claim_token is distinct from p_claim_token
    or v_claim.claim_version <> p_claim_version then
    return query select 'claim_mismatch'::text;
    return;
  end if;

  update private.interview_final_transcript_reconciliation_claims c
  set processing_state = case
        when c.authoritative_transcript_hash is null then 'available'
        else 'completed'
      end,
      last_released_claim_token = p_claim_token,
      claim_token = null,
      lease_expires_at = null,
      claimed_at = null,
      pending_transcript_hash = null,
      pending_evidence_snapshot = null,
      pending_provider_event_key = null,
      scoring_required = null,
      last_failure_category = p_failure_category,
      updated_at = now()
  where c.interview_id = p_interview_id;

  return query select 'released'::text;
end
$$;

revoke all on schema private from public, anon, authenticated;
revoke all on table private.interview_final_transcript_reconciliation_claims
  from public, anon, authenticated, service_role;
revoke all on function public.claim_interview_final_transcript_reconciliation(
  uuid, text, text, text, jsonb, integer
) from public, anon, authenticated, service_role;
revoke all on function public.finalize_interview_final_transcript_reconciliation(
  uuid, text, uuid, bigint, text, text, text, text, jsonb, jsonb, text
) from public, anon, authenticated, service_role;
revoke all on function public.release_interview_final_transcript_reconciliation(
  uuid, uuid, bigint, text
) from public, anon, authenticated, service_role;
revoke all on function public.persist_interview_unanswered_questions_if_authoritative(
  uuid, bigint, text, jsonb
) from public, anon, authenticated, service_role;
revoke all on function public.claim_interview_analysis_v2_if_authoritative(
  uuid, bigint, text, integer
) from public, anon, authenticated, service_role;
revoke all on function public.finalize_interview_analysis_v2_if_authoritative(
  uuid, uuid, bigint, bigint, text, jsonb
) from public, anon, authenticated, service_role;
revoke all on function public.release_interview_analysis_v2_claim(
  uuid, uuid, bigint, text
) from public, anon, authenticated, service_role;

grant execute on function public.claim_interview_final_transcript_reconciliation(
  uuid, text, text, text, jsonb, integer
) to service_role;
grant execute on function public.finalize_interview_final_transcript_reconciliation(
  uuid, text, uuid, bigint, text, text, text, text, jsonb, jsonb, text
) to service_role;
grant execute on function public.release_interview_final_transcript_reconciliation(
  uuid, uuid, bigint, text
) to service_role;
grant execute on function public.persist_interview_unanswered_questions_if_authoritative(
  uuid, bigint, text, jsonb
) to service_role;
grant execute on function public.claim_interview_analysis_v2_if_authoritative(
  uuid, bigint, text, integer
) to service_role;
grant execute on function public.finalize_interview_analysis_v2_if_authoritative(
  uuid, uuid, bigint, bigint, text, jsonb
) to service_role;
grant execute on function public.release_interview_analysis_v2_claim(
  uuid, uuid, bigint, text
) to service_role;

comment on table private.interview_final_transcript_reconciliation_claims is
  'Private lease and authoritative snapshot state for database-serialized final-transcript reconciliation.';
comment on function public.claim_interview_final_transcript_reconciliation(
  uuid, text, text, text, jsonb, integer
) is
  'Claims one bounded final-transcript reconciliation worker without changing interview evidence.';
comment on function public.finalize_interview_final_transcript_reconciliation(
  uuid, text, uuid, bigint, text, text, text, text, jsonb, jsonb, text
) is
  'Atomically selects and persists one coherent final-transcript evidence snapshot under exact lease ownership.';
comment on function public.release_interview_final_transcript_reconciliation(
  uuid, uuid, bigint, text
) is
  'Releases an exact failed final-transcript claim with a bounded failure category.';
comment on function public.persist_interview_unanswered_questions_if_authoritative(
  uuid, bigint, text, jsonb
) is
  'Stores bounded unanswered candidate questions once when the completed transcript version and hash remain authoritative.';
comment on function public.claim_interview_analysis_v2_if_authoritative(
  uuid, bigint, text, integer
) is
  'Claims bounded Analysis V2 ownership for one exact completed authoritative transcript version and hash.';
comment on function public.finalize_interview_analysis_v2_if_authoritative(
  uuid, uuid, bigint, bigint, text, jsonb
) is
  'Atomically stores bounded Analysis V2 output only while the exact transcript version and analysis lease remain authoritative.';
comment on function public.release_interview_analysis_v2_claim(
  uuid, uuid, bigint, text
) is
  'Idempotently releases one exact failed Analysis V2 claim without changing transcript evidence or stored analysis.';
