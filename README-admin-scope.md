# Admin scope + client membership behavior (backend)

## Decision
**Option A:** Admins are **global-only**. Client members can be: **manager**, **member**, or **tester**.

That means:
- Being in the `admins` table (and `is_active = true`) makes you a global admin.
- Global admins should NOT need to exist in `client_members` at all.
- `client_members.role` should never be `admin`.

## What we changed
### 1) Admin identity is derived from the `admins` table
- `requireAuth` hydrates `req.isGlobalAdmin` (and `req.isAdmin`) based on `admins` table membership.
- This prevents “admin-but-also-member” edge cases from contaminating role logic.

### 2) Admin scope is synthetic and global
- `withClientScope` gives global admins access to **all clients** (or a single explicit `client_id` if provided).
- The admin "memberships" returned by `withClientScope` are synthesized; they are not sourced from `client_members`.

### 3) User scope is real memberships
- Non-admin users are scoped by `client_members` rows only.

## Why this mattered
Symptoms we saw:
- JD links returning 404 for admin on some clients.
- Members endpoint returning 403 for admin on some clients.
- Admin UI behavior inconsistent across clients.

Root cause:
- Admin email was also present in `client_members`, which muddied scope logic.
- Admin detection varied between endpoints (some used token-derived fields, some checked membership rows).

Fix:
- Make admin a single source of truth (`admins` table).
- Make admin scope global, consistently.

## Quick verification (curl)
### Get an ADMIN token
Use your existing helper:
- `/tmp/get_admin_token.sh` (creates `ADMIN_TOKEN`)

### Verify admin can list members for any client
```bash
curl -s -H "Authorization: Bearer $ADMIN_TOKEN" \
"https://ia-backend-prod.onrender.com/client-members?client_id=<CLIENT_ID>" | head -c 400; echo
