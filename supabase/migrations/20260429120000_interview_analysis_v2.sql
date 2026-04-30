alter table public.interviews
  add column if not exists interview_analysis_v2 jsonb;
