'use strict';

const { fromZonedTime } = require('date-fns-tz');
const { buildSalesPayrollReport } = require('./salesPayrollReport');

const PAGE_SIZE = 500;
const MAX_REPORT_ROWS = 10000;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

function parseDate(value) {
  if (typeof value !== 'string' || !DATE.test(value)) throw new Error('invalid_report_date');
  const date = new Date(`${value}T12:00:00Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) throw new Error('invalid_report_date');
  return date;
}

function reportBounds(query) {
  const start = parseDate(query.date_from);
  const end = parseDate(query.date_to);
  if (start > end) throw new Error('invalid_report_range');
  const endPlusOne = new Date(end.getTime() + 86400000).toISOString().slice(0, 10);
  return {
    dateFrom: query.date_from, dateTo: query.date_to,
    fromIso: fromZonedTime(`${query.date_from}T00:00:00`, 'America/Denver').toISOString(),
    toIso: fromZonedTime(`${endPlusOne}T00:00:00`, 'America/Denver').toISOString(),
  };
}

async function allRows(db, table, columns, configure = (query) => query, orderColumn = 'id') {
  const rows = [];
  const seen = new Set();
  let expectedCount = null;
  for (let offset = 0; offset <= MAX_REPORT_ROWS; offset += PAGE_SIZE) {
    const query = configure(db.from(table).select(columns, { count: 'exact' }))
      .order(orderColumn, { ascending: true }).range(offset, offset + PAGE_SIZE - 1);
    const { data, count, error } = await query;
    if (error || !Array.isArray(data) || !Number.isSafeInteger(count) || count < 0) throw new Error(`report_${table}_read_failed`);
    if (count > MAX_REPORT_ROWS) throw new Error('report_range_too_large');
    if (expectedCount === null) expectedCount = count;
    if (count !== expectedCount || data.length !== Math.min(PAGE_SIZE, expectedCount - offset)) throw new Error(`report_${table}_incomplete_read`);
    for (const row of data) {
      const id = row[orderColumn];
      if (typeof id !== 'string' || !id || seen.has(id)) throw new Error(`report_${table}_duplicate_or_missing_id`);
      seen.add(id);
    }
    rows.push(...data);
    if (rows.length > MAX_REPORT_ROWS) throw new Error('report_range_too_large');
    if (rows.length === expectedCount) return rows;
  }
  throw new Error('report_range_too_large');
}

async function matchingIds(db, table, columns, ids) {
  if (!ids.length) return [];
  const rows = [];
  for (let index = 0; index < ids.length; index += 100) {
    const chunk = ids.slice(index, index + 100);
    const { data, error } = await db.from(table).select(columns).in('id', chunk).limit(chunk.length);
    if (error || !Array.isArray(data) || data.length !== chunk.length || new Set(data.map((row) => row.id)).size !== chunk.length ||
        data.some((row) => !chunk.includes(row.id))) throw new Error(`report_${table}_join_failed`);
    rows.push(...data);
  }
  return rows;
}

const RECEIPT_COLUMNS = 'id,purchase_intent_id,rep_user_id,funds_received_at,payment_kind,gross_membership_cents,discount_cents,provider_fee_cents,net_membership_cents,commission_cents';

async function loadSalesPayrollReport(db, query, generatedAt = new Date().toISOString()) {
  const bounds = reportBounds(query);
  const [representatives, receipts, adjustments] = await Promise.all([
    allRows(db, 'sales_reps', 'user_id,display_name,email', (request) => request.lte('created_at', generatedAt), 'user_id'),
    allRows(db, 'sales_commission_receipts', RECEIPT_COLUMNS, (request) => request
      .gte('funds_received_at', bounds.fromIso).lt('funds_received_at', bounds.toIso).lte('reviewed_at', generatedAt)),
    allRows(db, 'sales_commission_adjustments', 'id,receipt_id,adjustment_type,net_membership_delta_cents,commission_delta_cents,effective_at', (request) => request
      .gte('effective_at', bounds.fromIso).lt('effective_at', bounds.toIso).lte('reviewed_at', generatedAt)),
  ]);
  const receiptIds = new Set(receipts.map((row) => row.id));
  const linkedIds = [...new Set(adjustments.map((row) => row.receipt_id))].filter((id) => !receiptIds.has(id));
  const linkedReceipts = await matchingIds(db, 'sales_commission_receipts', RECEIPT_COLUMNS, linkedIds);
  const intentIds = [...new Set([...receipts, ...linkedReceipts].map((row) => row.purchase_intent_id))];
  const intents = await matchingIds(db, 'public_purchase_intents', 'id,channel,created_by_user_id,company_legal_name,buyer_email', intentIds);
  return buildSalesPayrollReport({ ...bounds, representatives, receipts, adjustments, linkedReceipts, intents, generatedAt });
}

module.exports = { loadSalesPayrollReport, reportBounds, allRows };
