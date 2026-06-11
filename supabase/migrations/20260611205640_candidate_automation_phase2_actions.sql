create table if not exists public.automation_actions (
  id uuid primary key default gen_random_uuid(),
  evaluation_id uuid null references public.automation_evaluations(id) on delete set null,
  rule_id uuid not null references public.automation_rules(id) on delete cascade,
  rule_version integer not null,
  client_id uuid not null references public.clients(id) on delete cascade,
  role_id uuid not null references public.roles(id) on delete cascade,
  candidate_id uuid not null references public.candidates(id) on delete cascade,
  report_id uuid null references public.reports(id) on delete set null,
  interview_id uuid null references public.interviews(id) on delete set null,
  action_type text not null default 'send_second_round_scheduling_email',
  state text not null default 'pending_approval',
  idempotency_key text not null,
  candidate_snapshot jsonb not null,
  action_snapshot jsonb not null default '{}'::jsonb,
  approved_by_user_id uuid null,
  approved_by_email text null,
  approved_at timestamptz null,
  rejected_at timestamptz null,
  canceled_at timestamptz null,
  sent_at timestamptz null,
  failed_at timestamptz null,
  last_error text null,
  send_attempt_count integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint automation_actions_action_type_check
    check (action_type in ('send_second_round_scheduling_email')),
  constraint automation_actions_state_check
    check (state in (
      'pending_approval',
      'approved',
      'rejected',
      'queued',
      'sending',
      'sent',
      'delivered',
      'failed',
      'canceled',
      'skipped_duplicate',
      'expired'
    )),
  constraint automation_actions_rule_version_check
    check (rule_version >= 1),
  constraint automation_actions_send_attempt_count_check
    check (send_attempt_count >= 0),
  constraint automation_actions_candidate_snapshot_object_check
    check (jsonb_typeof(candidate_snapshot) = 'object'),
  constraint automation_actions_action_snapshot_object_check
    check (jsonb_typeof(action_snapshot) = 'object')
);

create unique index if not exists automation_actions_idempotency_key_idx
  on public.automation_actions (idempotency_key);

create unique index if not exists automation_actions_one_active_sendable_idx
  on public.automation_actions (rule_id, candidate_id, action_type)
  where state in ('pending_approval', 'approved', 'queued', 'sending', 'sent', 'delivered');

create index if not exists automation_actions_client_state_created_idx
  on public.automation_actions (client_id, state, created_at desc);

create index if not exists automation_actions_candidate_created_idx
  on public.automation_actions (candidate_id, created_at desc);

create index if not exists automation_actions_rule_created_idx
  on public.automation_actions (rule_id, created_at desc);

alter table public.automation_actions enable row level security;

create table if not exists public.automation_action_events (
  id uuid primary key default gen_random_uuid(),
  action_id uuid not null references public.automation_actions(id) on delete cascade,
  client_id uuid not null references public.clients(id) on delete cascade,
  event_type text not null,
  from_state text null,
  to_state text null,
  actor_type text not null default 'system',
  actor_user_id uuid null,
  actor_email text null,
  request_id text null,
  metadata jsonb null,
  created_at timestamptz not null default now(),
  constraint automation_action_events_actor_type_check
    check (actor_type in ('system', 'user', 'admin')),
  constraint automation_action_events_metadata_object_check
    check (metadata is null or jsonb_typeof(metadata) = 'object')
);

create index if not exists automation_action_events_action_created_idx
  on public.automation_action_events (action_id, created_at desc);

create index if not exists automation_action_events_client_created_idx
  on public.automation_action_events (client_id, created_at desc);

create index if not exists automation_action_events_type_created_idx
  on public.automation_action_events (event_type, created_at desc);

alter table public.automation_action_events enable row level security;
