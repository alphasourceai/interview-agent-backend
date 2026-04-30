alter table public.interviews
  add column if not exists recording_metadata jsonb not null default '{}'::jsonb,
  add column if not exists recording_status text,
  add column if not exists recording_ready_at timestamptz;
