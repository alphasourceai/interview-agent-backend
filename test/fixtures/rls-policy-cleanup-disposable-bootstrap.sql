\set ON_ERROR_STOP on

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin bypassrls;
  end if;
end
$$;

create schema if not exists auth;
create schema if not exists private;

create or replace function auth.uid()
returns uuid
language sql
stable
as $$
  select (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')::uuid
$$;

alter function auth.uid() owner to postgres;
grant usage on schema auth to anon, authenticated, service_role;
grant execute on function auth.uid() to anon, authenticated, service_role;

create table public.clients (
  id uuid primary key,
  name text,
  parent_client_id uuid null references public.clients(id),
  archived_at timestamptz null
);

create table public.client_members (
  client_id uuid not null references public.clients(id),
  user_id uuid not null,
  role text not null,
  primary key (client_id, user_id)
);

create index idx_client_members_user_id on public.client_members(user_id);
create index clients_parent_client_id_idx on public.clients(parent_client_id);

create table public.roles (
  id uuid primary key,
  client_id uuid not null references public.clients(id),
  title text
);

create table public.candidates (
  id uuid primary key,
  client_id uuid not null references public.clients(id),
  role_id uuid null references public.roles(id),
  status text
);

create table public.interviews (
  id uuid primary key,
  client_id uuid not null references public.clients(id),
  candidate_id uuid null references public.candidates(id),
  status text
);

create table public.reports (
  id uuid primary key,
  client_id uuid null references public.clients(id),
  candidate_id uuid null references public.candidates(id),
  status text
);

create index roles_client_id_idx on public.roles(client_id);
create index candidates_client_id_idx on public.candidates(client_id);
create index interviews_client_id_idx on public.interviews(client_id);
create index reports_client_id_idx on public.reports(client_id);

-- Match the hosted catalog: tenant tables are owned by postgres, so the
-- tightly-scoped SECURITY DEFINER helper can inspect membership without
-- recursively invoking client_members RLS.
alter table public.clients owner to postgres;
alter table public.client_members owner to postgres;
alter table public.roles owner to postgres;
alter table public.candidates owner to postgres;
alter table public.interviews owner to postgres;
alter table public.reports owner to postgres;

alter table public.clients enable row level security;
alter table public.client_members enable row level security;
alter table public.roles enable row level security;
alter table public.candidates enable row level security;
alter table public.interviews enable row level security;
alter table public.reports enable row level security;

grant usage on schema public to anon, authenticated, service_role;
grant all privileges on public.clients, public.client_members, public.roles,
  public.candidates, public.interviews, public.reports
to anon, authenticated, service_role;

create or replace function public.current_client_id()
returns uuid
language sql
security definer
set search_path = public
as $$
  select cm.client_id
  from public.client_members cm
  where cm.user_id = auth.uid()
  limit 1
$$;

create or replace function public.current_member_role()
returns text
language sql
security definer
set search_path = public
as $$
  select cm.role
  from public.client_members cm
  where cm.user_id = auth.uid()
  limit 1
$$;

create or replace function public.has_client_membership(c uuid)
returns boolean
language sql
stable
as $$
  select exists (
    select 1
    from public.client_members cm
    where cm.user_id = auth.uid()
      and cm.client_id = c
  )
$$;

create or replace function public.is_member_of(c uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.client_members cm
    where cm.user_id = auth.uid()
      and cm.client_id = c
  )
$$;

create or replace function public.is_manager_or_above()
returns boolean
language sql
stable
as $$
  select public.current_member_role() in ('admin', 'manager')
$$;

create or replace function public.is_admin()
returns boolean
language sql
stable
as $$
  select public.current_member_role() = 'admin'
$$;

grant execute on function public.current_client_id() to public, anon, authenticated, service_role;
grant execute on function public.current_member_role() to public, anon, authenticated, service_role;
grant execute on function public.has_client_membership(uuid) to public, anon, authenticated, service_role;
grant execute on function public.is_member_of(uuid) to public, anon, authenticated, service_role;
grant execute on function public.is_manager_or_above() to public, anon, authenticated, service_role;
grant execute on function public.is_admin() to public, anon, authenticated, service_role;

create policy clients_select_by_membership on public.clients
for select using (public.has_client_membership(id));

create policy client_members_select_self on public.client_members
for select using (user_id = auth.uid());

create policy cm_read_same_client on public.client_members
for select using (client_id = public.current_client_id());

create policy cm_write_admin_only on public.client_members
for all using (client_id = public.current_client_id() and public.is_admin())
with check (client_id = public.current_client_id() and public.is_admin());

-- This reproduces the live QA target policy catalog before Phase 2.
create policy "Client can read their own roles" on public.roles
for select using (client_id = '90000000-0000-0000-0000-000000000001'::uuid);
create policy "Client can insert their own roles" on public.roles
for insert with check (client_id = auth.uid());
create policy "select roles for members" on public.roles
for select using (public.is_member_of(client_id));
create policy roles_select_by_membership on public.roles
for select using (public.has_client_membership(client_id));
create policy roles_select_own on public.roles
for select using (client_id = public.current_client_id());
create policy roles_insert_by_membership on public.roles
for insert with check (public.has_client_membership(client_id));
create policy roles_update_by_membership on public.roles
for update using (public.has_client_membership(client_id))
with check (public.has_client_membership(client_id));
create policy roles_modify_own on public.roles
for all using (client_id = public.current_client_id() and public.is_manager_or_above())
with check (client_id = public.current_client_id() and public.is_manager_or_above());

create policy "Client can read their own candidates" on public.candidates
for select using (client_id = auth.uid());
create policy "Client can insert candidates for their roles" on public.candidates
for insert with check (client_id = auth.uid());
create policy candidates_select_by_membership on public.candidates
for select using (public.has_client_membership(client_id));
create policy candidates_select_own on public.candidates
for select using (client_id = public.current_client_id());
create policy candidates_insert_by_membership on public.candidates
for insert with check (public.has_client_membership(client_id));
create policy candidates_update_by_membership on public.candidates
for update using (public.has_client_membership(client_id))
with check (public.has_client_membership(client_id));
create policy candidates_modify_own on public.candidates
for all using (client_id = public.current_client_id() and public.is_manager_or_above())
with check (client_id = public.current_client_id() and public.is_manager_or_above());

create policy "Client can view their own interviews" on public.interviews
for select using (client_id = auth.uid());
create policy "Client can insert their own interviews" on public.interviews
for insert with check (client_id = auth.uid());
create policy "select interviews for members" on public.interviews
for select using (public.is_member_of(client_id));
create policy interviews_select_by_membership on public.interviews
for select using (public.has_client_membership(client_id));
create policy interviews_select_own on public.interviews
for select using (client_id = public.current_client_id());
create policy interviews_insert_by_membership on public.interviews
for insert with check (public.has_client_membership(client_id));
create policy interviews_update_by_membership on public.interviews
for update using (public.has_client_membership(client_id))
with check (public.has_client_membership(client_id));
create policy interviews_modify_own on public.interviews
for all using (client_id = public.current_client_id() and public.is_manager_or_above())
with check (client_id = public.current_client_id() and public.is_manager_or_above());

create policy "Client can view their own reports" on public.reports
for select using (client_id = auth.uid());
create policy "Client can insert reports" on public.reports
for insert with check (client_id = auth.uid());
create policy reports_select_by_membership on public.reports
for select using (public.has_client_membership(client_id));
create policy reports_select_own on public.reports
for select using (client_id = public.current_client_id());
create policy reports_insert_by_membership on public.reports
for insert with check (public.has_client_membership(client_id));
create policy reports_update_by_membership on public.reports
for update using (public.has_client_membership(client_id))
with check (public.has_client_membership(client_id));
create policy reports_modify_own on public.reports
for all using (client_id = public.current_client_id() and public.is_manager_or_above())
with check (client_id = public.current_client_id() and public.is_manager_or_above());

insert into public.clients(id, name, parent_client_id, archived_at) values
  ('10000000-0000-0000-0000-000000000001', 'Parent A', null, null),
  ('10000000-0000-0000-0000-000000000002', 'Child A1', '10000000-0000-0000-0000-000000000001', null),
  ('10000000-0000-0000-0000-000000000003', 'Child A2', '10000000-0000-0000-0000-000000000001', null),
  ('10000000-0000-0000-0000-000000000004', 'Archived child', '10000000-0000-0000-0000-000000000001', now()),
  ('20000000-0000-0000-0000-000000000001', 'Client B', null, null),
  ('90000000-0000-0000-0000-000000000001', 'Synthetic historical hard-coded client', null, null);

insert into public.client_members(client_id, user_id, role) values
  ('10000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000001', 'member'),
  ('10000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000002', 'manager'),
  ('10000000-0000-0000-0000-000000000002', '30000000-0000-0000-0000-000000000003', 'manager'),
  ('10000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000004', 'admin'),
  ('10000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000005', 'owner'),
  ('10000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000006', 'super_admin');

insert into public.roles(id, client_id, title) values
  ('40000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', 'Parent A role'),
  ('40000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000002', 'Child A1 role'),
  ('40000000-0000-0000-0000-000000000003', '10000000-0000-0000-0000-000000000003', 'Child A2 role'),
  ('40000000-0000-0000-0000-000000000004', '20000000-0000-0000-0000-000000000001', 'Client B role'),
  ('40000000-0000-0000-0000-000000000005', '90000000-0000-0000-0000-000000000001', 'Historical exposed role'),
  ('40000000-0000-0000-0000-000000000006', '10000000-0000-0000-0000-000000000004', 'Archived child role');

insert into public.candidates(id, client_id, role_id, status) values
  ('50000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', '40000000-0000-0000-0000-000000000001', 'seed'),
  ('50000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000002', '40000000-0000-0000-0000-000000000002', 'seed'),
  ('50000000-0000-0000-0000-000000000003', '10000000-0000-0000-0000-000000000003', '40000000-0000-0000-0000-000000000003', 'seed'),
  ('50000000-0000-0000-0000-000000000004', '20000000-0000-0000-0000-000000000001', '40000000-0000-0000-0000-000000000004', 'seed'),
  ('50000000-0000-0000-0000-000000000005', '10000000-0000-0000-0000-000000000004', '40000000-0000-0000-0000-000000000006', 'seed');

insert into public.interviews(id, client_id, candidate_id, status) values
  ('60000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', '50000000-0000-0000-0000-000000000001', 'seed'),
  ('60000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000002', '50000000-0000-0000-0000-000000000002', 'seed'),
  ('60000000-0000-0000-0000-000000000003', '10000000-0000-0000-0000-000000000003', '50000000-0000-0000-0000-000000000003', 'seed'),
  ('60000000-0000-0000-0000-000000000004', '20000000-0000-0000-0000-000000000001', '50000000-0000-0000-0000-000000000004', 'seed'),
  ('60000000-0000-0000-0000-000000000005', '10000000-0000-0000-0000-000000000004', '50000000-0000-0000-0000-000000000005', 'seed');

insert into public.reports(id, client_id, candidate_id, status) values
  ('70000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', '50000000-0000-0000-0000-000000000001', 'seed'),
  ('70000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000002', '50000000-0000-0000-0000-000000000002', 'seed'),
  ('70000000-0000-0000-0000-000000000003', '10000000-0000-0000-0000-000000000003', '50000000-0000-0000-0000-000000000003', 'seed'),
  ('70000000-0000-0000-0000-000000000004', '20000000-0000-0000-0000-000000000001', '50000000-0000-0000-0000-000000000004', 'seed'),
  ('70000000-0000-0000-0000-000000000005', '10000000-0000-0000-0000-000000000004', '50000000-0000-0000-0000-000000000005', 'seed');
