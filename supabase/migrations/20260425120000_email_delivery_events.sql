create extension if not exists pgcrypto;

create table if not exists public.email_delivery_events (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  event_at timestamptz null,
  event_type text not null,
  email text null,
  sg_event_id text null,
  sg_message_id text null,
  smtp_id text null,
  category text null,
  email_category text null,
  custom_args jsonb null,
  reason text null,
  status text null,
  response text null,
  attempt integer null,
  url text null,
  ip text null,
  useragent text null,
  tls text null,
  sg_template_id text null,
  subject text null,
  from_email text null,
  raw_payload jsonb not null,
  is_problem boolean not null default false,
  is_time_sensitive boolean not null default false,
  alert_sent_at timestamptz null,
  alert_error text null
);

create unique index if not exists email_delivery_events_sg_event_id_key
  on public.email_delivery_events (sg_event_id)
  where sg_event_id is not null;

create index if not exists email_delivery_events_event_at_idx
  on public.email_delivery_events (event_at desc);

create index if not exists email_delivery_events_event_type_idx
  on public.email_delivery_events (event_type);

create index if not exists email_delivery_events_email_idx
  on public.email_delivery_events (email);

create index if not exists email_delivery_events_problem_event_at_idx
  on public.email_delivery_events (is_problem, event_at desc);

create index if not exists email_delivery_events_email_category_idx
  on public.email_delivery_events (email_category);

create index if not exists email_delivery_events_sg_message_id_idx
  on public.email_delivery_events (sg_message_id);
