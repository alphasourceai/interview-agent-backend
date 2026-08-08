# Phase 2 production RLS cleanup

## Source and scope

- Production repository: `alphasourceai/interview-agent-backend`
- Production branch and reviewed head: `prod-backend-legacy` at `94058ac3069b6d1234ebe5695d47a6fa9e531b41`
- QA source: commit `0cd445a8e0f3ed4f31865ec6847e46cf620c0ee5`
- QA migration: `20260808003825_manager_member_rls_policy_cleanup.sql`
- Production migration: `20260808213805_manager_member_rls_policy_cleanup_prod.sql`
- Scope: Findings #3 and #4 only. No frontend, Tavus retry/timeout, payload-validation, service-role-centralization, or interview-ending work.

## Production reconstruction result

The production application authorization sources match the QA-reviewed sources.
The live production target catalog reproduces the same pre-cleanup policy names,
policy expressions, permissive overlap, grants, ownership, RLS posture, helper
lineage, and relevant client-scope indexes as the accepted QA pre-cleanup catalog.
The production migration therefore preserves the QA-approved helper and policy
semantics while receiving a new production migration identity.

## Sanitized pre-migration baseline

- Target tables and `client_members`: RLS enabled, force-RLS disabled, owner `postgres`.
- Target/client-members ACLs: `postgres`, `anon`, `authenticated`, and `service_role` each held all table privileges; `PUBLIC` held none.
- Product counts: clients 2, roles 4, candidates 44, interviews 45, reports 38, client members 2, candidate submissions 49, OTP rows 65, lifecycle events 836.
- Active state: zero active interviews, zero recent interviews, zero active target-write queries, zero migration sessions, and zero prepared transactions.
- Phase 1 containment: all 15 protected tables present with RLS enabled, zero client grants, zero policies; plaintext OTP view absent; restricted view, sequence, and rate-limit RPC remained client-inaccessible.
- `private.client_scope_allows(uuid, boolean)` was absent. The `private` schema had no `authenticated`, `anon`, `PUBLIC`, or `service_role` usage.
- Latest production migration before this promotion: `20260803165419_public_api_emergency_containment_prod`.

## Cutover gates

1. Re-fetch `prod-backend-legacy` and require the reviewed head.
2. Enable the established backend maintenance/write-freeze control.
3. Recheck zero active database interviews, Tavus conversations, target writes, report work, membership writes, migration sessions, and prepared transactions.
4. Apply only the reviewed Phase 2 production migration.
5. Before unfreezing, verify exact policies, grants, helper ACL, unchanged `client_members` policies, unchanged counts, containment, automatic-exposure setting, and health.
6. Run the rollback-only hosted authorization matrix and production read-only application smoke.
7. Unfreeze only after every gate passes; then run one final read-only health check.

## Rollback

The reviewed rollback is `docs/rollback/manager-member-rls-policy-cleanup-prod.sql`.
It restores the snapshotted legacy policies and table ACLs, removes the Phase 2
helper and its new schema grant, and changes no data. The forward migration adds
no index, so no index removal is required. The rollback may run only while
writes remain frozen and only after a security review determines that restoring
the pre-migration catalog is the safer containment action. A failed forward
migration must not be patched manually.
