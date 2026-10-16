'use strict';

const { formatInTimeZone, fromZonedTime } = require('date-fns-tz');
const { anchoredMonthInstant } = require('./membershipOffers');

const TIME_ZONE = 'America/Denver';
const COMMISSION_RATE = 0.5;
const PAYMENT_KINDS = new Set(['paid_in_full', 'monthly', 'financed_checkout']);

function policyError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function cents(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) throw policyError(`invalid_${name}`);
  return value;
}

function instant(value, name, optional = false) {
  if (optional && (value === null || value === undefined || value === '')) return null;
  if (value === null || value === undefined || value === '') throw policyError(`invalid_${name}`);
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw policyError(`invalid_${name}`);
  return date;
}

function localDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) throw policyError('invalid_final_day');
  const date = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) throw policyError('invalid_final_day');
  return date;
}

function addCalendarDays(date, days) {
  const copy = new Date(date.getTime());
  copy.setUTCDate(copy.getUTCDate() + days);
  return copy.toISOString().slice(0, 10);
}

function departureCutoffExclusive(finalDay) {
  const dayAfterWindow = addCalendarDays(localDate(finalDay), 31);
  return fromZonedTime(`${dayAfterWindow}T00:00:00`, TIME_ZONE);
}

function weekRangeForTimestamp(value) {
  const date = instant(value, 'timestamp');
  const dateOnly = formatInTimeZone(date, TIME_ZONE, 'yyyy-MM-dd');
  const weekday = Number(formatInTimeZone(date, TIME_ZONE, 'i'));
  const monday = addCalendarDays(new Date(`${dateOnly}T00:00:00.000Z`), 1 - weekday);
  const nextMonday = addCalendarDays(new Date(`${monday}T00:00:00.000Z`), 7);
  return {
    date_from: monday,
    date_to: addCalendarDays(new Date(`${nextMonday}T00:00:00.000Z`), -1),
    from_iso: fromZonedTime(`${monday}T00:00:00`, TIME_ZONE).toISOString(),
    to_exclusive_iso: fromZonedTime(`${nextMonday}T00:00:00`, TIME_ZONE).toISOString(),
  };
}

function calculateReceiptCommission(input = {}) {
  const gross = cents(input.gross_membership_cents, 'gross_membership_cents');
  const discount = cents(input.discount_cents, 'discount_cents');
  const fee = cents(input.provider_fee_cents, 'provider_fee_cents');
  if (discount > gross || fee > gross - discount) throw policyError('invalid_net_membership');
  if (input.currency !== 'usd') throw policyError('unsupported_currency');
  if (!PAYMENT_KINDS.has(input.payment_kind)) throw policyError('invalid_payment_kind');
  const paid = instant(input.payment_success_at, 'payment_success_at');
  const received = instant(input.funds_received_at, 'funds_received_at', true);
  // Both server-qualified sources share first-year arithmetic. The existing-flow
  // source uses a real agreement qualification, never a fabricated contract ID.
  // This calculator is not receipt authentication; native/API source checks own it.
  const v2 = ['retail_terms_v2', 'retail_existing_terms_v2'].includes(input.membership_terms_protocol);
  const enterprise = input.membership_terms_protocol === 'enterprise_existing_terms_v1';
  const firstYear = v2 || enterprise;
  if (input.membership_terms_protocol != null && !firstYear) throw policyError('unsupported_membership_terms_protocol');
  if (enterprise && !['monthly','paid_in_full'].includes(input.payment_kind)) throw policyError('invalid_enterprise_payment_kind');
  // These prospective fields must come from the immutable accepted contract and
  // original sale qualification, not renewal metadata or browser receipt input.
  // Existing callers omit the marker and retain their exact legacy policy.
  const closed = instant(firstYear ? input.original_qualification_closed_at : input.qualification_closed_at,
    firstYear ? 'original_qualification_closed_at' : 'qualification_closed_at');
  const termStart = instant(input.first_term_start_at, 'first_term_start_at');
  const termEnd = instant(input.first_term_end_at, 'first_term_end_at');
  if (termEnd <= termStart) throw policyError('invalid_first_term');
  let windowEnd = termEnd;
  let qualificationVerified = input.qualification_verified;
  if (firstYear) {
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuid.test(input.original_salesperson_user_id || '') || !uuid.test(input.sales_rep_user_id || '')
      || input.original_salesperson_user_id !== input.sales_rep_user_id) throw policyError('original_salesperson_mismatch');
    const original = input.original_membership_start_at;
    if (enterprise) {
      // Server-qualified original cash A and ORIGINAL custom legal E. Neither
      // today's advanced legal window nor a fake Retail month count sets this.
      const a = instant(original,'original_membership_start_at');
      const e = instant(input.original_term_end_at,'original_term_end_at');
      if (input.original_commitment_months !== undefined || termStart.getTime() !== a.getTime()
        || termEnd.getTime() !== e.getTime() || closed.getTime() !== a.getTime()) throw policyError('original_membership_term_mismatch');
      windowEnd = new Date(anchoredMonthInstant(a.toISOString(),12));
    } else {
      if (![3,6,12].includes(input.original_commitment_months)) throw policyError('invalid_original_commitment_months');
      const initialEnd = new Date(anchoredMonthInstant(original,input.original_commitment_months));
      windowEnd = new Date(anchoredMonthInstant(original,12));
      if (termStart.toISOString() !== new Date(original).toISOString() || termEnd.getTime() !== initialEnd.getTime()) {
        throw policyError('original_membership_term_mismatch');
      }
    }
    qualificationVerified = input.original_qualification_verified;
  }
  // A later monthly installment succeeds after the original qualifying close.
  // The close and each individual payment are independent cutoff gates.
  const net = gross - discount - fee;
  const cutoff = input.rep_final_day ? departureCutoffExclusive(input.rep_final_day) : null;
  let reason = null;
  if (input.payment_succeeded !== true) reason = 'payment_not_successful';
  else if (qualificationVerified !== true) reason = 'sale_not_verified';
  else if (closed < termStart || closed >= termEnd || paid >= windowEnd || (firstYear && paid < termStart)) {
    reason = firstYear ? 'outside_original_first_year' : 'outside_first_term';
  }
  else if (cutoff && (paid >= cutoff || closed >= cutoff)) reason = 'after_departure_window';
  else if (net <= 0) reason = 'no_net_membership_fee';
  if (reason) return { status: 'ineligible', reason, net_membership_cents: net, commission_cents: 0, statement_week: null };
  if (!received) return { status: 'awaiting_funds', reason: null, net_membership_cents: net, commission_cents: 0, statement_week: null };
  if (received < paid) throw policyError('funds_received_before_payment');
  const earnedAt = received > closed ? received : closed;
  return {
    status: 'payable',
    reason: null,
    net_membership_cents: net,
    commission_cents: Math.round(net * COMMISSION_RATE),
    statement_week: weekRangeForTimestamp(earnedAt),
  };
}

module.exports = { COMMISSION_RATE, TIME_ZONE, calculateReceiptCommission, departureCutoffExclusive, weekRangeForTimestamp };
