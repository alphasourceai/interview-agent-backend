begin;

-- 2026-08-03 critical Data API containment.
-- All application access to these objects is backend/service-role mediated.
-- Keep this list explicit so schema drift fails review instead of widening access.

revoke all privileges on table
  public.accommodation_requests,
  public.billing_events,
  public.client_plan_settings,
  public.contract_cancellation_runs,
  public.contract_processing_runs,
  public.conversations,
  public.digest_logs,
  public.feedback_issues_catalog,
  public.feedback_submissions,
  public.feedback_suggestions_catalog,
  public.otp_tokens,
  public.pending_role_purchases,
  public.request_rate_limits,
  public.role_interview_purchases,
  public.rubric_change_requests
from public, anon, authenticated;

alter table public.accommodation_requests enable row level security;
alter table public.billing_events enable row level security;
alter table public.client_plan_settings enable row level security;
alter table public.contract_cancellation_runs enable row level security;
alter table public.contract_processing_runs enable row level security;
alter table public.conversations enable row level security;
alter table public.digest_logs enable row level security;
alter table public.feedback_issues_catalog enable row level security;
alter table public.feedback_submissions enable row level security;
alter table public.feedback_suggestions_catalog enable row level security;
alter table public.otp_tokens enable row level security;
alter table public.pending_role_purchases enable row level security;
alter table public.request_rate_limits enable row level security;
alter table public.role_interview_purchases enable row level security;
alter table public.rubric_change_requests enable row level security;

grant select, insert, update, delete on table
  public.accommodation_requests,
  public.billing_events,
  public.client_plan_settings,
  public.contract_cancellation_runs,
  public.contract_processing_runs,
  public.conversations,
  public.digest_logs,
  public.feedback_issues_catalog,
  public.feedback_submissions,
  public.feedback_suggestions_catalog,
  public.otp_tokens,
  public.pending_role_purchases,
  public.request_rate_limits,
  public.role_interview_purchases,
  public.rubric_change_requests
to service_role;

-- No runtime dependency exists. Removing the owner-executed view eliminates the
-- plaintext OTP bypass instead of preserving another privileged API surface.
drop view if exists public.v_latest_otp_per_email_role;

revoke all privileges on table public.role_candidate_counts
from public, anon, authenticated;
grant select on table public.role_candidate_counts to service_role;

revoke all privileges on sequence public.billing_events_id_seq
from public, anon, authenticated;
grant usage, select on sequence public.billing_events_id_seq to service_role;

revoke all privileges on function public.check_and_increment_rate_limit(text, text, integer, integer)
from public, anon, authenticated;
grant execute on function public.check_and_increment_rate_limit(text, text, integer, integer)
to service_role;

commit;
