create extension if not exists pgcrypto;

create table if not exists public.automation_digest_approval_tokens (
  id uuid primary key default gen_random_uuid(),
  delivery_id uuid not null references public.automation_digest_deliveries(id) on delete cascade,
  client_id uuid not null references public.clients(id) on delete cascade,
  recipient_email text not null,
  token_hash text not null,
  token_purpose text not null default 'pending_approval_digest',
  state text not null default 'active',
  expires_at timestamptz not null,
  item_salt text not null,
  last_viewed_at timestamptz null,
  view_count integer not null default 0,
  request_id text null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint automation_digest_approval_tokens_purpose_check
    check (token_purpose in ('pending_approval_digest')),
  constraint automation_digest_approval_tokens_state_check
    check (state in ('active', 'revoked', 'expired')),
  constraint automation_digest_approval_tokens_recipient_email_check
    check (length(trim(recipient_email)) > 3),
  constraint automation_digest_approval_tokens_hash_check
    check (length(trim(token_hash)) > 20),
  constraint automation_digest_approval_tokens_item_salt_check
    check (length(trim(item_salt)) > 20),
  constraint automation_digest_approval_tokens_view_count_check
    check (view_count >= 0),
  constraint automation_digest_approval_tokens_expires_after_created_check
    check (expires_at > created_at)
);

create unique index if not exists automation_digest_approval_tokens_token_hash_idx
  on public.automation_digest_approval_tokens (token_hash);

create unique index if not exists automation_digest_approval_tokens_delivery_unique_idx
  on public.automation_digest_approval_tokens (delivery_id);

create index if not exists automation_digest_approval_tokens_client_created_idx
  on public.automation_digest_approval_tokens (client_id, created_at desc);

create index if not exists automation_digest_approval_tokens_state_expires_idx
  on public.automation_digest_approval_tokens (state, expires_at);

alter table public.automation_digest_approval_tokens enable row level security;
