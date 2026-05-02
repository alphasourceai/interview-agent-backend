alter table public.interviews
  add column if not exists recording_expires_at timestamptz;

create index if not exists idx_interviews_recording_expires_ready
  on public.interviews (recording_expires_at)
  where recording_status = 'ready'
    and recording_expires_at is not null;

create or replace function public.set_interview_recording_expiration_on_role_status()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if old.status is distinct from new.status and new.status = 'inactive' then
    update public.interviews
    set recording_expires_at = now() + interval '14 days'
    where role_id = new.id
      and client_id = new.client_id
      and recording_status = 'ready'
      and recording_deleted_at is null;
  elsif old.status is distinct from new.status and new.status = 'active' then
    update public.interviews
    set recording_expires_at = null
    where role_id = new.id
      and client_id = new.client_id
      and recording_status = 'ready'
      and recording_deleted_at is null;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_roles_recording_expiration on public.roles;

create trigger trg_roles_recording_expiration
  after update of status on public.roles
  for each row
  execute function public.set_interview_recording_expiration_on_role_status();
