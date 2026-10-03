'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { HEADERS, parseMercuryPayrollCsv } = require('../src/lib/mercuryPayrollCsv');

function fixture(overrides = {}) {
  const values = {
    'Date (UTC)': '07-10-2026', Description: 'Synthetic Rep, QA', Amount: '-299.50',
    Status: 'Sent', 'Source Account': 'Synthetic Payroll Checking',
    'Bank Description': 'Synthetic ACH', Reference: 'synthetic', Note: '',
    'Last Four Digits': '', 'Name On Card': '', 'Merchant Type': '', Category: '',
    'Source of Category': '', 'GL Code': '', 'Source of GL Code': '',
    Timestamp: '07-10-2026 14:57:13', 'Original Currency': '', 'Check Number': '',
    'Cardholder Email': '', 'Tracking ID': '123456789012345', 'Failure Reason': '',
    ...overrides,
  };
  const encode = (text) => /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  return `${HEADERS.join(',')}\r\n${HEADERS.map((key) => encode(values[key])).join(',')}\r\n`;
}

test('strict Mercury preview parses quoted labels and integer cents without storing bank fields', () => {
  const [row] = parseMercuryPayrollCsv(fixture());
  assert.equal(row.amount_cents, 29950);
  assert.equal(row.value_date, '2026-07-10');
  assert.equal(row.paid_at, '2026-07-10T14:57:13.000Z');
  assert.equal(row.counterparty_label, 'Synthetic Rep, QA');
  assert.equal(row.ach_trace, '123456789012345');
  assert.equal(Object.hasOwn(row, 'Source Account'), false);
});

test('Mercury parser rejects non-posted, wrong rail, positive and mismatched dates', () => {
  for (const [changes, code] of [
    [{ Status: 'Pending' }, 'mercury_transaction_not_sent'],
    [{ 'Failure Reason': 'synthetic failure' }, 'mercury_transaction_not_sent'],
    [{ 'Last Four Digits': '1234' }, 'mercury_row_not_outgoing_ach'],
    [{ 'Tracking ID': 'not-an-ach-trace' }, 'mercury_row_not_outgoing_ach'],
    [{ Amount: '299.50' }, 'invalid_mercury_debit_amount'],
    [{ Amount: '-0.00' }, 'invalid_mercury_debit_amount'],
    [{ 'Original Currency': 'EUR' }, 'unsupported_mercury_currency'],
    [{ Timestamp: '07-11-2026 14:57:13' }, 'mercury_date_mismatch'],
    [{ 'Date (UTC)': '02-30-2026' }, 'invalid_mercury_value_date'],
  ]) {
    assert.throws(() => parseMercuryPayrollCsv(fixture(changes)), { code });
  }
});

test('Mercury parser rejects duplicate same-day trace and unknown columns', () => {
  const sample = fixture();
  assert.throws(() => parseMercuryPayrollCsv(sample + sample.split('\r\n')[1] + '\r\n'), { code: 'duplicate_mercury_csv_transaction' });
  assert.throws(() => parseMercuryPayrollCsv(sample.replace('Tracking ID', 'Unknown ID')), { code: 'unsupported_mercury_csv_headers' });
});

test('Mercury parser allows a trace to recur on a later UTC value date', () => {
  const first = fixture();
  const second = fixture({ 'Date (UTC)': '08-10-2026', Timestamp: '08-10-2026 14:57:13' }).split('\r\n')[1];
  assert.equal(parseMercuryPayrollCsv(first + second + '\r\n').length, 2);
});
