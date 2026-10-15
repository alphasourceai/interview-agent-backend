'use strict';

// UNMOUNTED, server-only persisted original observation. No activation lease,
// provider operation, access/renewal/collection/payment/commission authority.
const { isProxy } = require('node:util').types;
const { snapshotStripeSdkData: snapshot } = require('./enterprisePoolPaymentProof');
const { inspectExistingRetailRecurringPeriods } = require('./existingRetailRecurringPeriods');
const KEYS = ['version', 'agreement_id', 'client_id', 'source_intent_id', 'package_snapshot', 'original_period',
  'original_provider_account_id', 'effect_authorized', 'collection_ready', 'paid_access_authorized', 'payroll_authorized'];
const FLAGS = ['effect_authorized', 'collection_ready', 'paid_access_authorized', 'payroll_authorized'];
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
class SourceError extends Error {
  constructor(invalid = false) {
    const code = invalid ? 'retail_recurring_source_invalid' : 'retail_recurring_source_unknown';
    super(code); this.code = code; this.status = invalid ? 409 : 503;
  }
}
function valid(value) { if (!value) throw new SourceError(true); }
function freeze(value) {
  for (const child of Object.values(value)) if (child && typeof child === 'object') freeze(child);
  return Object.freeze(value);
}
async function read(input) {
  valid(input && typeof input === 'object' && !isProxy(input)
    && [Object.prototype, null].includes(Object.getPrototypeOf(input)));
  const fields = Object.getOwnPropertyDescriptors(input);
  valid(Reflect.ownKeys(fields).length === 3 && ['db', 'agreementId', 'clientId'].every(key =>
    fields[key]?.enumerable && Object.hasOwn(fields[key], 'value')));
  const { db: { value: db }, agreementId: { value: agreementId }, clientId: { value: clientId } } = fields;
  valid(uuid(agreementId) && uuid(clientId));
  let response;
  try { response = snapshot(await db.rpc('read_retail_existing_recurring_source',
    { p_agreement: agreementId.toLowerCase(), p_client: clientId.toLowerCase() })); }
  catch (_) { throw new SourceError(); }
  if (!response || response.error || !Object.hasOwn(response, 'data')) throw new SourceError();
  const source = response.data;
  valid(source && typeof source === 'object' && !Array.isArray(source)
    && Object.keys(source).length === KEYS.length && KEYS.every(key => Object.hasOwn(source, key))
    && source.version === 'retail_existing_recurring_source_v1' && source.agreement_id === agreementId.toLowerCase()
    && source.client_id === clientId.toLowerCase() && (source.source_intent_id === null || uuid(source.source_intent_id))
    && FLAGS.every(key => source[key] === false));
  try {
    // Solely reuses the existing pure tuple/calendar validator. This internal
    // stub is NOT a retrieved invoice or proof of a complete provider census.
    const p = source.original_period;
    inspectExistingRetailRecurringPeriods({ packageSnapshot: source.package_snapshot, originalPeriod: p,
      originalProviderAccountId: source.original_provider_account_id, providerAccountId: source.original_provider_account_id,
      invoices: { object: 'list', has_more: false, data: [{ object: 'invoice', id: p.invoice_id,
        billing_reason: 'subscription_create', currency: 'usd', livemode: p.livemode,
        customer: p.customer_id, subscription: p.subscription_id }] } });
    // Native receipt IDs use a total 255-char bound; preserve it here too.
    const generation=p.version==='retail_generation_initial_schedule_v1';
    const identityKeys=['invoice_id','subscription_id','subscription_item_id','customer_id','checkout_session_id',
      ...(generation?['initial_platform_invoice_line_id','recurring_invoice_line_id','initial_platform_price_id',
        'recurring_platform_price_id']:['platform_invoice_line_id','price_id'])];
    valid([source.original_provider_account_id,...identityKeys.map(key=>p[key]),
      ...(generation&&p.first_role_price_id!==null?[p.first_role_price_id]:[])].every(id=>typeof id==='string'&&id.length<=255));
  } catch (_) { throw new SourceError(true); }
  return freeze(source);
}
async function readExistingRetailRecurringSource(input) {
  try { return await read(input); } catch (error) {
    if (error instanceof SourceError) throw error;
    throw new SourceError(); // Never expose DB/native parser or dependency details.
  }
}
module.exports = { readExistingRetailRecurringSource };
