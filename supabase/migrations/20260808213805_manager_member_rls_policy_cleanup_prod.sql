begin;

-- Phase 2 manager/member RLS cleanup production promotion.
-- Reconstructed against the exact production catalog on 2026-08-08 from the
-- QA-accepted authorization model; authorization semantics are unchanged.
--
-- Idempotency assumption: Supabase applies each migration version once. The
-- DROP IF EXISTS statements also make this file safe to replay in disposable
-- validation databases. No table data is rewritten.

create or replace function private.client_scope_allows(
  p_client_id uuid,
  p_require_manager boolean default false
)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog
as $$
  with principal as (
    select coalesce(
      nullif(current_setting('request.jwt.claim.sub', true), '')::uuid,
      (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')::uuid
    ) as user_id
  )
  select
    principal.user_id is not null
    and exists (
      select 1
      from public.client_members cm
      left join public.clients target_client
        on target_client.id = p_client_id
      where cm.user_id = principal.user_id
        and (
          (
            cm.client_id = p_client_id
            and (
              not p_require_manager
              or lower(trim(cm.role)) in ('manager', 'admin', 'owner', 'super_admin')
            )
          )
          or (
            target_client.parent_client_id = cm.client_id
            and target_client.archived_at is null
            and lower(trim(cm.role)) in ('manager', 'admin', 'owner', 'super_admin')
          )
        )
    )
  from principal
$$;

alter function private.client_scope_allows(uuid, boolean) owner to postgres;
revoke all privileges on function private.client_scope_allows(uuid, boolean)
from public, anon, authenticated, service_role;
grant usage on schema private to authenticated;
grant execute on function private.client_scope_allows(uuid, boolean)
to authenticated;

-- RLS does not govern TRUNCATE, REFERENCES, TRIGGER, or MAINTAIN. Replace the
-- historical all-privilege grants with only the DML privileges the policy
-- layer is designed to authorize.
revoke all privileges on table
  public.interviews,
  public.roles,
  public.candidates,
  public.reports,
  public.client_members
from public, anon, authenticated;

grant select, insert, update, delete on table
  public.interviews,
  public.roles,
  public.candidates,
  public.reports,
  public.client_members
to authenticated;

grant select, insert, update, delete on table
  public.interviews,
  public.roles,
  public.candidates,
  public.reports,
  public.client_members
to service_role;

-- roles: remove legacy client-identity policies and overlapping member-write
-- policies, then declare one policy for each command.
drop policy if exists "Client can read their own roles" on public.roles;
drop policy if exists "Client can insert their own roles" on public.roles;
drop policy if exists "select roles for members" on public.roles;
drop policy if exists roles_select_by_membership on public.roles;
drop policy if exists roles_select_own on public.roles;
drop policy if exists roles_insert_by_membership on public.roles;
drop policy if exists roles_update_by_membership on public.roles;
drop policy if exists roles_modify_own on public.roles;
drop policy if exists roles_select_scoped_authenticated on public.roles;
drop policy if exists roles_insert_manager_scoped on public.roles;
drop policy if exists roles_update_manager_scoped on public.roles;
drop policy if exists roles_delete_manager_scoped on public.roles;

create policy roles_select_scoped_authenticated
on public.roles for select to authenticated
using (private.client_scope_allows(client_id, false));

create policy roles_insert_manager_scoped
on public.roles for insert to authenticated
with check (private.client_scope_allows(client_id, true));

create policy roles_update_manager_scoped
on public.roles for update to authenticated
using (private.client_scope_allows(client_id, true))
with check (private.client_scope_allows(client_id, true));

create policy roles_delete_manager_scoped
on public.roles for delete to authenticated
using (private.client_scope_allows(client_id, true));

-- candidates.
drop policy if exists "Client can read their own candidates" on public.candidates;
drop policy if exists "Client can insert candidates for their roles" on public.candidates;
drop policy if exists candidates_select_by_membership on public.candidates;
drop policy if exists candidates_select_own on public.candidates;
drop policy if exists candidates_insert_by_membership on public.candidates;
drop policy if exists candidates_update_by_membership on public.candidates;
drop policy if exists candidates_modify_own on public.candidates;
drop policy if exists candidates_select_scoped_authenticated on public.candidates;
drop policy if exists candidates_insert_manager_scoped on public.candidates;
drop policy if exists candidates_update_manager_scoped on public.candidates;
drop policy if exists candidates_delete_manager_scoped on public.candidates;

create policy candidates_select_scoped_authenticated
on public.candidates for select to authenticated
using (private.client_scope_allows(client_id, false));

create policy candidates_insert_manager_scoped
on public.candidates for insert to authenticated
with check (private.client_scope_allows(client_id, true));

create policy candidates_update_manager_scoped
on public.candidates for update to authenticated
using (private.client_scope_allows(client_id, true))
with check (private.client_scope_allows(client_id, true));

create policy candidates_delete_manager_scoped
on public.candidates for delete to authenticated
using (private.client_scope_allows(client_id, true));

-- interviews.
drop policy if exists "Client can view their own interviews" on public.interviews;
drop policy if exists "Client can insert their own interviews" on public.interviews;
drop policy if exists "select interviews for members" on public.interviews;
drop policy if exists interviews_select_by_membership on public.interviews;
drop policy if exists interviews_select_own on public.interviews;
drop policy if exists interviews_insert_by_membership on public.interviews;
drop policy if exists interviews_update_by_membership on public.interviews;
drop policy if exists interviews_modify_own on public.interviews;
drop policy if exists interviews_select_scoped_authenticated on public.interviews;
drop policy if exists interviews_insert_manager_scoped on public.interviews;
drop policy if exists interviews_update_manager_scoped on public.interviews;
drop policy if exists interviews_delete_manager_scoped on public.interviews;

create policy interviews_select_scoped_authenticated
on public.interviews for select to authenticated
using (private.client_scope_allows(client_id, false));

create policy interviews_insert_manager_scoped
on public.interviews for insert to authenticated
with check (private.client_scope_allows(client_id, true));

create policy interviews_update_manager_scoped
on public.interviews for update to authenticated
using (private.client_scope_allows(client_id, true))
with check (private.client_scope_allows(client_id, true));

create policy interviews_delete_manager_scoped
on public.interviews for delete to authenticated
using (private.client_scope_allows(client_id, true));

-- reports.
drop policy if exists "Client can view their own reports" on public.reports;
drop policy if exists "Client can insert reports" on public.reports;
drop policy if exists reports_select_by_membership on public.reports;
drop policy if exists reports_select_own on public.reports;
drop policy if exists reports_insert_by_membership on public.reports;
drop policy if exists reports_update_by_membership on public.reports;
drop policy if exists reports_modify_own on public.reports;
drop policy if exists reports_select_scoped_authenticated on public.reports;
drop policy if exists reports_insert_manager_scoped on public.reports;
drop policy if exists reports_update_manager_scoped on public.reports;
drop policy if exists reports_delete_manager_scoped on public.reports;

create policy reports_select_scoped_authenticated
on public.reports for select to authenticated
using (private.client_scope_allows(client_id, false));

create policy reports_insert_manager_scoped
on public.reports for insert to authenticated
with check (private.client_scope_allows(client_id, true));

create policy reports_update_manager_scoped
on public.reports for update to authenticated
using (private.client_scope_allows(client_id, true))
with check (private.client_scope_allows(client_id, true));

create policy reports_delete_manager_scoped
on public.reports for delete to authenticated
using (private.client_scope_allows(client_id, true));

commit;
