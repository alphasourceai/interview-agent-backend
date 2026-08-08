-- REVIEWED ROLLBACK ONLY. Do not run as a service-restoration shortcut.
-- Preconditions: production writes remain frozen; the Phase 2 migration is the
-- only catalog change after this snapshot; security review has explicitly
-- determined that restoring the pre-migration policy catalog is safer.
-- This restores the exact 2026-08-08 pre-migration target policies, grants,
-- private-schema usage, and helper absence. The Phase 2 migration adds no index.

begin;

drop policy if exists roles_select_scoped_authenticated on public.roles;
drop policy if exists roles_insert_manager_scoped on public.roles;
drop policy if exists roles_update_manager_scoped on public.roles;
drop policy if exists roles_delete_manager_scoped on public.roles;

drop policy if exists candidates_select_scoped_authenticated on public.candidates;
drop policy if exists candidates_insert_manager_scoped on public.candidates;
drop policy if exists candidates_update_manager_scoped on public.candidates;
drop policy if exists candidates_delete_manager_scoped on public.candidates;

drop policy if exists interviews_select_scoped_authenticated on public.interviews;
drop policy if exists interviews_insert_manager_scoped on public.interviews;
drop policy if exists interviews_update_manager_scoped on public.interviews;
drop policy if exists interviews_delete_manager_scoped on public.interviews;

drop policy if exists reports_select_scoped_authenticated on public.reports;
drop policy if exists reports_insert_manager_scoped on public.reports;
drop policy if exists reports_update_manager_scoped on public.reports;
drop policy if exists reports_delete_manager_scoped on public.reports;

drop function if exists private.client_scope_allows(uuid, boolean);
revoke usage on schema private from authenticated;

revoke all privileges on table
  public.interviews,
  public.roles,
  public.candidates,
  public.reports,
  public.client_members
from public, anon, authenticated, service_role;

grant all privileges on table
  public.interviews,
  public.roles,
  public.candidates,
  public.reports,
  public.client_members
to postgres, anon, authenticated, service_role;

create policy "Client can read their own roles" on public.roles
for select using (client_id = '230f8351-f284-450e-b1d8-adeef448b70a'::uuid);
create policy "Client can insert their own roles" on public.roles
for insert with check (client_id = auth.uid());
create policy "select roles for members" on public.roles
for select using (is_member_of(client_id));
create policy roles_select_by_membership on public.roles
for select using (has_client_membership(client_id));
create policy roles_select_own on public.roles
for select using (client_id = current_client_id());
create policy roles_insert_by_membership on public.roles
for insert with check (has_client_membership(client_id));
create policy roles_update_by_membership on public.roles
for update using (has_client_membership(client_id))
with check (has_client_membership(client_id));
create policy roles_modify_own on public.roles
for all using (client_id = current_client_id() and is_manager_or_above())
with check (client_id = current_client_id() and is_manager_or_above());

create policy "Client can read their own candidates" on public.candidates
for select using (client_id = auth.uid());
create policy "Client can insert candidates for their roles" on public.candidates
for insert with check (client_id = auth.uid());
create policy candidates_select_by_membership on public.candidates
for select using (has_client_membership(client_id));
create policy candidates_select_own on public.candidates
for select using (client_id = current_client_id());
create policy candidates_insert_by_membership on public.candidates
for insert with check (has_client_membership(client_id));
create policy candidates_update_by_membership on public.candidates
for update using (has_client_membership(client_id))
with check (has_client_membership(client_id));
create policy candidates_modify_own on public.candidates
for all using (client_id = current_client_id() and is_manager_or_above())
with check (client_id = current_client_id() and is_manager_or_above());

create policy "Client can view their own interviews" on public.interviews
for select using (client_id = auth.uid());
create policy "Client can insert their own interviews" on public.interviews
for insert with check (client_id = auth.uid());
create policy "select interviews for members" on public.interviews
for select using (is_member_of(client_id));
create policy interviews_select_by_membership on public.interviews
for select using (has_client_membership(client_id));
create policy interviews_select_own on public.interviews
for select using (client_id = current_client_id());
create policy interviews_insert_by_membership on public.interviews
for insert with check (has_client_membership(client_id));
create policy interviews_update_by_membership on public.interviews
for update using (has_client_membership(client_id))
with check (has_client_membership(client_id));
create policy interviews_modify_own on public.interviews
for all using (client_id = current_client_id() and is_manager_or_above())
with check (client_id = current_client_id() and is_manager_or_above());

create policy "Client can view their own reports" on public.reports
for select using (client_id = auth.uid());
create policy "Client can insert reports" on public.reports
for insert with check (client_id = auth.uid());
create policy reports_select_by_membership on public.reports
for select using (has_client_membership(client_id));
create policy reports_select_own on public.reports
for select using (client_id = current_client_id());
create policy reports_insert_by_membership on public.reports
for insert with check (has_client_membership(client_id));
create policy reports_update_by_membership on public.reports
for update using (has_client_membership(client_id))
with check (has_client_membership(client_id));
create policy reports_modify_own on public.reports
for all using (client_id = current_client_id() and is_manager_or_above())
with check (client_id = current_client_id() and is_manager_or_above());

commit;
