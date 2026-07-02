create extension if not exists pgcrypto;

create table if not exists public.interview_perception_events (
  id uuid primary key default gen_random_uuid(),
  interview_id uuid references public.interviews(id) on delete cascade,
  client_id uuid references public.clients(id) on delete cascade,
  conversation_id text,
  event_type text not null,
  event_id text,
  received_at timestamptz not null default now(),
  tavus_created_at timestamptz,
  payload jsonb not null default '{}'::jsonb,
  normalized jsonb not null default '{}'::jsonb,
  dedupe_key text
);

create index if not exists interview_perception_events_interview_received_idx
  on public.interview_perception_events (interview_id, received_at desc);

create index if not exists interview_perception_events_conversation_received_idx
  on public.interview_perception_events (conversation_id, received_at desc);

create index if not exists interview_perception_events_event_type_received_idx
  on public.interview_perception_events (event_type, received_at desc);

create index if not exists interview_perception_events_client_received_idx
  on public.interview_perception_events (client_id, received_at desc);

create unique index if not exists interview_perception_events_event_id_key
  on public.interview_perception_events (event_id)
  where event_id is not null;

create unique index if not exists interview_perception_events_dedupe_key_key
  on public.interview_perception_events (dedupe_key)
  where dedupe_key is not null;

alter table public.interview_perception_events enable row level security;

drop policy if exists interview_perception_events_select_by_membership on public.interview_perception_events;
create policy interview_perception_events_select_by_membership
on public.interview_perception_events
for select
using (
  auth.role() = 'service_role'
  or public.has_client_membership(client_id)
);

drop policy if exists interview_perception_events_insert_service_role on public.interview_perception_events;
create policy interview_perception_events_insert_service_role
on public.interview_perception_events
for insert
with check (auth.role() = 'service_role');

drop policy if exists interview_perception_events_update_service_role on public.interview_perception_events;
create policy interview_perception_events_update_service_role
on public.interview_perception_events
for update
using (auth.role() = 'service_role')
with check (auth.role() = 'service_role');

drop policy if exists interview_perception_events_delete_service_role on public.interview_perception_events;
create policy interview_perception_events_delete_service_role
on public.interview_perception_events
for delete
using (auth.role() = 'service_role');
