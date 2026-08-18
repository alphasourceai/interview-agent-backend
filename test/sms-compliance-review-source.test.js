'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const review = fs.readFileSync(
  path.join(__dirname, '..', 'docs', 'sms-operational-compliance-review-2026-08-18.md'),
  'utf8',
);

test('SMS compliance review is source-backed and cannot be mistaken for legal approval', () => {
  assert.match(review, /PENDING FORMAL LEGAL\/COMPLIANCE APPROVAL/);
  assert.match(review, /not legal advice/i);
  assert.match(review, /LEGAL_REVIEW_REQUIRED/g);
  for (const source of ['developers.telnyx.com', 'support.telnyx.com', 'docs.fcc.gov', 'ctia.org']) {
    assert.match(review, new RegExp(source.replaceAll('.', '\\.')));
  }
});

test('review preserves the privacy and provider-neutral authentication boundaries', () => {
  assert.match(review, /Telnyx is transport only/);
  assert.match(review, /raw phone numbers, OTPs, destination fingerprints, provider message IDs, candidate identities, or credential values/);
  assert.match(review, /Email remains the default and alternative/);
  assert.match(review, /AI Customer Support number/);
});
