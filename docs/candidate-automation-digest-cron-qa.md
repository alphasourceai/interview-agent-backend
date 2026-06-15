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
2. Readiness check passes:

   ```json
   {
     "readiness_check": true
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

## Safety Notes

- Dry-run may read configured rules and pending approval action summaries so QA can confirm what would be sent.
- Dry-run must not send email, create approval tokens, write action events, or write delivery ledger rows.
- The Phase 4F delivery ledger remains the idempotency source for future send-mode scheduler work.
