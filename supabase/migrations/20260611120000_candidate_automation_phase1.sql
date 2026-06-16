create extension if not exists pgcrypto;

create table if not exists public.automation_rules (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete cascade,
  role_id uuid not null references public.roles(id) on delete cascade,
  enabled boolean not null default false,
  mode text not null default 'daily_digest_pending_approval',
  criteria_config jsonb not null default '{}'::jsonb,
  action_config jsonb not null default '{}'::jsonb,
  digest_config jsonb not null default '{}'::jsonb,
  rule_version integer not null default 1,
  created_by_user_id uuid null,
  created_by_email text null,
  updated_by_user_id uuid null,
  updated_by_email text null,
  archived_at timestamptz null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint automation_rules_mode_check
    check (mode in ('daily_digest_pending_approval')),
  constraint automation_rules_rule_version_check
    check (rule_version >= 1),
  constraint automation_rules_criteria_config_object_check
    check (jsonb_typeof(criteria_config) = 'object'),
  constraint automation_rules_action_config_object_check
    check (jsonb_typeof(action_config) = 'object'),
  constraint automation_rules_digest_config_object_check
    check (jsonb_typeof(digest_config) = 'object')
);

create index if not exists automation_rules_client_role_idx
  on public.automation_rules (client_id, role_id);

create index if not exists automation_rules_enabled_client_idx
  on public.automation_rules (enabled, client_id);

create unique index if not exists automation_rules_one_current_per_role_idx
  on public.automation_rules (role_id)
  where archived_at is null;

alter table public.automation_rules enable row level security;

create table if not exists public.automation_evaluations (
  id uuid primary key default gen_random_uuid(),
  rule_id uuid null references public.automation_rules(id) on delete set null,
  rule_version integer null,
  client_id uuid not null references public.clients(id) on delete cascade,
  role_id uuid not null references public.roles(id) on delete cascade,
  candidate_id uuid not null references public.candidates(id) on delete cascade,
  report_id uuid null references public.reports(id) on delete set null,
  interview_id uuid null references public.interviews(id) on delete set null,
  trigger_source text not null,
  matched boolean not null default false,
  evaluation_status text not null,
  criteria_config_snapshot jsonb not null,
  normalized_candidate_snapshot jsonb not null,
  match_reasons jsonb not null default '[]'::jsonb,
  non_match_reasons jsonb not null default '[]'::jsonb,
  score_snapshot_hash text not null,
  idempotency_key text not null,
  request_id text null,
  created_at timestamptz not null default now(),
  constraint automation_evaluations_trigger_source_check
    check (trigger_source in ('dry_run', 'manual')),
  constraint automation_evaluations_status_check
    check (evaluation_status in ('dry_run', 'matched', 'not_matched', 'skipped', 'error')),
  constraint automation_evaluations_rule_version_check
    check (rule_version is null or rule_version >= 1),
  constraint automation_evaluations_criteria_snapshot_object_check
    check (jsonb_typeof(criteria_config_snapshot) = 'object'),
  constraint automation_evaluations_candidate_snapshot_object_check
    check (jsonb_typeof(normalized_candidate_snapshot) = 'object'),
  constraint automation_evaluations_match_reasons_array_check
    check (jsonb_typeof(match_reasons) = 'array'),
  constraint automation_evaluations_non_match_reasons_array_check
    check (jsonb_typeof(non_match_reasons) = 'array')
);

create unique index if not exists automation_evaluations_idempotency_key_idx
  on public.automation_evaluations (idempotency_key);

create index if not exists automation_evaluations_client_role_created_idx
  on public.automation_evaluations (client_id, role_id, created_at desc);

create index if not exists automation_evaluations_candidate_created_idx
  on public.automation_evaluations (candidate_id, created_at desc);

alter table public.automation_evaluations enable row level security;
