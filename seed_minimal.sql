\set ON_ERROR_STOP 1
begin;

-- enable UUID func if needed (usually already present in Supabase)
create extension if not exists "pgcrypto";

-- 1) Client (NOTE: include email to satisfy NOT NULL)
insert into public.clients (id, name, email)
values (gen_random_uuid(), 'QA Demo Client', 'qa-demo-client@example.com')
returning id as client_id \gset

-- 2) Role
insert into public.roles (id, client_id, title, interview_type, rubric, job_description_url)
values (
  gen_random_uuid(),
  :'client_id',
  'Software Engineer',
  'basic',
  '{}'::jsonb,
  null
)
returning id as role_id \gset

-- 3) Candidates (insert one at a time so \gset gets exactly one row)
insert into public.candidates (id, client_id, role_id, name, email, status)
values (gen_random_uuid(), :'client_id', :'role_id', 'Ada Lovelace', 'ada.demo@example.com', 'invited')
returning id as candidate1_id \gset

insert into public.candidates (id, client_id, role_id, name, email, status)
values (gen_random_uuid(), :'client_id', :'role_id', 'Alan Turing', 'alan.demo@example.com', 'invited')
returning id as candidate2_id \gset

-- 4) Report (dummy URL) - tie to first candidate for now
insert into public.reports (id, client_id, role_id, candidate_id, url, status)
values (
  gen_random_uuid(),
  :'client_id',
  :'role_id',
  :'candidate1_id',
  'https://example.com/demo-report.pdf',
  'ready'
);

commit;

-- Smoke checks
select id, name, email from public.clients where id = :'client_id';
select id, title from public.roles   where id = :'role_id';
select id, name, email from public.candidates where client_id = :'client_id';
select id, url, status from public.reports where client_id = :'client_id';
