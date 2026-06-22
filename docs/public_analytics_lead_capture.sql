-- QA setup for public page analytics and transparent lead-draft capture.
-- Apply in Supabase before enabling the website analytics/lead endpoints.

create extension if not exists pgcrypto;

create table if not exists public.public_analytics_events (
  id uuid primary key default gen_random_uuid(),
  event_name text not null,
  anonymous_id text,
  session_id text,
  path text,
  page_title text,
  referrer_path text,
  utm jsonb not null default '{}'::jsonb,
  properties jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default now(),
  request_id text,
  created_at timestamptz not null default now()
);

create index if not exists public_analytics_events_event_name_idx
  on public.public_analytics_events (event_name, occurred_at desc);

create index if not exists public_analytics_events_path_idx
  on public.public_analytics_events (path, occurred_at desc);

create index if not exists public_analytics_events_session_idx
  on public.public_analytics_events (session_id, occurred_at desc);

alter table public.public_analytics_events enable row level security;

create table if not exists public.public_lead_drafts (
  id uuid primary key,
  status text not null check (status in ('partial', 'abandoned', 'submitted')),
  form_id text,
  form_type text,
  product_interest text,
  first_name text,
  last_name text,
  email text,
  phone text,
  message text,
  fields_completed text[] not null default '{}'::text[],
  last_field text,
  source_path text,
  source_referrer_path text,
  source_cta text,
  utm jsonb not null default '{}'::jsonb,
  anonymous_id text,
  session_id text,
  privacy_notice_version text,
  request_id text,
  submitted_at timestamptz,
  expires_at timestamptz not null default (now() + interval '90 days'),
  archived_at timestamptz,
  archived_by_user_id text,
  archive_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.public_lead_drafts
  add column if not exists archived_at timestamptz;

alter table public.public_lead_drafts
  add column if not exists archived_by_user_id text;

alter table public.public_lead_drafts
  add column if not exists archive_reason text;

create index if not exists public_lead_drafts_status_idx
  on public.public_lead_drafts (status, updated_at desc);

create index if not exists public_lead_drafts_email_idx
  on public.public_lead_drafts (email)
  where email is not null;

create index if not exists public_lead_drafts_source_path_idx
  on public.public_lead_drafts (source_path, updated_at desc);

create index if not exists public_lead_drafts_archive_status_idx
  on public.public_lead_drafts (archived_at, updated_at desc);

alter table public.public_lead_drafts enable row level security;
