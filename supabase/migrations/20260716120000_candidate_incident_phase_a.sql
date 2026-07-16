alter table public.candidates
  add column if not exists resume_original_filename text,
  add column if not exists resume_size_bytes bigint,
  add column if not exists resume_mime_type text,
  add column if not exists resume_sha256 text,
  add column if not exists resume_parse_status text,
  add column if not exists resume_parse_note text;

alter table public.accommodation_requests
  add column if not exists resume_original_filename text,
  add column if not exists resume_size_bytes bigint,
  add column if not exists resume_mime_type text,
  add column if not exists resume_sha256 text,
  add column if not exists resume_parse_status text,
  add column if not exists resume_parse_note text;

alter table public.interviews
  add column if not exists failure_code text,
  add column if not exists failure_stage text,
  add column if not exists failure_summary text,
  add column if not exists failure_at timestamptz,
  add column if not exists retryable boolean;

create table if not exists public.candidate_submission_requests (
  id uuid primary key default gen_random_uuid(),
  role_id uuid not null references public.roles(id) on delete cascade,
  submission_key uuid not null,
  candidate_id uuid references public.candidates(id) on delete set null,
  status text not null default 'processing' check (status in ('processing', 'completed', 'failed')),
  response_status integer,
  response_body jsonb,
  last_error_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (role_id, submission_key)
);

create index if not exists candidate_submission_requests_candidate_idx
  on public.candidate_submission_requests (candidate_id);

create index if not exists candidate_submission_requests_updated_idx
  on public.candidate_submission_requests (updated_at);

alter table public.candidate_submission_requests enable row level security;

comment on table public.candidate_submission_requests is
  'Service-role-only idempotency ledger for public candidate submissions.';
