do $roles$
begin
  if not exists (select 1 from pg_roles where rolname = 'postgres') then create role postgres nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
end
$roles$;

create schema if not exists public;
grant usage on schema public to anon, authenticated, service_role;

create table public.clients (
  id uuid primary key,
  name text
);

create table public.roles (
  id uuid primary key,
  client_id uuid not null references public.clients(id),
  title text,
  status text
);

create table public.candidates (
  id uuid primary key,
  candidate_id uuid,
  client_id uuid not null references public.clients(id),
  role_id uuid not null references public.roles(id),
  email text,
  status text,
  verified boolean default false,
  otp_verified_at timestamptz
);

create table public.candidate_submission_requests (
  id uuid primary key,
  role_id uuid not null references public.roles(id),
  submission_key uuid not null,
  candidate_id uuid references public.candidates(id)
);

create table public.interviews (
  id uuid primary key,
  client_id uuid not null references public.clients(id),
  role_id uuid not null references public.roles(id),
  candidate_id uuid not null references public.candidates(id)
);

create table public.interview_reset_events (
  id uuid primary key,
  candidate_id uuid not null references public.candidates(id),
  role_id uuid not null references public.roles(id),
  client_id uuid not null references public.clients(id),
  previous_interview_id uuid not null references public.interviews(id)
);

create table public.otp_tokens (
  id uuid primary key default gen_random_uuid(),
  candidate_email text not null,
  code text not null,
  role_id uuid not null references public.roles(id),
  created_at timestamp without time zone default now(),
  expires_at timestamp without time zone not null,
  used boolean default false,
  used_at timestamptz,
  candidate_id uuid references public.candidates(id),
  interview_id uuid references public.interviews(id),
  invalidated_at timestamptz,
  invalidation_reason text
);
alter table public.otp_tokens enable row level security;

-- Match Supabase ownership so SECURITY DEFINER behavior is exercised under
-- the same privilege boundary as hosted QA.
alter table public.clients owner to postgres;
alter table public.roles owner to postgres;
alter table public.candidates owner to postgres;
alter table public.candidate_submission_requests owner to postgres;
alter table public.interviews owner to postgres;
alter table public.interview_reset_events owner to postgres;
alter table public.otp_tokens owner to postgres;

insert into public.clients(id,name) values
  ('82000000-0000-4000-8000-000000000001','OTP fixture'),
  ('82000000-0000-4000-8000-000000000002','Unrelated fixture');
insert into public.roles(id,client_id,title,status) values
  ('82000000-0000-4000-8000-000000000011','82000000-0000-4000-8000-000000000001','OTP role','active'),
  ('82000000-0000-4000-8000-000000000012','82000000-0000-4000-8000-000000000002','Other role','active');
insert into public.candidates(id,candidate_id,client_id,role_id,email,status) values
  ('82000000-0000-4000-8000-000000000021','82000000-0000-4000-8000-000000000021','82000000-0000-4000-8000-000000000001','82000000-0000-4000-8000-000000000011','candidate@example.test','Resume Uploaded'),
  ('82000000-0000-4000-8000-000000000022','82000000-0000-4000-8000-000000000022','82000000-0000-4000-8000-000000000002','82000000-0000-4000-8000-000000000012','other@example.test','Resume Uploaded');
insert into public.candidate_submission_requests(id,role_id,submission_key,candidate_id) values
  ('82000000-0000-4000-8000-000000000031','82000000-0000-4000-8000-000000000011','82000000-0000-4000-8000-000000000032','82000000-0000-4000-8000-000000000021'),
  ('82000000-0000-4000-8000-000000000033','82000000-0000-4000-8000-000000000011','82000000-0000-4000-8000-000000000034','82000000-0000-4000-8000-000000000021');
insert into public.interviews(id,client_id,role_id,candidate_id) values
  ('82000000-0000-4000-8000-000000000041','82000000-0000-4000-8000-000000000001','82000000-0000-4000-8000-000000000011','82000000-0000-4000-8000-000000000021');
insert into public.interview_reset_events(id,candidate_id,role_id,client_id,previous_interview_id) values
  ('82000000-0000-4000-8000-000000000051','82000000-0000-4000-8000-000000000021','82000000-0000-4000-8000-000000000011','82000000-0000-4000-8000-000000000001','82000000-0000-4000-8000-000000000041');
insert into public.otp_tokens(candidate_email,code,role_id,expires_at,candidate_id) values
  ('candidate@example.test','654321','82000000-0000-4000-8000-000000000011',now() + interval '10 minutes','82000000-0000-4000-8000-000000000021');
