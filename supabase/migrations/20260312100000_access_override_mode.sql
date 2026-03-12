alter table public.clients
  add column if not exists access_override_mode text not null default 'inherit';

update public.clients
set access_override_mode = 'force_active'
where manual_active_override = true
  and access_override_mode = 'inherit';

alter table public.clients
  drop constraint if exists clients_access_override_mode_check;

alter table public.clients
  add constraint clients_access_override_mode_check
  check (access_override_mode in ('inherit', 'force_active', 'force_inactive'));
