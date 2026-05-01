alter table public.interviews
  add column if not exists recording_deleted_at timestamptz,
  add column if not exists recording_delete_reason text,
  add column if not exists recording_delete_error text;
