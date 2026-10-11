'use strict';

// Local authored fixture only. No database, mailbox, provider or customer data.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { buildMembershipAgreementHtml } = require('../src/render/membershipAgreement');
const { htmlToPdf } = require('../src/render/pdfRenderer');
const { PDFParse } = require('pdf-parse');

async function main() {
  assert.equal(process.env.APP_ENV, 'development');
  assert.equal(process.platform, 'darwin', 'local visual fixture only');
  const result = buildMembershipAgreementHtml({
    membership_tier: 'enterprise', client_legal_name: 'Synthetic Enterprise Example',
    primary_admin_name: 'Authored Demo Owner', admin_email: 'owner@example.invalid',
    initial_term_start: '2026-11-01', initial_renewal_date: '2027-11-01',
    billing_option: 'monthly', billing_model: 'usage', platform_fee: '1200',
    per_role_fee: '0', included_interviews_per_role: '0', additional_interview_fee: '0',
    usage_interview_fee_cents: '2500', pool_quantity: '30', pool_discount_pct: '7',
    pool_total_cents: '69750', max_interview_minutes: '30', scored_question_count: '4',
    auto_renew: true, notice_deadline_days: 30
  }, { generatedAt: '2026-10-11T12:00:00.000Z' });
  const pdf = Buffer.from(await htmlToPdf(result.html));
  const parser = new PDFParse({ data: pdf });
  let parsed;
  try { parsed = await parser.getText(); } finally { await parser.destroy(); }
  for (const row of result.commercial_terms.rows) assert.ok(parsed.text.toLowerCase().includes(row.label.toLowerCase()), row.label);
  assert.ok(parsed.text.includes('$697.50'));
  const directory = path.resolve(__dirname, '../../../output/pdf');
  fs.mkdirSync(directory, { recursive: true });
  const output = path.join(directory, '2026-10-11-enterprise-agreement-fixture.pdf');
  fs.writeFileSync(output, pdf);
  console.log(JSON.stringify({ output, bytes: pdf.length, pages: parsed.total, termsTextVerified: true, authoredOnly: true }));
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
