'use strict';

const { formatInTimeZone, fromZonedTime } = require('date-fns-tz');

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
  const closed = instant(input.qualification_closed_at, 'qualification_closed_at');
  const termStart = instant(input.first_term_start_at, 'first_term_start_at');
  const termEnd = instant(input.first_term_end_at, 'first_term_end_at');
  if (termEnd <= termStart) throw policyError('invalid_first_term');
  // A later monthly installment succeeds after the original qualifying close.
  // The close and each individual payment are independent cutoff gates.
  const net = gross - discount - fee;
  const cutoff = input.rep_final_day ? departureCutoffExclusive(input.rep_final_day) : null;
  let reason = null;
  if (input.payment_succeeded !== true) reason = 'payment_not_successful';
  else if (input.qualification_verified !== true) reason = 'sale_not_verified';
  else if (closed < termStart || closed >= termEnd || paid >= termEnd) reason = 'outside_first_term';
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
