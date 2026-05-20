alter table public.clients
  add column if not exists parent_client_id uuid null references public.clients(id) on delete restrict;

alter table public.clients
  add column if not exists entity_label text null;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.clients'::regclass
      and conname = 'clients_parent_client_id_not_self'
      and contype = 'c'
  ) then
    alter table public.clients
      add constraint clients_parent_client_id_not_self
      check (parent_client_id is null or parent_client_id <> id);
  end if;
end $$;

create index if not exists clients_parent_client_id_idx
  on public.clients (parent_client_id);

comment on column public.clients.parent_client_id is
  'If set, this client row is a child entity under the referenced parent client. Null means this row is a parent/top-level client.';

comment on column public.clients.entity_label is
  'Optional display language for a child entity, such as office, location, or entity.';

do $$
begin
  if to_regclass('public.client_members') is not null
     and exists (
       select 1
       from pg_constraint
       where conrelid = 'public.client_members'::regclass
         and conname = 'client_members_role_check'
         and contype = 'c'
     ) then
    alter table public.client_members
      drop constraint client_members_role_check;

    alter table public.client_members
      add constraint client_members_role_check
      check (
        role = any (
          array[
            'owner'::text,
            'admin'::text,
            'member'::text,
            'manager'::text,
            'tester'::text,
            'super_admin'::text
          ]
        )
      ) not valid;
  end if;
end $$;
