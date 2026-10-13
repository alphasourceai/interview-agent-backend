'use strict';

// EXISTING Checkout trace/SDK adapter. No Auth, contract, invoice or funded-A
// writes. Only the service-role native RPC may originate request identity.
const { isDeepStrictEqual } = require('node:util');
const { createHash } = require('node:crypto');
const { collect } = require('./existingRetailCheckoutFunding');
function fail(code, status = 409) { const e = new Error(code);e.code = code;e.status = status;throw e; }
const check = (v, code, status) => { if (!v) fail(code, status); };
const id = v => typeof v === 'string' ? v : v?.id;
const integer = v => Number.isSafeInteger(v) && v >= 0;
function configValid(config) {
  return config && Object.keys(config).sort().join(',') === 'public_backend_base,public_sign_base'
    && Object.values(config).every(value => {
      if (typeof value !== 'string' || value.length > 2048) return false;
      try { const u = new URL(value);return u.protocol === 'https:' && !u.username && !u.password && !u.search && !u.hash; }
      catch (_) { return false; }
    });
}
async function rpc(db, name, args) {
  check(typeof db?.rpc === 'function', 'retail_checkout_store_unavailable', 503);
  let result;try { result = await db.rpc(name, args); }catch (_) { fail('retail_checkout_store_unavailable', 503); }
  if (result?.error) {
    if (/retail_checkout_window_closed/.test(result.error.message || '')) fail('retail_checkout_window_closed', 410);
    if (/retail_checkout_/.test(result.error.message || '')) fail('retail_checkout_attempt_hold');
    fail('retail_checkout_store_unavailable', 503);
  }
  check(result?.data && !Array.isArray(result.data), 'retail_checkout_store_unavailable', 503);
  return result.data;
}
function assertAttempt(attempt, { agreement, customerId }) {
  check(attempt?.agreement_id === agreement.id && attempt.client_id === agreement.client_id
    && attempt.source?.version === 'retail_existing_checkout_attempt_v1'
    && attempt.source.agreement_id === agreement.id && attempt.source.client_id === agreement.client_id
    && attempt.source.customer_id === customerId
    && isDeepStrictEqual(attempt.source.template_snapshot, agreement.template_snapshot)
    && configValid(attempt.source.config) && typeof attempt.embedded === 'boolean'
    && (attempt.replacement_id === null || /^sub_[A-Za-z0-9_]+$/.test(attempt.replacement_id))
    && (attempt.checkout_session_id === null || /^cs_[A-Za-z0-9_]+$/.test(attempt.checkout_session_id)),
  'retail_checkout_attempt_mismatch', 503);
  assertWindow(attempt);
  return attempt;
}
function assertWindow(attempt) {
  const b = Date.parse(attempt.created_at), deadline = Date.parse(attempt.source.agreement_expires_at), now = Date.now();
  const intentDeadline = attempt.source.intent ? Date.parse(attempt.source.intent.expires_at) : Infinity;
  check(Number.isFinite(b) && Number.isFinite(deadline) && integer(attempt.expires_at)
    && (!attempt.source.intent || Number.isFinite(intentDeadline))
    && attempt.expires_at === Math.floor(Math.min(deadline, intentDeadline, b + 86400000 - 1000) / 1000),
  'retail_checkout_attempt_mismatch', 503);
  check(now < b + 86400000 && attempt.expires_at * 1000 - now >= 1800000,
    'retail_checkout_window_closed', 410);
}
async function claimExistingRetailAttempt({ db, agreement, customerId, embedded, replacementId, config }) {
  const attempt = await rpc(db, 'claim_retail_existing_checkout_attempt', {
    p_agreement: agreement.id, p_client: agreement.client_id, p_expected_template: agreement.template_snapshot,
    p_customer: customerId, p_embedded: embedded, p_replacement: replacementId, p_config: config
  });
  return assertAttempt(attempt, { agreement, customerId });
}
function frozenRetailCancelUrl(attempt, cancelUrl) {
  let token;try {
    const u = new URL(cancelUrl), match = u.pathname.match(/\/membership-agreement\/sign\/([^/]+)$/);
    token = match && decodeURIComponent(match[1]);
  }catch (_) { /* same safe refusal below */ }
  check(typeof token === 'string' && token && /^[a-f0-9]{64}$/.test(attempt.source.signer_token_hash)
    && createHash('sha256').update(token).digest('hex') === attempt.source.signer_token_hash,
  'retail_checkout_signer_mismatch');
  const linked = !!attempt.source.intent;
  return `${attempt.source.config.public_sign_base}/membership-agreement/sign/${encodeURIComponent(token)}${linked ? '?checkout=cancel' : ''}`;
}
function priceMatches(price, amount, recurring) {
  return price?.object === 'price' && /^price_[A-Za-z0-9_]+$/.test(price.id || '') && price.currency === 'usd'
    && price.unit_amount === amount && price.type === (recurring ? 'recurring' : 'one_time')
    && (recurring ? price.recurring?.interval === 'month' && price.recurring.interval_count === recurring.interval_count
      && price.recurring.usage_type === 'licensed' : price.recurring === null);
}
async function readOpenRetailSession({ stripe, sessionId, attempt, offer, metadata, successUrl, cancelUrl }) {
  assertWindow(attempt);
  check(/^cs_[A-Za-z0-9_]+$/.test(sessionId || ''), 'retail_checkout_ack_unknown', 503);
  const session = await stripe.checkout.sessions.retrieve(sessionId);
  check(session?.id === sessionId && session.object === 'checkout.session' && session.mode === 'subscription'
    && id(session.customer) === attempt.source.customer_id && session.currency === 'usd'
    && typeof session.livemode === 'boolean' && session.expires_at === attempt.expires_at,
  'retail_checkout_session_mismatch');
  check(session.status !== 'complete' && session.payment_status !== 'paid', 'agreement_checkout_already_paid');
  check(session.status !== 'expired', 'retail_checkout_window_closed', 410);
  check(session.status === 'open' && session.payment_status === 'unpaid' && !id(session.subscription)
    && session.ui_mode === (attempt.embedded ? 'embedded' : 'hosted')
    && (attempt.embedded ? session.return_url === successUrl
      : session.success_url === successUrl && session.cancel_url === cancelUrl)
    && Object.entries(metadata).every(([k, v]) => session.metadata?.[k] === v), 'retail_checkout_session_mismatch');
  const lines = await collect(after => stripe.checkout.sessions.listLineItems(sessionId,
    { limit: 100, ...(after ? { starting_after: after } : {}) }), async () => assertWindow(attempt));
  const data = lines.data;
  check(data.length === (offer.first_role_prepay.selected ? 2 : 1)
    && data.every(l => l.quantity === 1 && l.currency === 'usd' && integer(l.amount_subtotal)
      && l.amount_subtotal === l.price?.unit_amount)
    && data.filter(l => priceMatches(l.price, offer.platform_payment_cents, offer.stripe_recurrence)).length === 1
    && data.filter(l => priceMatches(l.price, offer.first_role_prepay.amount_cents, null)).length === (offer.first_role_prepay.selected ? 1 : 0)
    && session.amount_subtotal === offer.initial_payment_cents && integer(session.amount_total) && session.amount_total > 0,
  'retail_checkout_session_prices_mismatch');
  if (offer.payment_option === 'prepaid') check(session.allow_promotion_codes === false
    && session.total_details?.amount_discount === 0 && session.total_details?.amount_shipping === 0
    && integer(session.total_details?.amount_tax)
    && session.amount_total === offer.initial_payment_cents + session.total_details.amount_tax,
  'retail_checkout_session_prices_mismatch');
  if (attempt.embedded) check(typeof session.client_secret === 'string' && session.client_secret.trim(), 'retail_checkout_ack_unknown', 503);
  else {
    let u;try { u = new URL(session.url); }catch (_) { /* safe refusal */ }
    check(u?.protocol === 'https:' && !u.username && !u.password, 'retail_checkout_ack_unknown', 503);
  }
  return session;
}
async function pinExistingRetailSession({ db, agreement, customerId, attempt, sessionId }) {
  assertAttempt(attempt, { agreement, customerId });
  const actual = await rpc(db, 'pin_retail_existing_checkout_session', {
    p_agreement: agreement.id, p_client: agreement.client_id, p_attempt: attempt, p_session: sessionId
  });
  check(isDeepStrictEqual(actual, { ...attempt, checkout_session_id: sessionId }), 'retail_checkout_pin_ack_unknown', 503);
  return actual;
}
module.exports = { claimExistingRetailAttempt, assertAttempt, assertWindow, frozenRetailCancelUrl,
  readOpenRetailSession, pinExistingRetailSession };
