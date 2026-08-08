# Manager/member RLS access matrix

This document defines direct Data API authorization for `public.interviews`,
`public.roles`, `public.candidates`, and `public.reports`. The four tables use
the same matrix. Application routes may impose additional restrictions.

## Direct Data API matrix

| Actor | Scope | SELECT | INSERT | UPDATE | DELETE |
| --- | --- | --- | --- | --- | --- |
| anon | any client | DENY | DENY | DENY | DENY |
| authenticated, no membership | any client | DENY | DENY | DENY | DENY |
| member | directly assigned client | ALLOW | DENY | DENY | DENY |
| member | child, sibling, or other client | DENY | DENY | DENY | DENY |
| manager | directly assigned client | ALLOW | ALLOW | ALLOW | ALLOW |
| manager on a parent | active direct child of that parent | ALLOW | ALLOW | ALLOW | ALLOW |
| manager on a child only | parent or sibling | DENY | DENY | DENY | DENY |
| client admin, owner, or super_admin membership | directly assigned client or active direct child of an assigned parent | ALLOW | ALLOW | ALLOW | ALLOW |
| global administrator from `public.admins` | application-selected client | BACKEND_ONLY | BACKEND_ONLY | BACKEND_ONLY | BACKEND_ONLY |
| service-role backend | any client | ALLOW | ALLOW | ALLOW | ALLOW |

Parent expansion is one level and applies only when the target client is an
active direct child. An ordinary parent member does not inherit a child. A
child membership never expands upward or sideways. All different-client access
outside these rules is denied.

## Evidence and implementation

- `src/lib/clientScope.js` defines manager, admin, owner, and super_admin as
  management and child-expansion roles. It gives a member only the directly
  assigned client.
- `src/middleware/auth.js` builds the same effective parent/child scope. It
  recognizes global administrators from `public.admins` and serves them through
  backend service-role queries rather than direct Data API policies.
- `routes/roles.js` allows scoped reads for any membership and limits writes to
  manager, admin, owner, and super_admin.
- `test/client-scope.test.js` proves parent-manager expansion, member limits,
  and child-manager parent/sibling denial.
- `test/role-jd-replacement.test.js` proves a read-only member is rejected from
  a write path.
- `test/rls-policy-cleanup-disposable-db.test.js` exercises the matrix under
  representative JWT claim contexts against PostgreSQL RLS.

## SQL privilege and RLS layers

`authenticated` receives only `SELECT`, `INSERT`, `UPDATE`, and `DELETE` table
privileges. RLS then decides whether a row operation is allowed. It does not
receive `TRUNCATE`, `REFERENCES`, `TRIGGER`, or `MAINTAIN`.

`anon` and `PUBLIC` receive no target-table privileges. `service_role` retains
the four DML privileges and bypasses RLS for backend workflows.

Each target table has exactly one authenticated policy per operation:

- `*_select_scoped_authenticated`
- `*_insert_manager_scoped`
- `*_update_manager_scoped`
- `*_delete_manager_scoped`

The policies call `private.client_scope_allows(client_id, require_manager)`.
The helper is `STABLE SECURITY DEFINER`, owned by `postgres`, uses a locked
`pg_catalog` search path, and reads only `clients` and `client_members`. EXECUTE
is revoked from `PUBLIC`, `anon`, and `service_role`, and granted only to
`authenticated`. The table owners and helper owner must remain `postgres` so
the membership lookup does not recurse through `client_members` RLS.

## Removed legacy model

Policies comparing `auth.uid()` directly with `client_id`, the historical
hard-coded role client policy, duplicate membership selects, and broader
membership insert/update policies are obsolete. They are not part of the
current membership model and must not be recreated. In PostgreSQL, permissive
policies for the same command are ORed, so a broad member-write policy would
defeat a manager-only policy.

This migration does not change `client_members` policy semantics, global-admin
backend authorization, automatic exposure settings, default privileges,
`supabase_admin`, authentication, Tavus, billing, interview behavior, or
unrelated application behavior.
