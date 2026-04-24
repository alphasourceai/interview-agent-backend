create table if not exists public.rubric_change_requests (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),

  client_id uuid not null,
  role_id uuid not null,

  requested_by_user_id uuid null,
  requested_by_email text null,
  requested_by_name text null,

  notes text null,
  questions jsonb null,

  status text not null default 'new',
  metadata jsonb null
);

create index if not exists rubric_change_requests_client_id_idx
  on public.rubric_change_requests (client_id);

create index if not exists rubric_change_requests_role_id_idx
  on public.rubric_change_requests (role_id);

create index if not exists rubric_change_requests_created_at_idx
  on public.rubric_change_requests (created_at desc);
