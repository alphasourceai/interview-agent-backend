\set ON_ERROR_STOP 1
begin;

with
  c as (
    select id as client_id
    from public.clients
    order by created_at desc
    limit 1
  ),
  r as (
    select id as role_id
    from public.roles
    where client_id = (select client_id from c)
    order by created_at desc
    limit 1
  ),
  cand as (
    select id as candidate_id
    from public.candidates
    where client_id = (select client_id from c)
      and role_id   = (select role_id   from r)
    order by created_at asc
    limit 1
  )
insert into public.reports (
  client_id,
  candidate_id,
  report_url,
  overall_score,
  resume_score,
  interview_score,
  resume_breakdown,
  interview_breakdown,
  analysis,
  candidate_external_id
)
select
  (select client_id   from c),
  (select candidate_id from cand),
  'https://example.com/demo-report.pdf',
  82, 80, 84,
  '{}'::jsonb, '{}'::jsonb, '{}'::jsonb,
  'demo-123';

commit;

-- Smoke check
select id, candidate_id, report_url, overall_score
from public.reports
order by created_at desc
limit 3;
