-- RLS + helper function (transaction wrapped)
begin;
create or replace function public.has_client_membership(c uuid)
returns boolean language sql stable as $$
  select exists (
    select 1 from public.client_members cm
    where cm.user_id = auth.uid() and cm.client_id = c
  );
$$;
alter table public.clients          enable row level security;
alter table public.client_members   enable row level security;
alter table public.client_invites   enable row level security;
alter table public.roles            enable row level security;
alter table public.candidates       enable row level security;
alter table public.interviews       enable row level security;
alter table public.reports          enable row level security;

drop policy if exists clients_select_by_membership on public.clients;
create policy clients_select_by_membership on public.clients
for select using ( has_client_membership(id) );

drop policy if exists client_members_select_self on public.client_members;
create policy client_members_select_self on public.client_members
for select using ( user_id = auth.uid() );

drop policy if exists roles_select_by_membership on public.roles;
create policy roles_select_by_membership on public.roles
for select using ( has_client_membership(client_id) );

drop policy if exists roles_insert_by_membership on public.roles;
create policy roles_insert_by_membership on public.roles
for insert with check ( has_client_membership(client_id) );

drop policy if exists roles_update_by_membership on public.roles;
create policy roles_update_by_membership on public.roles
for update using ( has_client_membership(client_id) )
with check ( has_client_membership(client_id) );

drop policy if exists candidates_select_by_membership on public.candidates;
create policy candidates_select_by_membership on public.candidates
for select using ( has_client_membership(client_id) );

drop policy if exists candidates_insert_by_membership on public.candidates;
create policy candidates_insert_by_membership on public.candidates
for insert with check ( has_client_membership(client_id) );

drop policy if exists candidates_update_by_membership on public.candidates;
create policy candidates_update_by_membership on public.candidates
for update using ( has_client_membership(client_id) )
with check ( has_client_membership(client_id) );

drop policy if exists interviews_select_by_membership on public.interviews;
create policy interviews_select_by_membership on public.interviews
for select using ( has_client_membership(client_id) );

drop policy if exists interviews_insert_by_membership on public.interviews;
create policy interviews_insert_by_membership on public.interviews
for insert with check ( has_client_membership(client_id) );

drop policy if exists interviews_update_by_membership on public.interviews;
create policy interviews_update_by_membership on public.interviews
for update using ( has_client_membership(client_id) )
with check ( has_client_membership(client_id) );

drop policy if exists reports_select_by_membership on public.reports;
create policy reports_select_by_membership on public.reports
for select using ( has_client_membership(client_id) );

drop policy if exists reports_insert_by_membership on public.reports;
create policy reports_insert_by_membership on public.reports
for insert with check ( has_client_membership(client_id) );

drop policy if exists reports_update_by_membership on public.reports;
create policy reports_update_by_membership on public.reports
for update using ( has_client_membership(client_id) )
with check ( has_client_membership(client_id) );
commit;
