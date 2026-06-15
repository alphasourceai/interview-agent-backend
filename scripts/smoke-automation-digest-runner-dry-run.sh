#!/usr/bin/env bash
set -euo pipefail

QA_API_BASE="${QA_API_BASE:-https://ia-backend-qa.onrender.com}"
RUNNER_SECRET="${AUTOMATION_DIGEST_RUNNER_SECRET:-}"

if [[ -z "${RUNNER_SECRET}" ]]; then
  echo "AUTOMATION_DIGEST_RUNNER_SECRET is required." >&2
  exit 1
fi

curl --silent --show-error --fail-with-body --config - <<CURL_CONFIG
request = "POST"
url = "${QA_API_BASE%/}/api/automation/actions/run-configured-pending-approval-digests"
header = "Content-Type: application/json"
header = "x-cron-secret: ${RUNNER_SECRET}"
data = "{\"dry_run\":true,\"send\":false,\"limit_per_digest\":25}"
CURL_CONFIG
