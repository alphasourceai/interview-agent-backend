'use strict';

// Unwired, pure v2 initial-payment proof. Objects must come from authenticated
// Stripe API2023-10-16 readback and the binding from our persisted accepted
// contract/Checkout record, NEVER a browser payload or Stripe metadata alone.
// This module does not retrieve objects, persist, align billing or grant access.
const { retailTermWindow, anchoredMonthInstant } = require('./membershipOffers');

function fail(code) {
  const error = new Error(code);
  error.code = code;
  error.status = 409;
  throw error;
}

function requireProof(condition, code) {
  if (!condition) fail(code);
}

function id(value) {
  return typeof value === 'string' ? value : value?.id;
}

function validId(value, prefix) {
  return typeof value === 'string' && value.startsWith(`${prefix}_`)
    && /^[a-zA-Z0-9_]+$/.test(value) && value.length > prefix.length + 1;
}

function cents(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function epoch(value) {
  // JS Date's supported range is wider than our 4-digit UTC contract schema.
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
    && value <= 253402300799;
}

function empty(value) {
  return Array.isArray(value) && value.length === 0;
}

function completeList(value) {
  return value?.object === 'list' && value.has_more === false && Array.isArray(value.data);
}

const RECEIPT_OWNER_KEYS = Object.freeze({ checkout_session_id: 'cs', subscription_id: 'sub',
  invoice_id: 'in', payment_intent_id: 'pi', charge_id: 'ch' });

function assertReceiptOwner(identity, owners = []) {
  requireProof(Array.isArray(owners), 'invalid_receipt_owners');
  for (const owner of owners) {
    requireProof(owner && typeof owner.contract_id === 'string' && owner.contract_id.length > 0
      && Number.isSafeInteger(owner.contract_version) && owner.contract_version > 0
      && typeof owner.livemode === 'boolean'
      && Object.entries(RECEIPT_OWNER_KEYS).every(([key, prefix]) => owner[key] == null || validId(owner[key], prefix))
      && Object.keys(RECEIPT_OWNER_KEYS).some(key => owner[key] != null), 'invalid_receipt_owners');
    const shared = owner.livemode === identity.livemode
      && Object.keys(RECEIPT_OWNER_KEYS).some(key => owner[key] === identity[key]);
    requireProof(!shared || (owner.contract_id === identity.contract_id
      && owner.contract_version === identity.contract_version), 'conflicting_receipt_owner');
  }
}

function validateAcceptedOffer(offer) {
  requireProof(offer?.schema_version === 2 && typeof offer.offer_version === 'string'
    && offer.offer_version.length > 0 && ['basic', 'pro'].includes(offer.plan_key)
    && offer.currency === 'usd' && offer.term_start_basis === 'first_payment_success'
    && offer.contract_timezone === 'UTC', 'unsupported_payment_start_contract');
  requireProof([3, 6, 12].includes(offer.commitment_months)
    && ['prepaid', 'monthly_installments'].includes(offer.payment_option), 'invalid_accepted_payment_terms');
  const installment = offer.payment_option === 'monthly_installments';
  const payments = installment ? offer.commitment_months : 1;
  const interval = installment ? 1 : offer.commitment_months;
  requireProof(offer.installment_count === payments && offer.stripe_recurrence?.interval === 'month'
    && offer.stripe_recurrence.interval_count === interval
    && cents(offer.platform_payment_cents) && offer.platform_payment_cents > 0
    && cents(offer.platform_commitment_total_cents)
    && offer.platform_commitment_total_cents === offer.platform_payment_cents * payments,
  'invalid_accepted_payment_terms');
  requireProof(typeof offer.first_role_prepay?.selected === 'boolean'
    && cents(offer.first_role_prepay.amount_cents)
    && (offer.first_role_prepay.selected ? offer.first_role_prepay.amount_cents > 0 : offer.first_role_prepay.amount_cents === 0)
    && cents(offer.initial_payment_cents)
    && offer.initial_payment_cents === offer.platform_payment_cents + offer.first_role_prepay.amount_cents,
  'invalid_accepted_initial_total');
  // Do not rebuild accepted terms from today's catalog: future catalog changes
  // must not invalidate or reprice an already accepted immutable snapshot.
}

function validatePrice(price, expectedId, amount, recurring) {
  requireProof(price?.object === 'price' && price.id === expectedId && price.currency === 'usd'
    && price.unit_amount === amount && price.type === (recurring ? 'recurring' : 'one_time'),
  'initial_price_mismatch');
  if (recurring) {
    requireProof(price.recurring?.interval === 'month'
      && price.recurring.interval_count === recurring.interval_count
      && price.recurring.usage_type === 'licensed', 'initial_recurrence_mismatch');
  } else {
    requireProof(price.recurring === null, 'initial_recurrence_mismatch');
  }
}

function taxTotal(taxes) {
  requireProof(Array.isArray(taxes), 'initial_tax_unverified');
  let total = 0;
  for (const tax of taxes) {
    requireProof(tax && cents(tax.amount) && tax.inclusive === false
      && validId(id(tax.tax_rate), 'txr'), 'initial_tax_unverified');
    total += tax.amount;
    requireProof(cents(total), 'initial_tax_unverified');
  }
  return total;
}

function verifyInitialLines(binding, subscription, invoice) {
  const { offer } = binding;
  requireProof(completeList(subscription.items)
    && subscription.items.data.length === 1, 'initial_items_incomplete');
  const item = subscription.items.data[0];
  requireProof(item?.id === binding.platformItemId && item.quantity === 1
    && id(item.subscription) === binding.subscriptionId, 'initial_item_mismatch');
  validatePrice(item.price, binding.platformPriceId, offer.platform_payment_cents, offer.stripe_recurrence);
  requireProof(completeList(invoice.lines)
    && invoice.lines.data.length === (offer.first_role_prepay.selected ? 2 : 1)
    && (invoice.lines.total_count == null || invoice.lines.total_count === invoice.lines.data.length),
  'initial_lines_incomplete');
  const lines = invoice.lines.data;
  requireProof(lines.every(line => validId(line?.id, 'il'))
    && new Set(lines.map(line => line.id)).size === lines.length, 'initial_line_identity_mismatch');
  const platform = lines.filter(line => line.type === 'subscription'
    && id(line.subscription_item) === binding.platformItemId);
  requireProof(platform.length === 1, 'initial_platform_line_mismatch');
  let lineTaxes = 0;
  for (const line of lines) {
    requireProof(line.currency === 'usd' && line.quantity === 1 && line.proration === false
      && empty(line.discount_amounts),
    'initial_line_mismatch');
    if (line === platform[0]) {
      requireProof(id(line.subscription) === binding.subscriptionId, 'initial_platform_line_mismatch');
      validatePrice(line.price, binding.platformPriceId, offer.platform_payment_cents, offer.stripe_recurrence);
      requireProof(line.amount === offer.platform_payment_cents, 'initial_platform_amount_mismatch');
    } else {
      requireProof(offer.first_role_prepay.selected && line.type === 'invoiceitem'
        && (line.subscription == null || id(line.subscription) === binding.subscriptionId)
        && line.subscription_item == null, 'unexpected_initial_line');
      validatePrice(line.price, binding.firstRolePriceId, offer.first_role_prepay.amount_cents, null);
      requireProof(line.amount === offer.first_role_prepay.amount_cents, 'initial_first_role_amount_mismatch');
    }
    lineTaxes += taxTotal(line.tax_amounts);
    requireProof(cents(lineTaxes), 'initial_tax_unverified');
  }
  const nativeTaxes = taxTotal(invoice.total_tax_amounts);
  requireProof(lineTaxes === nativeTaxes
    && (invoice.tax === nativeTaxes || (nativeTaxes === 0 && invoice.tax == null))
    && invoice.subtotal === offer.initial_payment_cents
    && invoice.total === offer.initial_payment_cents + nativeTaxes, 'initial_total_mismatch');
}

function initialPaymentIdentity({ binding, checkout, subscription, invoice, paymentIntent, charge, observedAt, receiptOwners } = {}) {
  validateAcceptedOffer(binding?.offer);
  requireProof(typeof binding.contractId === 'string' && binding.contractId.length > 0
    && Number.isSafeInteger(binding.contractVersion) && binding.contractVersion > 0
    && typeof binding.livemode === 'boolean'
    && validId(binding.checkoutSessionId, 'cs') && validId(binding.customerId, 'cus')
    && validId(binding.subscriptionId, 'sub') && validId(binding.platformPriceId, 'price')
    && validId(binding.platformItemId, 'si')
    && (!binding.offer.first_role_prepay.selected || validId(binding.firstRolePriceId, 'price')),
  'invalid_payment_binding');
  const objects = [[checkout, 'checkout.session', binding.checkoutSessionId],
    [subscription, 'subscription', binding.subscriptionId], [invoice, 'invoice', null],
    [paymentIntent, 'payment_intent', null], [charge, 'charge', null]];
  requireProof(objects.every(([object, type, expectedId]) => object?.object === type
    && (expectedId === null || object.id === expectedId) && object.livemode === binding.livemode
    && id(object.customer) === binding.customerId), 'initial_provider_identity_mismatch');
  requireProof(validId(invoice.id, 'in') && validId(paymentIntent.id, 'pi') && validId(charge.id, 'ch')
    && id(checkout.subscription) === binding.subscriptionId && id(checkout.invoice) === invoice.id
    && id(invoice.subscription) === binding.subscriptionId && id(invoice.payment_intent) === paymentIntent.id
    && id(paymentIntent.invoice) === invoice.id && id(paymentIntent.latest_charge) === charge.id
    && id(charge.payment_intent) === paymentIntent.id && id(charge.invoice) === invoice.id
    && id(invoice.charge) === charge.id, 'initial_provider_link_mismatch');
  requireProof(invoice.currency === 'usd' && paymentIntent.currency === 'usd' && charge.currency === 'usd'
    && checkout.currency === 'usd' && subscription.currency === 'usd', 'initial_currency_mismatch');
  // Establish only identity and completeness before checking an existing
  // activation. A later refund/dispute belongs to its own adjustment processor;
  // it must not turn an original activation replay into a new financial write.
  requireProof(completeList(subscription.items)
    && subscription.items.data.length === 1, 'initial_items_incomplete');
  requireProof(completeList(invoice.lines)
    && invoice.lines.data.length === (binding.offer.first_role_prepay.selected ? 2 : 1)
    && (invoice.lines.total_count == null || invoice.lines.total_count === invoice.lines.data.length),
  'initial_lines_incomplete');
  requireProof(invoice.lines.data.every(line => validId(line?.id, 'il'))
    && new Set(invoice.lines.data.map(line => line.id)).size === invoice.lines.data.length,
  'initial_line_identity_mismatch');
  requireProof(completeList(charge.refunds), 'initial_refunds_incomplete');
  const item = subscription.items.data[0];
  const platform = invoice.lines.data.filter(line => id(line?.subscription_item) === binding.platformItemId);
  const firstRole = invoice.lines.data.filter(line => line !== platform[0]);
  requireProof(item?.id === binding.platformItemId && id(item.price) === binding.platformPriceId
    && id(item.subscription) === binding.subscriptionId
    && platform.length === 1 && id(platform[0].price) === binding.platformPriceId
    && id(platform[0].subscription) === binding.subscriptionId
    && (!binding.offer.first_role_prepay.selected || (firstRole.length === 1
      && id(firstRole[0].price) === binding.firstRolePriceId && firstRole[0].subscription_item == null
      && (firstRole[0].subscription == null || id(firstRole[0].subscription) === binding.subscriptionId))),
  'initial_price_identity_mismatch');
  const objectsCreated = objects.map(([object]) => object.created);
  const paidAt = invoice.status_transitions?.paid_at;
  requireProof(epoch(observedAt) && epoch(paidAt) && paidAt <= observedAt
    && objectsCreated.every(created => epoch(created) && created <= paidAt), 'initial_payment_time_unverified');
  const identity = Object.freeze({
    contract_id: binding.contractId, contract_version: binding.contractVersion,
    offer_version: binding.offer.offer_version, checkout_session_id: checkout.id,
    customer_id: binding.customerId, subscription_id: subscription.id,
    invoice_id: invoice.id, payment_intent_id: paymentIntent.id, charge_id: charge.id,
    platform_price_id: binding.platformPriceId, platform_item_id: binding.platformItemId,
    first_role_price_id: binding.offer.first_role_prepay.selected ? binding.firstRolePriceId : null,
    livemode: binding.livemode, currency: 'usd',
    payment_success_at: new Date(paidAt * 1000).toISOString()
  });
  assertReceiptOwner(identity, receiptOwners);
  return identity;
}

function proveNewPayment(input, identity) {
  const { binding, checkout, subscription, invoice, paymentIntent, charge } = input;
  requireProof(subscription.status === 'active', 'initial_subscription_not_active');
  requireProof(checkout.mode === 'subscription' && checkout.status === 'complete'
    && checkout.payment_status === 'paid', 'initial_checkout_not_paid');
  requireProof(invoice.billing_reason === 'subscription_create' && invoice.status === 'paid' && invoice.paid === true
    && invoice.paid_out_of_band === false && invoice.collection_method === 'charge_automatically'
    && cents(invoice.amount_due) && invoice.amount_due > 0 && invoice.amount_paid === invoice.amount_due
    && invoice.amount_remaining === 0 && invoice.amount_paid === invoice.total
    && checkout.amount_total === invoice.total
    && invoice.starting_balance === 0 && invoice.ending_balance === 0
    && invoice.pre_payment_credit_notes_amount === 0 && invoice.post_payment_credit_notes_amount === 0
    && empty(invoice.discounts) && empty(invoice.total_discount_amounts), 'initial_invoice_not_fully_collected');
  requireProof(paymentIntent.status === 'succeeded' && paymentIntent.amount === invoice.amount_paid
    && paymentIntent.amount_received === invoice.amount_paid && charge.status === 'succeeded'
    && charge.paid === true && charge.captured === true && charge.amount === invoice.amount_paid
    && charge.amount_captured === invoice.amount_paid && charge.amount_refunded === 0
    && charge.refunded === false && empty(charge.refunds.data)
    && charge.disputed === false && charge.dispute == null, 'initial_payment_not_succeeded');
  verifyInitialLines(binding, subscription, invoice);
  return Object.freeze({
    ...identity, collected_cents: invoice.amount_paid,
    platform_payment_cents: binding.offer.platform_payment_cents,
    first_role_payment_cents: binding.offer.first_role_prepay.amount_cents,
    tax_cents: invoice.total - binding.offer.initial_payment_cents
  });
}

function proveFirstMembershipPayment(input = {}) {
  return proveNewPayment(input, initialPaymentIdentity(input));
}

function planFirstMembershipActivation(input = {}) {
  const identity = initialPaymentIdentity(input);
  if (input.existingActivation != null) {
    requireProof(Object.keys(identity).every(key => input.existingActivation[key] === identity[key]),
      'conflicting_initial_activation');
    // Recheck current financial state without changing the historical no-op.
    // Bounded dirty-proof outcomes belong to the separate adjustment processor;
    // unexpected programming exceptions still surface, rather than be swallowed.
    try { proveNewPayment(input, identity); }
    catch (error) { if (error?.status !== 409 || typeof error.code !== 'string') throw error; }
    return Object.freeze({ action: 'already_activated', identity });
  }
  const receipt = proveNewPayment(input, identity);
  const { offer } = input.binding;
  const term = retailTermWindow({ originalStart: receipt.payment_success_at, commitmentMonths: offer.commitment_months });
  const activation = Object.freeze({
    ...receipt, ...term, term_start_basis: 'first_payment_success', contract_timezone: 'UTC',
    initial_paid_access_end_at: anchoredMonthInstant(receipt.payment_success_at,
      offer.payment_option === 'monthly_installments' ? 1 : offer.commitment_months)
  });
  return Object.freeze({ action: 'reserve_initial_activation', activation, renewal_ready: false,
    provider_alignment: 'requires_verified_executor' });
}

module.exports = { proveFirstMembershipPayment, planFirstMembershipActivation };
