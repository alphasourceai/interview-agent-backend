'use strict';

const { createHash } = require('node:crypto');

const HEADERS = [
  'Date (UTC)', 'Description', 'Amount', 'Status', 'Source Account', 'Bank Description',
  'Reference', 'Note', 'Last Four Digits', 'Name On Card', 'Merchant Type', 'Category',
  'Source of Category', 'GL Code', 'Source of GL Code', 'Timestamp', 'Original Currency',
  'Check Number', 'Cardholder Email', 'Tracking ID', 'Failure Reason',
];

function csvFailure(code, row) {
  return Object.assign(new Error(code), { code, status: 422, row });
}

function parseCsv(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > 1024 * 1024) throw csvFailure('invalid_mercury_csv_size');
  const input = text.replace(/^\uFEFF/, '');
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  let endedQuote = false;
  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];
    if (quoted) {
      if (ch === '"' && input[i + 1] === '"') { cell += '"'; i += 1; }
      else if (ch === '"') { quoted = false; endedQuote = true; }
      else cell += ch;
    } else if (ch === '"' && !cell && !endedQuote) quoted = true;
    else if (ch === ',') { row.push(cell); cell = ''; endedQuote = false; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && input[i + 1] === '\n') i += 1;
      row.push(cell); rows.push(row); row = []; cell = ''; endedQuote = false;
      if (rows.length > 501) throw csvFailure('mercury_csv_too_many_rows');
    } else if (endedQuote || ch === '"') throw csvFailure('invalid_mercury_csv_quoting');
    else cell += ch;
  }
  if (quoted) throw csvFailure('invalid_mercury_csv_quoting');
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

function utcDate(raw, row) {
  const match = /^(\d{2})-(\d{2})-(\d{4})$/.exec(raw);
  if (!match) throw csvFailure('invalid_mercury_value_date', row);
  const month = Number(match[1]); const day = Number(match[2]); const year = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() + 1 !== month || date.getUTCDate() !== day) {
    throw csvFailure('invalid_mercury_value_date', row);
  }
  return date.toISOString().slice(0, 10);
}

function utcTimestamp(raw, row) {
  const match = /^(\d{2}-\d{2}-\d{4}) (\d{2}):(\d{2}):(\d{2})$/.exec(raw);
  if (!match) throw csvFailure('invalid_mercury_timestamp', row);
  const day = utcDate(match[1], row);
  const hours = Number(match[2]); const minutes = Number(match[3]); const seconds = Number(match[4]);
  if (hours > 23 || minutes > 59 || seconds > 59) throw csvFailure('invalid_mercury_timestamp', row);
  return `${day}T${match[2]}:${match[3]}:${match[4]}.000Z`;
}

function parseMercuryPayrollCsv(text) {
  const rows = parseCsv(text);
  if (rows.length < 2 || rows[0].length !== HEADERS.length || rows[0].some((value, index) => value !== HEADERS[index])) {
    throw csvFailure('unsupported_mercury_csv_headers');
  }
  const transactions = [];
  const seen = new Set();
  for (let index = 1; index < rows.length; index += 1) {
    const values = rows[index];
    if (values.length !== HEADERS.length) throw csvFailure('invalid_mercury_csv_columns', index + 1);
    const entry = Object.fromEntries(HEADERS.map((header, column) => [header, values[column].trim()]));
    const rowNumber = index + 1;
    const trace = entry['Tracking ID'];
    const amount = entry.Amount;
    if (entry.Status.toLowerCase() !== 'sent' || entry['Failure Reason']) throw csvFailure('mercury_transaction_not_sent', rowNumber);
    if (!/^\d{15}$/.test(trace) || entry['Last Four Digits'] || entry['Name On Card'] ||
        entry['Merchant Type'] || entry['Check Number'] || entry['Cardholder Email']) {
      throw csvFailure('mercury_row_not_outgoing_ach', rowNumber);
    }
    if (!/^-\d+(?:\.\d{1,2})?$/.test(amount)) throw csvFailure('invalid_mercury_debit_amount', rowNumber);
    if (entry['Original Currency'] && entry['Original Currency'].toUpperCase() !== 'USD') throw csvFailure('unsupported_mercury_currency', rowNumber);
    if (!entry['Source Account']) throw csvFailure('missing_mercury_source_account', rowNumber);
    const [whole, fractional = ''] = amount.slice(1).split('.');
    const amountCents = Number(whole) * 100 + Number(fractional.padEnd(2, '0'));
    if (!Number.isSafeInteger(amountCents) || amountCents <= 0) throw csvFailure('invalid_mercury_debit_amount', rowNumber);
    const valueDate = utcDate(entry['Date (UTC)'], rowNumber);
    const paidAt = utcTimestamp(entry.Timestamp, rowNumber);
    if (paidAt.slice(0, 10) !== valueDate) throw csvFailure('mercury_date_mismatch', rowNumber);
    if (new Date(paidAt) > new Date()) throw csvFailure('future_mercury_payment', rowNumber);
    const sourceAccountFingerprint = createHash('sha256').update(entry['Source Account']).digest('hex');
    const key = `${sourceAccountFingerprint}:${trace}:${valueDate}`;
    if (seen.has(key)) throw csvFailure('duplicate_mercury_csv_transaction', rowNumber);
    seen.add(key);
    const counterpartyLabel = (entry.Description || entry['Bank Description'] || 'Mercury outgoing ACH')
      .replace(/\b\d{5,}\b/g, '[redacted]').replace(/\S+@\S+/g, '[redacted]').slice(0, 120);
    transactions.push({ row_number: rowNumber, source_account_fingerprint: sourceAccountFingerprint,
      ach_trace: trace, value_date: valueDate, paid_at: paidAt, amount_cents: amountCents,
      counterparty_label: counterpartyLabel });
  }
  return transactions;
}

module.exports = { HEADERS, parseMercuryPayrollCsv };
