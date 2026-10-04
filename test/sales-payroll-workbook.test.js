'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const JSZip = require('jszip');
const { buildSalesPayrollWorkbook, safeSheetNames, excelDate } = require('../src/lib/salesPayrollWorkbook');

test('Excel date conversion uses real date values and rejects impossible dates', () => {
  assert.equal(excelDate('2026-10-03'), 46298);
  assert.throws(() => excelDate('2026-02-30'), /invalid_excel_date/);
});

test('salesperson tabs are unique, safe and within Excel name limits', () => {
  const names = safeSheetNames([
    { display_name: 'A/B: Very Long Salesperson Name One' },
    { display_name: 'A/B: Very Long Salesperson Name One' },
    { display_name: 'Summary' },
  ]);
  assert.equal(names.length, 3);
  assert.equal(new Set(names.map((name) => name.toLowerCase())).size, 3);
  assert.ok(names.every((name) => name.length <= 31 && !/[\\/*?:\[\]]/.test(name)));
  assert.notEqual(names[2].toLowerCase(), 'summary');
});

test('XLSX has summary and rep sheets with numeric money, dates, and inert client text', async () => {
  const report = {
    date_from: '2026-10-01', date_to: '2026-10-03',
    totals: { sale_count: 1, gross_sales_cents: 29900, adjustment_cents: -1900, net_revenue_cents: 28000, commission_cents: 14000 },
    representatives: [{
      user_id: 'rep-1', display_name: 'Test Rep', email: 'rep@example.invalid', sale_count: 1,
      gross_sales_cents: 29900, adjustment_cents: -1900, net_revenue_cents: 28000, commission_cents: 14000,
      events: [{ date: '2026-10-03', client_name: '=HYPERLINK("https://example.invalid")', activity: 'Payment received',
        gross_sales_cents: 29900, adjustment_cents: -1900, net_revenue_cents: 28000, commission_cents: 14000,
        purchase_intent_id: 'synthetic-intent', receipt_id: 'synthetic-receipt' }],
    }],
  };
  const buffer = await buildSalesPayrollWorkbook(report);
  const zip = await JSZip.loadAsync(buffer);
  const workbook = await zip.file('xl/workbook.xml').async('string');
  const summary = await zip.file('xl/worksheets/sheet1.xml').async('string');
  const representative = await zip.file('xl/worksheets/sheet2.xml').async('string');
  assert.match(workbook, /name="Summary"/);
  assert.match(workbook, /name="Test Rep"/);
  assert.match(summary, /<c r="C6" s="2"><v>299<\/v><\/c>/);
  assert.match(summary, /<c r="B6" s="3"><v>1<\/v><\/c>/);
  assert.match(representative, /<c r="A6" s="4"><v>46298<\/v><\/c>/);
  assert.match(representative, /t="inlineStr"><is><t xml:space="preserve">=HYPERLINK/);
  assert.match(representative, /synthetic-receipt/);
  assert.doesNotMatch(representative, /<f>/);
});
