'use strict';

// What an Enterprise agreement prints (Step E5). Every Enterprise agreement shows
// its commercial terms, whether or not "show package terms" is set; a line is
// left out only when its setting does not apply to the billing model. Essentials
// and Pro agreements render exactly as before.

const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  USAGE_BILLING_SCHEDULE,
  buildEnterpriseCommercialTerms,
  buildMembershipAgreementHtml,
  normalizeMembershipAgreementInput
} = require('../src/render/membershipAgreement');

const BASE = Object.freeze({
  client_legal_name: 'Enterprise Co',
  primary_admin_name: 'Owner',
  admin_email: 'owner@enterprise.example',
  initial_term_start: '2026-11-01',
  initial_renewal_date: '2027-11-01',
  billing_option: 'monthly'
});

const ENTERPRISE = Object.freeze({
  ...BASE,
  membership_tier: 'enterprise',
  platform_fee: '1200',
  per_role_fee: '0',
  included_interviews_per_role: '0',
  additional_interview_fee: '30',
  usage_interview_fee_cents: '2500'
});

const termsFor = (input) => buildEnterpriseCommercialTerms(normalizeMembershipAgreementInput(input));
const labels = (terms) => terms.rows.map((row) => row.label);

test('usage with a pool: every usage line, the pool, and no rollover or top-up line', () => {
  const terms = termsFor({ ...ENTERPRISE, pool_quantity: '30', pool_discount_pct: '5', pool_total_cents: '71250' });

  assert.deepEqual(labels(terms), [
    'Platform Fee', 'Billing Interval', 'Per-Role Fee', 'Included Interviews (Per Role)', 'Billing Model',
    'Per-Interview Usage Price', 'Interview Pool', 'Pool Discount', 'Pool Total', 'Interview Length', 'Scored Questions'
  ]);
  assert.equal(terms.rows.find((row) => row.label === 'Platform Fee').value, '$1,200.00 per month');
  assert.equal(terms.rows.find((row) => row.label === 'Included Interviews (Per Role)').value, '0', 'zero is shown, not a dash');
  assert.equal(terms.rows.find((row) => row.label === 'Per-Role Fee').value, '$0.00', 'a zero fee is a term, not a dash');
  assert.equal(terms.rows.find((row) => row.label === 'Per-Interview Usage Price').value, '$25.00 per interview');
  assert.equal(terms.rows.find((row) => row.label === 'Pool Total').value, '$712.50, charged at signup');
  assert.equal(terms.usage_billing_schedule, USAGE_BILLING_SCHEDULE);
});

test('usage without a pool leaves out only the pool lines', () => {
  const terms = termsFor(ENTERPRISE);

  assert.equal(terms.pool, null);
  assert.ok(!labels(terms).some((label) => label.startsWith('Pool') || label === 'Interview Pool'));
  assert.ok(labels(terms).includes('Per-Interview Usage Price'));
});

test('rollover: rollover days (90 when not stated), the top-up price, and no usage line', () => {
  const stated = termsFor({ ...ENTERPRISE, billing_model: 'rollover', rollover_days: '120' });
  assert.equal(stated.rows.find((row) => row.label === 'Rollover Credit').value, '120 days');
  assert.ok(labels(stated).includes('Additional Interview Fee'));
  assert.ok(!labels(stated).includes('Per-Interview Usage Price'));
  assert.equal(stated.usage_billing_schedule, null, 'no usage is billed on rollover');

  const defaulted = termsFor({ ...ENTERPRISE, billing_model: 'rollover' });
  assert.equal(defaulted.rollover_days, 90);
});

test('fixed: no rollover and no usage line', () => {
  const terms = termsFor({ ...ENTERPRISE, billing_model: 'fixed' });

  assert.ok(!labels(terms).includes('Rollover Credit'));
  assert.ok(!labels(terms).includes('Per-Interview Usage Price'));
  assert.equal(terms.rows.find((row) => row.label === 'Billing Model').value, 'Fixed');
});

test('length and questions show the agreement\'s values, else the plan defaults', () => {
  const stated = termsFor({ ...ENTERPRISE, max_interview_minutes: '30', scored_question_count: '4' });
  assert.equal(stated.rows.find((row) => row.label === 'Interview Length').value, '30 minutes');
  assert.equal(stated.rows.find((row) => row.label === 'Scored Questions').value, '4 per interview');

  const defaulted = termsFor(ENTERPRISE);
  assert.equal(defaulted.max_interview_minutes, 15);
  assert.equal(defaulted.scored_question_count, 7);
});

test('an admin-sent Enterprise agreement shows its terms without the package flag, in place of the package table', () => {
  const { html, commercial_terms: terms } = buildMembershipAgreementHtml({ ...ENTERPRISE, pool_quantity: '30', pool_discount_pct: '5', pool_total_cents: '71250' });

  for (const row of terms.rows) {
    assert.ok(html.includes(row.label), row.label);
    assert.ok(html.includes(row.value), `${row.label}: ${row.value}`);
  }
  assert.ok(html.includes(USAGE_BILLING_SCHEDULE));
  assert.ok(!html.includes('Interview Duration Cap'), 'the generic package table is not shown as well');

  const flagged = buildMembershipAgreementHtml(ENTERPRISE, { showPackageTerms: true }).html;
  assert.ok(!flagged.includes('Interview Duration Cap'), 'not even when the flag is set');
});

test('docs/billing-models.md states the per-client Enterprise settings and their limits', () => {
  const doc = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'docs', 'billing-models.md'), 'utf8');
  const { INTERVIEW_MINUTES_MAX, INTERVIEW_MINUTES_MIN, SCORED_QUESTIONS_MAX } = require('../src/services/enterpriseSettings');

  assert.match(doc, /\| `billing_model` \| `fixed`, `rollover` or `usage` \|/);
  assert.match(doc, /\| `rollover_days` \| whole number, 1 to 365 \|/);
  assert.match(doc, new RegExp(`\\| \`max_interview_minutes\` \\| whole number, ${INTERVIEW_MINUTES_MIN} to ${INTERVIEW_MINUTES_MAX} \\|`));
  assert.match(doc, new RegExp(`\\| \`scored_question_count\` \\| whole number, 1 to ${SCORED_QUESTIONS_MAX} \\|`));
  assert.match(doc, /The usage model needs a usage price above zero/);
  assert.match(doc, /`max_interview_minutes` is never empty/);
  assert.match(doc, /A role keeps the length and question count it was created with/);
  assert.match(doc, /20261011120000_billing_model_follow_plan_tier\.sql/);
  assert.match(doc, /20261011130000_client_plan_settings_interview_settings\.sql/);
  assert.match(doc, /usage is billed monthly on the 1st for the previous month/);
  assert.doesNotMatch(doc, /there is no setting for it/, 'rollover days can now be set');
});

test('Essentials and Pro are unchanged: no Enterprise lines, and the package table only with the flag', () => {
  for (const tier of ['basic', 'pro']) {
    const input = { ...BASE, membership_tier: tier, platform_fee: '599', per_role_fee: '699', included_interviews_per_role: '30', additional_interview_fee: '30', max_interview_minutes: '12' };
    const plain = buildMembershipAgreementHtml(input);
    const packaged = buildMembershipAgreementHtml(input, { showPackageTerms: true });

    assert.equal(plain.commercial_terms, null, tier);
    for (const html of [plain.html, packaged.html]) {
      assert.ok(!html.includes('Billing Model'), `${tier}: no Enterprise line`);
      assert.ok(!html.includes('Scored Questions'), `${tier}: no Enterprise line`);
      assert.ok(!html.includes(USAGE_BILLING_SCHEDULE), `${tier}: no usage schedule`);
    }
    assert.ok(!plain.html.includes('Interview Duration Cap'), `${tier}: no package table without the flag, as before`);
    assert.ok(packaged.html.includes('Interview Duration Cap'), `${tier}: the package table with the flag, as before`);
  }
});
