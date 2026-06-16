create table if not exists public.automation_action_approval_tokens (
  id uuid primary key default gen_random_uuid(),
  action_id uuid not null references public.automation_actions(id) on delete cascade,
  client_id uuid not null references public.clients(id) on delete cascade,
  token_hash text not null,
  token_purpose text not null default 'manager_review',
  state text not null default 'active',
  recipient_user_id uuid null,
  recipient_email text null,
  expires_at timestamptz not null,
  used_at timestamptz null,
  last_viewed_at timestamptz null,
  view_count integer not null default 0,
  rejected_at timestamptz null,
  request_id text null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint automation_action_approval_tokens_purpose_check
    check (token_purpose in ('manager_review')),
  constraint automation_action_approval_tokens_state_check
    check (state in ('active', 'rejected', 'expired', 'revoked', 'used')),
  constraint automation_action_approval_tokens_view_count_check
    check (view_count >= 0),
  constraint automation_action_approval_tokens_hash_length_check
    check (length(token_hash) > 20)
);

create unique index if not exists automation_action_approval_tokens_token_hash_idx
  on public.automation_action_approval_tokens (token_hash);

create index if not exists automation_action_approval_tokens_action_idx
  on public.automation_action_approval_tokens (action_id);

create index if not exists automation_action_approval_tokens_client_created_idx
  on public.automation_action_approval_tokens (client_id, created_at desc);

create index if not exists automation_action_approval_tokens_state_expires_idx
  on public.automation_action_approval_tokens (state, expires_at);

alter table public.automation_action_approval_tokens enable row level security;
