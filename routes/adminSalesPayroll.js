'use strict';

const express = require('express');
const { fromZonedTime } = require('date-fns-tz');
const { calculateReceiptCommission, weekRangeForTimestamp } = require('../src/lib/salesCommissionPolicy');

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

async function requireUnlockedWeek(db, repUserId, weekStart) {
  const { data, error } = await db.from('sales_commission_statement_locks')
    .select('week_start').eq('rep_user_id', repUserId).eq('week_start', weekStart).maybeSingle();
  if (error) throw failure('statement_lock_read_failed', 503);
  if (data) throw failure('statement_week_locked', 409);
}

function safeError(res, error) {
  if (error?.code === '23505') return res.status(409).json({ error: 'duplicate_ledger_record' });
  if (error?.code === '23514' || error?.code === 'P0001') return res.status(409).json({ error: 'commission_ledger_constraint' });
  const code = error?.code || 'sales_payroll_unavailable';
  const status = error?.status || (/^(invalid_|unsupported_|funds_received_before_payment)/.test(code) ? 422 : 503);
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
      const [reps, intents, receipts, adjustments, payouts, departures, locks] = await Promise.all([
        list(db, 'sales_reps', 'user_id,email,display_name,active', 'email'),
        list(db, 'public_purchase_intents', 'id,company_legal_name,buyer_email,selected_plan_key,selected_billing_cadence,created_by_user_id,activated_at,status', 'activated_at'),
        list(db, 'sales_commission_receipts', 'id,purchase_intent_id,rep_user_id,provider,provider_payment_id,payment_kind,payment_success_at,funds_received_at,qualification_closed_at,rep_final_day,gross_membership_cents,discount_cents,provider_fee_cents,net_membership_cents,commission_cents,statement_week_start,evidence_reference,reviewed_at', 'reviewed_at'),
        list(db, 'sales_commission_adjustments', 'id,receipt_id,adjustment_type,provider_event_id,net_membership_delta_cents,commission_delta_cents,statement_week_start,evidence_reference,reviewed_at', 'reviewed_at'),
        list(db, 'sales_commission_payouts', 'id,receipt_id,amount_cents,ach_reference,paid_at,recorded_at', 'recorded_at'),
        list(db, 'sales_commission_departures', 'rep_user_id,final_day,reviewed_at', 'reviewed_at'),
        list(db, 'sales_commission_statement_locks', 'rep_user_id,week_start,snapshot_sha256,locked_at', 'locked_at'),
      ]);
      const approvedIntents = intents.filter((row) => row.status === 'activated' && row.created_by_user_id);
      const reviewedIntentIds = new Set(receipts.map((row) => row.purchase_intent_id));
      const pendingEvidence = approvedIntents.filter((row) => !reviewedIntentIds.has(row.id));
      return res.json({
        policy: { rate: 0.5, basis: 'each reviewed net first-term platform payment', timezone: 'America/Denver', annual_paid_monthly: 'each funded monthly receipt', automation_enabled: false },
        automation: { enabled: false, can_enable: false, reason: 'Worker, reconciliation, and payout controls require a separate reviewed release.' },
        representatives: reps, pending_evidence: pendingEvidence,
        receipts, adjustments, payouts, departures, locked_statements: locks,
        truncated: [reps, intents, receipts, adjustments, payouts].some((rows) => rows.length === MAX_ROWS),
      });
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
      const intent = await one(db, 'public_purchase_intents', 'id,status,created_by_user_id,agreement_id,activated_at,selected_billing_cadence', 'id', intentId);
      if (!intent || intent.status !== 'activated' || !intent.created_by_user_id || !intent.agreement_id || !intent.activated_at) throw failure('unverified_qualifying_sale');
      const agreement = await one(db, 'membership_agreements', 'id,status,checkout_status,signed_at,checkout_paid_at,initial_term_start,initial_renewal_date', 'id', intent.agreement_id);
      if (!agreement || agreement.status !== 'signed' || agreement.checkout_status !== 'paid' || !agreement.signed_at || !agreement.checkout_paid_at) throw failure('unverified_qualifying_sale');
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
      const { data, error } = await db.from('sales_commission_payouts').insert({
        receipt_id: receipt.id, amount_cents: nonnegativeCents(body.amount_cents, 'amount_cents'),
        ach_reference: requiredText(body.ach_reference, 'ach_reference', 200), paid_at: paidAt,
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
