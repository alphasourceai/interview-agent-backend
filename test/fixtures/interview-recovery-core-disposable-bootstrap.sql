create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;

do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin; end if;
end $$;

create table public.clients (
  id uuid primary key default gen_random_uuid(),
  name text,
  email text,
  archived_at timestamptz,
  access_override_mode text default 'inherit'
);

create table public.admins (
  id uuid primary key default gen_random_uuid(),
  user_id uuid,
  email text,
  is_active boolean not null default true
);

create table public.roles (
  id uuid primary key default gen_random_uuid(),
  client_id uuid references public.clients(id) on delete restrict,
  title text,
  slug_or_token text,
  status text not null default 'active',
  created_at timestamptz default now()
);

create table public.candidates (
  id uuid primary key default gen_random_uuid(),
  client_id uuid references public.clients(id) on delete restrict,
  role_id uuid references public.roles(id) on delete restrict,
  name text,
  email text,
  status text,
  interview_status text,
  interview_video_url text,
  candidate_external_id text,
  created_at timestamptz default now()
);

create table public.interviews (
  id uuid primary key default gen_random_uuid(),
  candidate_id uuid references public.candidates(id) on delete restrict,
  role_id uuid references public.roles(id) on delete restrict,
  client_id uuid references public.clients(id) on delete restrict,
  status text,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  video_url text,
  transcript_url text,
  transcript text,
  recording_status text,
  recording_ready_at timestamptz,
  recording_metadata jsonb not null default '{}'::jsonb,
  tavus_application_id text,
  failure_code text,
  failure_stage text,
  failure_summary text,
  failure_at timestamptz,
  retryable boolean
);

create unique index uniq_interviews_candidate_role
  on public.interviews(candidate_id, role_id)
  where candidate_id is not null and role_id is not null;

create table public.reports (
  id uuid primary key default gen_random_uuid(),
  candidate_id uuid references public.candidates(id) on delete restrict,
  client_id uuid references public.clients(id) on delete restrict,
  role_id uuid references public.roles(id) on delete restrict,
  resume_score numeric,
  resume_breakdown jsonb,
  interview_score numeric,
  overall_score numeric,
  interview_breakdown jsonb,
  analysis jsonb,
  report_url text,
  unanswered_candidate_questions jsonb,
  created_at timestamptz default now()
);

create table public.otp_tokens (
  id uuid primary key default gen_random_uuid(),
  candidate_email text,
  role_id uuid references public.roles(id) on delete restrict,
  code text,
  expires_at timestamptz,
  used boolean default false,
  created_at timestamptz default now()
);

grant usage on schema public to anon, authenticated, service_role;
grant select, insert, update, delete on all tables in schema public to service_role;
