create table if not exists public.automation_digest_deliveries (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete cascade,
  role_id uuid null references public.roles(id) on delete set null,
  recipient_email text not null,
  recipient_email_domain text null,
  digest_type text not null default 'pending_approval',
  delivery_date date not null,
  timezone text not null default 'America/Denver',
  send_time_local text null,
  status text not null,
  action_count integer not null default 0,
  action_ids uuid[] not null default '{}'::uuid[],
  request_id text null,
  sent_at timestamptz null,
  failed_at timestamptz null,
  last_error text null,
  created_by_user_id uuid null,
  created_by_email text null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint automation_digest_deliveries_digest_type_check
    check (digest_type in ('pending_approval')),
  constraint automation_digest_deliveries_status_check
    check (status in ('sending', 'sent', 'failed', 'skipped')),
  constraint automation_digest_deliveries_action_count_check
    check (action_count >= 0),
  constraint automation_digest_deliveries_recipient_email_check
    check (length(trim(recipient_email)) > 3),
  constraint automation_digest_deliveries_send_time_local_check
    check (send_time_local is null or send_time_local ~ '^(?:[01][0-9]|2[0-3]):[0-5][0-9]$')
);

create unique index if not exists automation_digest_deliveries_one_active_sent_idx
  on public.automation_digest_deliveries (
    client_id,
    coalesce(role_id, '00000000-0000-0000-0000-000000000000'::uuid),
    lower(recipient_email),
    digest_type,
    delivery_date
  )
  where status in ('sending', 'sent');

create index if not exists automation_digest_deliveries_client_date_idx
  on public.automation_digest_deliveries (client_id, delivery_date desc, created_at desc);

create index if not exists automation_digest_deliveries_recipient_date_idx
  on public.automation_digest_deliveries (lower(recipient_email), delivery_date desc);

create index if not exists automation_digest_deliveries_status_created_idx
  on public.automation_digest_deliveries (status, created_at desc);

alter table public.automation_digest_deliveries enable row level security;
