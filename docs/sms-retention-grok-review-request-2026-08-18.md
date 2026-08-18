# Grok Build 4.5 independent review request: SMS retention enforcement

Review only. Do not edit source, run provider operations, access secrets, or send SMS.

## Scope

Review the uncommitted alphaScreen QA changes in:

- `supabase/migrations/20260818163902_sms_retention_enforcement.sql`
- `src/lib/smsMonitoringService.js`
- `test/sms-monitoring-service.test.js`
- `test/sms-retention-enforcement-source.test.js`
- `/private/tmp/alphascreen-sms-monitoring-frontend-20260818/artifacts/alphasource-website/src/pages/admin/AdminSmsMonitoringPage.tsx`
- `/private/tmp/alphascreen-sms-monitoring-frontend-20260818/artifacts/alphasource-website/src/pages/admin/AdminSmsMonitoringPage.test.mjs`

The approved policy is:

- preserve active suppressions while active;
- released suppression history: four years after release;
- SMS consent selection evidence: four years after selection or challenge creation, whichever is later;
- signed inbound STOP/START/HELP events: four years;
- provider delivery telemetry: 13 months after the latest provider/delivery event;
- line-type cache: expire at its bounded expiry, never beyond 30 days;
- spend reservations and released provider-breaker history: 13 months;
- do not alter the accepted durable OTP verifier retention policy.

## Security contract

- `private_auth` remains unexposed and service mediated.
- The enforcement function is private and unavailable to `service_role`, `anon`, `authenticated`, and `PUBLIC`.
- A read-only aggregate snapshot is exposed only to `service_role`.
- Retention evidence stores aggregate counts only and no phone, fingerprint, candidate, message, event, challenge, or OTP identifiers.
- The named daily `pg_cron` job is installed with supported `cron.schedule`; there is no direct mutation of `cron.job`.
- Execution uses an advisory transaction lock and supports a non-mutating dry run.
- The frontend only displays schedule, completion state, and aggregate counts; it contains no mutation action.

## Validation evidence

- Focused backend retention/monitoring tests: 17 passed, 0 failed.
- Complete backend suite: 1,147 total; 1,019 passed; 0 failed; 128 skipped.
- Complete frontend suite: 242 passed, 0 failed.
- Frontend strict TypeScript: passed.
- Frontend production build, 13-route prerender, and 14-file HTML integrity: passed.
- `git diff --check`: passed.

## Required review

Challenge:

1. whether each approved retention window is encoded correctly;
2. whether active suppressions or active provider breakers can be deleted;
3. whether challenge validity, HMAC binding, or atomic consume can be altered;
4. whether provider/message uniqueness remains safe after old telemetry is cleared;
5. whether the cron job, function ownership, grants, RLS, and search paths are safe;
6. whether the dry-run and aggregate snapshot leak identifiers;
7. concurrency and idempotency;
8. migration replay and upgrade safety;
9. whether the admin readiness result can claim success without a successful run;
10. whether any required production correction remains.

Return exactly one decision followed by findings:

- `APPROVE`
- `APPROVE_WITH_REQUIRED_CORRECTIONS`
- `REJECT`
