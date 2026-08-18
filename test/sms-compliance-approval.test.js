'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const packet = fs.readFileSync(
  path.join(__dirname, '..', 'docs', 'sms-compliance-owner-approval-packet-2026-08-18.md'),
  'utf8',
);

test('owner approval record pins the reviewed runtime and consent versions', () => {
  assert.match(packet, /Status: \*\*APPROVED FOR QA IMPLEMENTATION\*\*/);
  assert.match(packet, /Decision: `APPROVED`/);
  assert.match(packet, /Approved version: `sms-operational-review-2026-08-18` with candidate disclosure `sms-consent-v2`/);
  assert.match(packet, /SMS_COMPLIANCE_REVIEW_STATUS=approved/);
  assert.match(packet, /SMS_CONSENT_COPY_VERSION=sms-consent-v2/);
  assert.doesNotMatch(packet, /Decision: `PENDING`/);
});

test('approved policy remains provider-neutral and preserves the support number boundary', () => {
  assert.match(packet, /contracted messaging provider/);
  assert.match(packet, /AI Customer Support number remains unchanged/);
  assert.match(packet, /active suppression until it is validly released/);
});
