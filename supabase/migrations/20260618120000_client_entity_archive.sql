alter table public.clients
  add column if not exists archived_at timestamptz null,
  add column if not exists archived_reason text null,
  add column if not exists archived_by_user_id uuid null;

create index if not exists clients_parent_archived_idx
  on public.clients (parent_client_id, archived_at);

comment on column public.clients.archived_at is
  'Soft archive timestamp for child client entities. Parent clients are not archived through entity controls.';
comment on column public.clients.archived_reason is
  'Optional reason recorded when a child client entity is archived.';
comment on column public.clients.archived_by_user_id is
  'Auth user id that archived the child client entity, when available.';
