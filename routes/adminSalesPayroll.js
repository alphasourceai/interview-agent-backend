'use strict';

const express = require('express');
const { fromZonedTime } = require('date-fns-tz');
const { calculateReceiptCommission, weekRangeForTimestamp } = require('../src/lib/salesCommissionPolicy');
const { parseMercuryPayrollCsv } = require('../src/lib/mercuryPayrollCsv');
const { loadSalesPayrollReport } = require('../src/lib/salesPayrollReportQuery');
const { buildSalesPayrollWorkbook } = require('../src/lib/salesPayrollWorkbook');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PAYMENT_KINDS = new Set(['monthly', 'paid_in_full', 'financed_checkout']);
const PROVIDERS = new Set(['stripe', 'financing_partner', 'other_verified']);
const ADJUSTMENTS = new Set(['refund', 'chargeback', 'recovery']);
const MAX_ROWS = 500;

function failure(code, status = 422) {
  return Object.assign(new Error(code), { code, status });
}

function requiredText(value, name, max = 300) {
  const text = String(value || '').trim();
  if (text.length < 4 || text.length > max) throw failure(`invalid_${name}`);
  return text;
}

function uuid(value, name) {
  if (!UUID.test(String(value || ''))) throw failure(`invalid_${name}`);
  return String(value);
}

function nonnegativeCents(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) throw failure(`invalid_${name}`);
  return value;
}

function timestamp(value, name) {
  if (typeof value !== 'string' || !/(?:Z|[+-]\d{2}:\d{2})$/i.test(value.trim())) throw failure(`invalid_${name}_timezone`);
  const date = new Date(value);
  if (!value || !Number.isFinite(date.getTime())) throw failure(`invalid_${name}`);
  return date.toISOString();
}

function termInstant(date, name) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) throw failure(`invalid_${name}`);
  return fromZonedTime(`${date}T00:00:00`, 'America/Denver').toISOString();
}

async function one(db, table, columns, column, value) {
  const { data, error } = await db.from(table).select(columns).eq(column, value).maybeSingle();
  if (error) throw failure(`${table}_read_failed`, 503);
  return data;
}

async function list(db, table, columns, order = 'created_at') {
  const { data, error } = await db.from(table).select(columns).order(order, { ascending: false }).limit(MAX_ROWS);
  if (error || !Array.isArray(data)) throw failure(`${table}_read_failed`, 503);
  return data;
}

function latestWeek(...values) {
  const date = values.map((value) => new Date(value)).sort((a, b) => b - a)[0];
  return weekRangeForTimestamp(date).date_from;
}

function isActiveClient(client) {
  const billing = String(client?.billing_status || '').trim().toLowerCase();
  const subscription = String(client?.subscription_status || '').trim().toLowerCase();
  return billing === 'active' && (!subscription || subscription === 'active' || subscription === 'trialing');
}

async function requireUnlockedWeek(db, repUserId, weekStart) {
  const { data, error } = await db.from('sales_commission_statement_locks')
    .select('week_start').eq('rep_user_id', repUserId).eq('week_start', weekStart).maybeSingle();
  if (error) throw failure('statement_lock_read_failed', 503);
  if (data) throw failure('statement_week_locked', 409);
}

function safeError(res, error) {
  if (error?.code === '23505') return res.status(409).json({ error: 'duplicate_ledger_record' });
  if (error?.code === '23514') return res.status(409).json({ error: 'commission_ledger_constraint' });
  if (error?.code === 'P0001') {
    const known = new Set(['ach_before_following_tuesday', 'source_statement_not_locked', 'adjustment_statement_not_locked',
      'commission_payout_exceeds_unpaid_verified_source', 'representative_has_unrecovered_commission_debit',
      'bank_import_collision', 'bank_allocation_rep_mismatch', 'invalid_bank_import', 'invalid_bank_allocations',
      'unknown_representative', 'unknown_bank_transaction']);
    const code = String(error.message || '');
    return res.status(409).json({ error: known.has(code) ? code : 'commission_ledger_constraint' });
  }
  const code = error?.code || (/^(invalid_report_date|invalid_report_range|report_range_too_large)$/.test(error?.message || '') ? error.message : 'sales_payroll_unavailable');
  const status = error?.status || (/^(invalid_|unsupported_|funds_received_before_payment)/.test(code) ? 422 : code === 'report_range_too_large' ? 413 : 503);
  if (status >= 500) console.error('[admin-sales-payroll] request_failed', { code });
  return res.status(status).json({ error: status >= 500 ? 'sales_payroll_unavailable' : code });
}

function createAdminSalesPayrollRouter({ db } = {}) {
  const router = express.Router();
  router.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!db) return res.status(503).json({ error: 'sales_payroll_unavailable' });
    next();
  });

  router.get('/', async (_req, res) => {
    try {
      const [reps, intents, receipts, adjustments, payouts, reversals, departures, locks] = await Promise.all([
        list(db, 'sales_reps', 'user_id,email,display_name,active', 'email'),
        list(db, 'sales_commission_review_candidates', 'id,company_legal_name,buyer_email,selected_plan_key,selected_billing_cadence,created_by_user_id,activated_at', 'activated_at'),
        list(db, 'sales_commission_receipts', 'id,purchase_intent_id,rep_user_id,provider,provider_payment_id,payment_kind,payment_success_at,funds_received_at,qualification_closed_at,rep_final_day,gross_membership_cents,discount_cents,provider_fee_cents,net_membership_cents,commission_cents,statement_week_start,evidence_reference,reviewed_at', 'reviewed_at'),
        list(db, 'sales_commission_adjustments', 'id,receipt_id,adjustment_type,provider_event_id,net_membership_delta_cents,commission_delta_cents,statement_week_start,evidence_reference,reviewed_at', 'reviewed_at'),
        list(db, 'sales_commission_payouts', 'id,receipt_id,bank_transaction_id,amount_cents,ach_reference,paid_at,recorded_at', 'recorded_at'),
        list(db, 'sales_commission_bank_reversals', 'bank_transaction_id', 'recorded_at'),
        list(db, 'sales_commission_departures', 'rep_user_id,final_day,reviewed_at', 'reviewed_at'),
        list(db, 'sales_commission_statement_locks', 'rep_user_id,week_start,snapshot_sha256,locked_at', 'locked_at'),
      ]);
      const receiptCountByIntent = new Map();
      for (const row of receipts) receiptCountByIntent.set(row.purchase_intent_id, (receiptCountByIntent.get(row.purchase_intent_id) || 0) + 1);
      const reviewCandidates = intents.map((row) => ({ ...row, reviewed_receipt_count: receiptCountByIntent.get(row.id) || 0 }));
      const pendingEvidence = reviewCandidates.filter((row) => row.reviewed_receipt_count === 0);
      const reversedBankIds = new Set(reversals.map((row) => row.bank_transaction_id));
      const effectivePayouts = payouts.filter((row) => !row.bank_transaction_id || !reversedBankIds.has(row.bank_transaction_id));
      return res.json({
        policy: { rate: 0.5, basis: 'each reviewed net first-term platform payment', timezone: 'America/Denver', annual_paid_monthly: 'each funded monthly receipt', automation_enabled: false },
        automation: { enabled: false, can_enable: false, reason: 'Worker, reconciliation, and payout controls require a separate reviewed release.' },
        representatives: reps, pending_evidence: pendingEvidence, review_candidates: reviewCandidates,
        receipts, adjustments, payouts: effectivePayouts, departures, locked_statements: locks,
        truncated: [reps, intents, receipts, adjustments, payouts, reversals].some((rows) => rows.length === MAX_ROWS),
      });
    } catch (error) { return safeError(res, error); }
  });

  router.get('/report', async (req, res) => {
    try {
      return res.json(await loadSalesPayrollReport(db, req.query));
    } catch (error) { return safeError(res, error); }
  });

  router.get('/export', async (req, res) => {
    try {
      const report = await loadSalesPayrollReport(db, req.query);
      const workbook = await buildSalesPayrollWorkbook(report);
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="sales-payroll-${report.date_from}-to-${report.date_to}.xlsx"`);
      return res.send(workbook);
    } catch (error) { return safeError(res, error); }
  });

  router.get('/payments', async (req, res) => {
    try {
      const page = Number(req.query.page || 0);
      if (!Number.isSafeInteger(page) || page < 0 || page > 10000) throw failure('invalid_page');
      const repId = req.query.rep_user_id ? uuid(req.query.rep_user_id, 'rep_user_id') : null;
      const { data: summary, error: summaryError } = await db.from('sales_commission_payment_summary')
        .select('rep_user_id,display_name,email,receipt_count,net_membership_cents,adjustment_cents,earned_cents,paid_cents,outstanding_cents')
        .order('display_name');
      if (summaryError || !Array.isArray(summary)) throw failure('payments_summary_read_failed', 503);
      let query = db.from('sales_commission_payment_rows')
        .select('receipt_id,purchase_intent_id,rep_user_id,provider_payment_id,payment_kind,net_membership_cents,commission_cents,adjustment_cents,paid_cents,outstanding_cents,paid_dates,statement_week_start,reviewed_at', { count: 'exact' })
        .order('reviewed_at', { ascending: false }).order('receipt_id', { ascending: false });
      if (repId) query = query.eq('rep_user_id', repId);
      const { data: rows, count, error } = await query.range(page * 100, page * 100 + 99);
      if (error || !Array.isArray(rows)) throw failure('payments_rows_read_failed', 503);
      return res.json({ summary, rows, page, total: count || 0 });
    } catch (error) { return safeError(res, error); }
  });

  router.post('/mercury/preview', async (req, res) => {
    try {
      const rows = parseMercuryPayrollCsv(req.body?.csv);
      const allowed = new Set(String(process.env.SALES_MERCURY_PAYROLL_ACCOUNT_SHA256 || '').split(',').map((v) => v.trim().toLowerCase()).filter(Boolean));
      return res.json({ rows: rows.map((row) => ({ ...row, source_account_allowed: allowed.has(row.source_account_fingerprint) })),
        posting_available: allowed.size > 0 });
    } catch (error) { return safeError(res, error); }
  });

  router.post('/mercury/import', async (req, res) => {
    try {
      const body = req.body || {};
      if (body.attested !== true) throw failure('mercury_review_attestation_required');
      const rows = parseMercuryPayrollCsv(body.csv);
      const row = rows.find((item) => item.row_number === body.row_number);
      if (!row) throw failure('unknown_mercury_csv_row');
      const allowed = new Set(String(process.env.SALES_MERCURY_PAYROLL_ACCOUNT_SHA256 || '').split(',').map((v) => v.trim().toLowerCase()).filter(Boolean));
      if (!allowed.has(row.source_account_fingerprint)) throw failure('unapproved_mercury_source_account', 409);
      const repId = uuid(body.rep_user_id, 'rep_user_id');
      if (!Array.isArray(body.allocations) || body.allocations.length < 1 || body.allocations.length > 50) throw failure('invalid_bank_allocations');
      const allocations = body.allocations.map((item) => ({
        receipt_id: uuid(item?.receipt_id, 'receipt_id'), amount_cents: nonnegativeCents(item?.amount_cents, 'amount_cents'),
      }));
      if (allocations.some((item) => item.amount_cents <= 0) || new Set(allocations.map((item) => item.receipt_id)).size !== allocations.length ||
          allocations.reduce((sum, item) => sum + item.amount_cents, 0) !== row.amount_cents) throw failure('invalid_bank_allocations');
      const { data, error } = await db.rpc('import_sales_commission_bank_transaction', {
        p_source_account_fingerprint: row.source_account_fingerprint, p_ach_trace: row.ach_trace,
        p_value_date: row.value_date, p_paid_at: row.paid_at, p_amount_cents: row.amount_cents,
        p_rep_user_id: repId, p_counterparty_label: row.counterparty_label,
        p_attestation: 'Admin verified outgoing ACH, recipient, posted status, and exact commission allocation in Mercury.',
        p_imported_by_user_id: req.user.id, p_allocations: allocations,
      });
      if (error) throw error;
      return res.status(201).json({ bank_transaction_id: data.id, amount_cents: data.amount_cents });
    } catch (error) { return safeError(res, error); }
  });

  router.post('/mercury/reverse', async (req, res) => {
    try {
      const body = req.body || {};
      const observedAt = timestamp(body.observed_at, 'observed_at');
      if (new Date(observedAt) > new Date()) throw failure('future_reversal_not_allowed');
      const { data, error } = await db.rpc('reverse_sales_commission_bank_transaction', {
        p_bank_transaction_id: uuid(body.bank_transaction_id, 'bank_transaction_id'),
        p_observed_at: observedAt, p_evidence_reference: requiredText(body.evidence_reference, 'evidence_reference'),
        p_recorded_by_user_id: req.user.id,
      });
      if (error) throw error;
      return res.status(201).json({ reversal: data });
    } catch (error) { return safeError(res, error); }
  });

  router.post('/receipts', async (req, res) => {
    try {
      const body = req.body || {};
      const intentId = uuid(body.purchase_intent_id, 'purchase_intent_id');
      const provider = String(body.provider || '');
      const paymentKind = String(body.payment_kind || '');
      if (!PROVIDERS.has(provider) || !PAYMENT_KINDS.has(paymentKind)) throw failure('invalid_payment_source');
      const paymentId = requiredText(body.provider_payment_id, 'provider_payment_id', 200);
      const evidence = requiredText(body.evidence_reference, 'evidence_reference');
      const gross = nonnegativeCents(body.gross_membership_cents, 'gross_membership_cents');
      const discount = nonnegativeCents(body.discount_cents, 'discount_cents');
      const fee = nonnegativeCents(body.provider_fee_cents, 'provider_fee_cents');
      const paymentAt = timestamp(body.payment_success_at, 'payment_success_at');
      const fundsAt = timestamp(body.funds_received_at, 'funds_received_at');
      if (new Date(paymentAt) > new Date()) throw failure('future_payment_not_allowed');
      if (new Date(fundsAt) > new Date()) throw failure('future_funds_not_allowed');
      const intent = await one(db, 'public_purchase_intents', 'id,status,channel,created_by_user_id,agreement_id,client_id,activated_at,selected_billing_cadence,platform_fee_cents', 'id', intentId);
      if (!intent || intent.status !== 'completed' || intent.channel !== 'sales_assisted' || !intent.created_by_user_id || !intent.agreement_id || !intent.client_id || !intent.activated_at) throw failure('unverified_qualifying_sale');
      const client = await one(db, 'clients', 'id,billing_status,subscription_status', 'id', intent.client_id);
      if (!isActiveClient(client)) throw failure('client_not_active');
      const cadence = String(intent.selected_billing_cadence || '').toLowerCase();
      if (!((cadence === 'monthly' && paymentKind === 'monthly') ||
        (cadence === 'annual' && (paymentKind === 'paid_in_full' || paymentKind === 'financed_checkout')))) {
        throw failure('payment_kind_billing_cadence_mismatch');
      }
      const platformFee = Number(intent.platform_fee_cents);
      if (!Number.isSafeInteger(platformFee) || platformFee <= 0 || gross > platformFee) throw failure('gross_exceeds_contract_platform_fee');
      const agreement = await one(db, 'membership_agreements', 'id,client_id,status,checkout_status,signed_at,checkout_paid_at,initial_term_start,initial_renewal_date', 'id', intent.agreement_id);
      if (!agreement || agreement.client_id !== intent.client_id || agreement.status !== 'signed' || agreement.checkout_status !== 'paid' || !agreement.signed_at || !agreement.checkout_paid_at) throw failure('unverified_qualifying_sale');
      if (new Date(paymentAt) < new Date(agreement.signed_at)) throw failure('payment_precedes_signed_agreement');
      const rep = await one(db, 'sales_reps', 'user_id,active', 'user_id', intent.created_by_user_id);
      if (!rep) throw failure('unattributed_sale');
      const departure = await one(db, 'sales_commission_departures', 'final_day', 'rep_user_id', rep.user_id);
      if (!rep.active && !departure) throw failure('departed_rep_needs_reviewed_final_day');
      const closeAt = new Date(Math.max(...[agreement.signed_at, agreement.checkout_paid_at, intent.activated_at].map((v) => new Date(v).getTime()))).toISOString();
      if (new Date(closeAt) > new Date()) throw failure('future_qualifying_close');
      const result = calculateReceiptCommission({
        currency: 'usd', payment_kind: paymentKind, payment_succeeded: true, qualification_verified: true,
        gross_membership_cents: gross, discount_cents: discount, provider_fee_cents: fee,
        payment_success_at: paymentAt, funds_received_at: fundsAt, qualification_closed_at: closeAt,
        first_term_start_at: termInstant(agreement.initial_term_start, 'first_term_start'),
        first_term_end_at: termInstant(agreement.initial_renewal_date, 'first_term_end'),
        rep_final_day: departure?.final_day || null,
      });
      if (result.status !== 'payable') throw failure(result.reason || 'receipt_not_payable');
      const weekStart = latestWeek(result.statement_week.from_iso, new Date().toISOString());
      await requireUnlockedWeek(db, rep.user_id, weekStart);
      const { data, error } = await db.from('sales_commission_receipts').insert({
        purchase_intent_id: intentId, rep_user_id: rep.user_id, provider, provider_payment_id: paymentId,
        payment_kind: paymentKind, currency: 'usd', payment_success_at: paymentAt, funds_received_at: fundsAt,
        qualification_closed_at: closeAt, first_term_start_at: termInstant(agreement.initial_term_start, 'first_term_start'),
        first_term_end_at: termInstant(agreement.initial_renewal_date, 'first_term_end'), rep_final_day: departure?.final_day || null,
        gross_membership_cents: gross, discount_cents: discount, provider_fee_cents: fee,
        statement_week_start: weekStart, evidence_reference: evidence,
        review_note: String(body.review_note || '').trim().slice(0, 1000) || null,
        reviewed_by_user_id: req.user.id,
      }).select('id,net_membership_cents,commission_cents,statement_week_start').single();
      if (error) throw error;
      return res.status(201).json({ receipt: data });
    } catch (error) { return safeError(res, error); }
  });

  router.post('/adjustments', async (req, res) => {
    try {
      const body = req.body || {};
      const receipt = await one(db, 'sales_commission_receipts', 'id,rep_user_id,net_membership_cents', 'id', uuid(body.receipt_id, 'receipt_id'));
      if (!receipt) throw failure('unknown_receipt', 404);
      const type = String(body.adjustment_type || '');
      if (!ADJUSTMENTS.has(type)) throw failure('invalid_adjustment_type');
      const netCents = nonnegativeCents(body.net_membership_cents, 'net_membership_cents');
      if (netCents === 0 || netCents > receipt.net_membership_cents) throw failure('invalid_adjustment_amount');
      const effectiveAt = timestamp(body.effective_at, 'effective_at');
      if (new Date(effectiveAt) > new Date()) throw failure('future_adjustment_not_allowed');
      const weekStart = latestWeek(effectiveAt, new Date().toISOString());
      await requireUnlockedWeek(db, receipt.rep_user_id, weekStart);
      const { data, error } = await db.from('sales_commission_adjustments').insert({
        receipt_id: receipt.id, adjustment_type: type,
        provider_event_id: requiredText(body.provider_event_id, 'provider_event_id', 200),
        net_membership_delta_cents: type === 'recovery' ? netCents : -netCents,
        effective_at: effectiveAt, statement_week_start: weekStart,
        evidence_reference: requiredText(body.evidence_reference, 'evidence_reference'),
        reviewed_by_user_id: req.user.id,
      }).select('id,commission_delta_cents').single();
      if (error) throw error;
      return res.status(201).json({ adjustment: data });
    } catch (error) { return safeError(res, error); }
  });

  router.post('/payouts', async (req, res) => {
    try {
      const body = req.body || {};
      const receipt = await one(db, 'sales_commission_receipts', 'id,rep_user_id', 'id', uuid(body.receipt_id, 'receipt_id'));
      if (!receipt) throw failure('unknown_receipt', 404);
      const paidAt = timestamp(body.paid_at, 'paid_at');
      if (new Date(paidAt) > new Date()) throw failure('future_payout_not_allowed');
      const reference = requiredText(body.ach_reference, 'ach_reference', 200);
      if (/^mercury:/i.test(reference) || /^\d{15}$/.test(reference)) throw failure('reserved_mercury_reference');
      const { data, error } = await db.from('sales_commission_payouts').insert({
        receipt_id: receipt.id, amount_cents: nonnegativeCents(body.amount_cents, 'amount_cents'),
        ach_reference: reference, paid_at: paidAt,
        evidence_reference: requiredText(body.evidence_reference, 'evidence_reference'),
        recorded_by_user_id: req.user.id,
      }).select('id,amount_cents').single();
      if (error) throw error;
      return res.status(201).json({ payout: data });
    } catch (error) { return safeError(res, error); }
  });

  router.post('/departures', async (req, res) => {
    try {
      const body = req.body || {};
      const repId = uuid(body.rep_user_id, 'rep_user_id');
      const day = String(body.final_day || '');
      termInstant(day, 'final_day');
      const rep = await one(db, 'sales_reps', 'user_id', 'user_id', repId);
      if (!rep) throw failure('unknown_representative', 404);
      const { data, error } = await db.from('sales_commission_departures').insert({
        rep_user_id: repId, final_day: day,
        evidence_reference: requiredText(body.evidence_reference, 'evidence_reference'), reviewed_by_user_id: req.user.id,
      }).select('rep_user_id,final_day').single();
      if (error) throw error;
      return res.status(201).json({ departure: data });
    } catch (error) { return safeError(res, error); }
  });

  router.post('/statements/lock', async (req, res) => {
    try {
      const repId = uuid(req.body?.rep_user_id, 'rep_user_id');
      const weekStart = String(req.body?.week_start || '');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(weekStart)) throw failure('invalid_week_start');
      const weekEndExclusive = new Date(`${weekStart}T00:00:00Z`);
      weekEndExclusive.setUTCDate(weekEndExclusive.getUTCDate() + 7);
      if (fromZonedTime(`${weekEndExclusive.toISOString().slice(0, 10)}T00:00:00`, 'America/Denver') > new Date()) throw failure('statement_week_not_complete');
      await requireUnlockedWeek(db, repId, weekStart);
      const { data, error } = await db.rpc('lock_sales_commission_statement', {
        p_rep_user_id: repId, p_week_start: weekStart, p_locked_by_user_id: req.user.id,
      });
      if (error) throw error;
      return res.status(201).json({ statement: data });
    } catch (error) { return safeError(res, error); }
  });

  router.post('/automation', (_req, res) => res.status(409).json({ error: 'automation_not_implemented', enabled: false }));
  return router;
}

module.exports = { createAdminSalesPayrollRouter, latestWeek };
