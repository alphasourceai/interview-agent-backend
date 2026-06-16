# Candidate Automation Digest Cron QA Checklist

This checklist prepares the QA environment for a Render Cron Job that invokes the configured pending-approval digest runner in dry-run mode only.

Do not enable real sending from cron in this phase. The QA cron request must keep `"dry_run": true` and `"send": false` until a later phase explicitly enables scheduled sends.

## Render Cron Job

Recommended name:

```text
alphascreen-qa-candidate-automation-digest-dry-run
```

Request:

```text
Method: POST
URL: https://ia-backend-qa.onrender.com/api/automation/actions/run-configured-pending-approval-digests
```

Headers:

```text
Content-Type: application/json
x-cron-secret: <AUTOMATION_DIGEST_RUNNER_SECRET>
```

Body:

```json
{
  "dry_run": true,
  "send": false,
  "limit_per_digest": 25
}
```

Recommended cadence:

- Hourly during QA.
- Once daily after QA confidence is established.

Do not set `"send": true` or `"dry_run": false` in the Cron Job until a later phase.

## Supported Digest Cadence

Pending approval digest rules support a constrained cadence model in `digest_config.pending_approval_digest`:

- `daily`: due every local date at or after `send_time_local`.
- `weekdays`: due Monday-Friday in the configured timezone at or after `send_time_local`.
- `weekly`: due only on the configured `weekly_day` in the configured timezone at or after `send_time_local`.

If `frequency` is omitted, the backend defaults to `daily` for backward compatibility. Weekly rules must include `weekly_day` as one of `monday`, `tuesday`, `wednesday`, `thursday`, `friday`, `saturday`, or `sunday`.

The QA Cron Job can continue running hourly in dry-run mode. The backend determines whether each configured digest is due based on the rule cadence.

## Scheduled Send Guardrail

Scheduler-secret send mode requires both:

- `AUTOMATION_DIGEST_RUNNER_SECRET`
- `AUTOMATION_DIGEST_SCHEDULER_SEND_ENABLED=true`

QA dry-run cron does not require `AUTOMATION_DIGEST_SCHEDULER_SEND_ENABLED`. Keep the QA Cron Job body in dry-run mode until scheduled sends are explicitly approved:

```json
{
  "dry_run": true,
  "send": false,
  "limit_per_digest": 25
}
```

If the scheduler secret is valid but scheduled send mode is not enabled, a request with `"send": true` and `"dry_run": false` should return:

```json
{
  "code": "automation_digest_scheduler_send_disabled",
  "detail": "Scheduled digest sending is disabled."
}
```

Production must not enable `AUTOMATION_DIGEST_SCHEDULER_SEND_ENABLED` until the production promotion phase.

## Local Smoke Script

The helper script uses the same dry-run body and never enables sending:

```bash
QA_API_BASE=https://ia-backend-qa.onrender.com \
AUTOMATION_DIGEST_RUNNER_SECRET=<redacted> \
bash scripts/smoke-automation-digest-runner-dry-run.sh
```

The script fails before making a request if `AUTOMATION_DIGEST_RUNNER_SECRET` is missing. It prints the JSON response, but it never prints the secret value.

## QA Validation Checklist

1. Wrong secret returns `401`.
2. Readiness check passes and reports scheduler send disabled until the explicit QA send test phase:

   ```json
   {
     "readiness_check": true,
     "scheduler_send_enabled": false
   }
   ```

3. Dry-run cron invocation returns zero side effects:

   ```json
   {
     "side_effects": {
       "actions_created": 0,
       "emails_sent": 0,
       "digests_sent": 0
     }
   }
   ```

4. No `automation_digest_deliveries` row is created by dry-run.
5. No approval tokens are created by dry-run.
6. No automation action events are created by dry-run.
7. Digest grouping remains one email preview per recipient, aggregating pending actions across relevant roles/rules.
8. Scheduler-secret send mode returns `automation_digest_scheduler_send_disabled` while `AUTOMATION_DIGEST_SCHEDULER_SEND_ENABLED` is absent or disabled.

## Safety Notes

- Dry-run may read configured rules and pending approval action summaries so QA can confirm what would be sent.
- Dry-run must not send email, create approval tokens, write action events, or write delivery ledger rows.
- The Phase 4F delivery ledger remains the idempotency source for future send-mode scheduler work.
