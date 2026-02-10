-- Accommodation requests table (ADA)
create table if not exists public.accommodation_requests (
  id uuid primary key default gen_random_uuid(),
  role_id uuid not null references public.roles(id) on delete cascade,
  candidate_id uuid references public.candidates(id) on delete set null,
  candidate_name text not null,
  candidate_email text not null,
  candidate_phone text,
  request_text text not null,
  resume_url text,
  status text not null default 'pending',
  admin_notes text,
  created_at timestamp with time zone not null default now(),
  approved_at timestamp with time zone,
  sent_at timestamp with time zone,
  resume_received_at timestamp with time zone,
  text_answers jsonb,
  text_completed_at timestamp with time zone
);

create index if not exists idx_accommodation_requests_status
  on public.accommodation_requests (status);

create index if not exists idx_accommodation_requests_role_id
  on public.accommodation_requests (role_id);

create index if not exists idx_accommodation_requests_created_at
  on public.accommodation_requests (created_at);
