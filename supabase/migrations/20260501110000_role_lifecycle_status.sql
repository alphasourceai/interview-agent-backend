alter table public.roles
  add column if not exists status text not null default 'active',
  add column if not exists closed_at timestamptz,
  add column if not exists closed_by uuid,
  add column if not exists inactive_reason text;

update public.roles
set status = 'active'
where status is null;

alter table public.roles
  alter column status set default 'active',
  alter column status set not null;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'roles_status_check'
      and conrelid = 'public.roles'::regclass
  ) then
    alter table public.roles
      add constraint roles_status_check check (status in ('active', 'inactive'));
  end if;
end $$;

create index if not exists idx_roles_client_status_created_at
  on public.roles (client_id, status, created_at desc);
