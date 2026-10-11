'use strict';

// Prospective, UNMOUNTED quote boundary. This is not a signing/checkout API.
// authorizeScope is a trusted server adapter, never a body/user_metadata claim.
// It must verify an authenticated role or anonymous prospect capability, active
// rep, billing ownership and a stable prospective scope association. No default
// adapter is provided until the actual signup/signing flow has been reviewed.
const crypto = require('node:crypto');
const { OFFER_VERSION, buildRetailOffer, listRetailOffers } = require('./membershipOffers');

const TEMPLATE_VERSION = 'retail-agreement-2026-10-11-draft-v1';
const QUOTE_LIFETIME_MS = 30 * 60 * 1000;
const TABLE = 'membership_v2_quote_drafts';
const COLUMNS = 'id,scope_id,audience,issuer_user_id,original_salesperson_user_id,client_id,billing_owner_user_id,offer_snapshot,template_version,template_status,issued_at,expires_at,canonical_quote,quote_digest';
const UUID = /^(?!00000000-0000-0000-0000-000000000000$)[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CONTEXT_KEYS = ['scope_id','audience','issuer_user_id','original_salesperson_user_id','client_id','billing_owner_user_id'];
const SELECTION_KEYS = ['planKey','commitmentMonths','paymentOption','offerVersion','firstRolePrepaySelected'];
const DEFAULT_CATALOG = Object.freeze({currentVersion:() => OFFER_VERSION,
  resolveOffer:(choice,channel) => buildRetailOffer({...choice,channel}),
  listOffers:channel => listRetailOffers({channel})});

function fail(code, status = 409) {
  const error = new Error(code); error.code = code; error.status = status; throw error;
}
function requireThat(value, code, status) { if (!value) fail(code, status); }
function uuid(value) { return typeof value === 'string' && UUID.test(value); }
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key =>
    `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
function digest(text) { return crypto.createHash('sha256').update(text,'utf8').digest('hex'); }
function freeze(value) {
  if (value && typeof value === 'object') { for (const item of Object.values(value)) freeze(item); Object.freeze(value); }
  return value;
}
function context(value) {
  requireThat(value && typeof value === 'object' && !Array.isArray(value), 'quote_scope_denied', 403);
  const result = Object.fromEntries(CONTEXT_KEYS.map(key => [key, value[key]]));
  requireThat(uuid(result.scope_id) && ['public','sales','admin'].includes(result.audience), 'quote_scope_denied',403);
  for (const key of CONTEXT_KEYS.filter(key => !['scope_id','audience'].includes(key))) {
    requireThat(result[key] === null || uuid(result[key]), 'quote_scope_denied',403);
  }
  requireThat((result.client_id === null) === (result.billing_owner_user_id === null), 'quote_scope_denied',403);
  requireThat(result.audience === 'public'
    ? result.issuer_user_id === null && result.original_salesperson_user_id === null && result.client_id === null
    : result.issuer_user_id !== null && (result.audience !== 'sales'
      || result.original_salesperson_user_id === result.issuer_user_id), 'quote_scope_denied',403);
  return freeze(result);
}
function strictInstant(value) {
  requireThat(typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    && value.slice(0,4) !== '0000' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value, 'invalid_quote_clock');
  return value;
}
function storedInstant(value) {
  // PostgREST returns timestamptz with an offset rather than JS ISO spelling.
  requireThat(typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
    && Number.isFinite(Date.parse(value)), 'invalid_quote_readback');
  return strictInstant(new Date(value).toISOString());
}
function selection(value) {
  requireThat(value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).every(key => SELECTION_KEYS.includes(key)), 'invalid_quote_selection',400);
  return Object.fromEntries(SELECTION_KEYS.filter(key => Object.hasOwn(value,key)).map(key => [key,value[key]]));
}
function documentFromRow(row) {
  return { schema_version:2, protocol:'retail_quote_draft_v2', quote_id:row.id,
    acceptance_state:'unsigned',signing_source_bound:false,
    ...context(row), offer:row.offer_snapshot, template_version:row.template_version,
    template_status:row.template_status, issued_at:storedInstant(row.issued_at), expires_at:storedInstant(row.expires_at) };
}
function validOffer(offer) {
  const integer = n => Number.isSafeInteger(n) && n >= 0;
  requireThat(offer && offer.schema_version === 2 && typeof offer.offer_version === 'string'
    && offer.offer_version.length >= 1 && offer.offer_version.length <= 100
    && typeof offer.offer_key === 'string' && offer.offer_key.length >= 1 && offer.offer_key.length <= 100
    && typeof offer.display_name === 'string' && offer.display_name.length >= 1 && offer.display_name.length <= 100
    && ['basic','pro'].includes(offer.plan_key) && offer.currency === 'usd'
    && offer.term_start_basis === 'first_payment_success' && offer.contract_timezone === 'UTC'
    && [3,6,12].includes(offer.commitment_months)
    && ['prepaid','monthly_installments'].includes(offer.payment_option), 'invalid_quote_readback');
  const installments = offer.payment_option === 'monthly_installments';
  const role = offer.first_role_prepay, renewal = offer.renewal;
  requireThat(['platform_payment_cents','platform_commitment_total_cents','initial_payment_cents',
    'per_role_fee_cents','additional_interview_fee_cents','included_interviews_per_role','max_interview_minutes',
    'scored_question_count'].every(key => integer(offer[key]))
    && offer.platform_payment_cents > 0 && offer.per_role_fee_cents > 0 && offer.additional_interview_fee_cents > 0
    && offer.included_interviews_per_role > 0 && offer.max_interview_minutes >= 5 && offer.max_interview_minutes <= 59
    && offer.scored_question_count >= 1 && offer.scored_question_count <= 7
    && offer.installment_count === (installments ? offer.commitment_months : 1)
    && offer.platform_commitment_total_cents === offer.platform_payment_cents * offer.installment_count
    && offer.stripe_recurrence?.interval === 'month'
    && offer.stripe_recurrence.interval_count === (installments ? 1 : offer.commitment_months)
    && role && typeof role.selected === 'boolean' && integer(role.amount_cents)
    && (role.selected ? role.amount_cents > 0 : role.amount_cents === 0)
    && role.normal_role_fee_cents === offer.per_role_fee_cents && role.credit_type === 'first_role_prepay'
    && role.expires === false && role.non_refundable === true
    && offer.initial_payment_cents === offer.platform_payment_cents + role.amount_cents
    && ((offer.billing_model === 'fixed' && offer.rollover_days === null)
      || (offer.billing_model === 'rollover' && integer(offer.rollover_days) && offer.rollover_days >= 1 && offer.rollover_days <= 3650))
    && renewal?.default_auto_renew === true && renewal.commitment_months === offer.commitment_months
    && renewal.retain_accepted_pricing === true && renewal.reminder_days === 30
    && renewal.non_renewal_cutoff === 'before_term_end' && renewal.ends_installments_early === false, 'invalid_quote_readback');
}
function validateRow(row, authorized) {
  requireThat(row && uuid(row.id), 'invalid_quote_readback');
  const doc = documentFromRow(row);
  requireThat(CONTEXT_KEYS.every(key => doc[key] === authorized[key]), 'quote_scope_denied',403);
  validOffer(doc.offer);
  requireThat(doc.audience !== 'public' || doc.offer.payment_option === 'prepaid', 'invalid_quote_readback');
  requireThat(doc.template_version === TEMPLATE_VERSION && doc.template_status === 'draft_only'
    && Date.parse(doc.expires_at) - Date.parse(doc.issued_at) === QUOTE_LIFETIME_MS
    && typeof row.canonical_quote === 'string' && Buffer.byteLength(row.canonical_quote,'utf8') <= 16000
    && row.canonical_quote === canonical(doc)
    && typeof row.quote_digest === 'string' && /^[0-9a-f]{64}$/.test(row.quote_digest)
    && digest(row.canonical_quote) === row.quote_digest, 'invalid_quote_readback');
  return doc;
}

function createMembershipQuoteDraftService({ db, authorizeScope, catalog = DEFAULT_CATALOG,
  agreement = () => ({version:TEMPLATE_VERSION,publication:'draft_only'}),
  now = () => new Date().toISOString(), newId = () => crypto.randomUUID() } = {}) {
  requireThat(db && typeof db.from === 'function' && typeof authorizeScope === 'function', 'quote_service_not_configured',503);
  requireThat(typeof catalog?.currentVersion === 'function' && typeof catalog.resolveOffer === 'function'
    && typeof catalog.listOffers === 'function' && typeof agreement === 'function', 'quote_service_not_configured',503);
  function resolve(choice,channel) {
    let offer, descriptor, version;
    try {
      offer = structuredClone(catalog.resolveOffer(choice,channel)); descriptor = structuredClone(agreement());
      version = catalog.currentVersion();
    } catch (error) {
      if (['stale_offer_version','public_installments_not_available','invalid_retail_plan','invalid_commitment_months',
        'invalid_payment_option','invalid_first_role_selection'].includes(error?.code)) fail(error.code,400);
      fail('quote_catalog_unavailable',503);
    }
    requireThat(version === choice.offerVersion && offer?.offer_version === version, 'stale_offer_version',400);
    validOffer(offer);
    const selectedPlan = typeof choice.planKey === 'string' ? choice.planKey.trim().toLowerCase() : '';
    requireThat(offer.plan_key === (selectedPlan === 'essential' ? 'basic' : selectedPlan)
      && offer.commitment_months === Number(choice.commitmentMonths) && offer.payment_option === choice.paymentOption
      && offer.first_role_prepay.selected === (choice.firstRolePrepaySelected === true), 'quote_selection_conflict');
    requireThat(channel !== 'public' || offer.payment_option === 'prepaid', 'public_installments_not_available',400);
    requireThat(descriptor?.version === TEMPLATE_VERSION && descriptor.publication === 'draft_only', 'quote_template_unavailable',503);
    return freeze({offer,descriptor,version});
  }
  async function authorize(subject) {
    try { return context(await authorizeScope(subject)); } catch (_) { fail('quote_scope_denied',403); }
  }
  function currentVersion() {
    let version; try { version = catalog.currentVersion(); } catch (_) { fail('quote_catalog_unavailable',503); }
    requireThat(typeof version === 'string' && version.length >= 1 && version.length <= 100, 'quote_catalog_unavailable',503);
    return version;
  }
  async function read(id, scope) {
    let result;
    try {
      let query = db.from(TABLE).select(COLUMNS).eq('id',id);
      for (const key of CONTEXT_KEYS) query = scope[key] === null ? query.is(key,null) : query.eq(key,scope[key]);
      result = await query.maybeSingle();
    }
    catch (_) { fail('quote_store_unavailable',503); }
    if (result?.error) fail('quote_store_unavailable',503);
    return result?.data || null;
  }
  function response(row, scope, clock) {
    const doc = validateRow(row,scope);
    requireThat(Date.parse(doc.issued_at) <= Date.parse(clock), 'invalid_quote_readback');
    // Informational flags only, not permission to sign. Accepted contracts will
    // read their own frozen acceptance and must not use current catalog prices.
    return freeze({ quote:doc, quote_digest:row.quote_digest,
      expired:Date.parse(clock) >= Date.parse(doc.expires_at), stale:doc.offer.offer_version !== currentVersion(),
      signing_enabled:false });
  }
  return Object.freeze({
    async listOffers(subject) {
      const scope = await authorize(subject);let offers;
      try { offers = structuredClone(catalog.listOffers(scope.audience)); } catch (_) { fail('quote_catalog_unavailable',503); }
      requireThat(Array.isArray(offers) && offers.length === (scope.audience === 'public' ? 6 : 12), 'quote_catalog_unavailable',503);
      for (const offer of offers) {
        validOffer(offer);requireThat(offer.offer_version === currentVersion()
          && (scope.audience !== 'public' || offer.payment_option === 'prepaid'), 'quote_catalog_unavailable',503);
      }
      requireThat(new Set(offers.map(o=>`${o.plan_key}:${o.commitment_months}:${o.payment_option}`)).size === offers.length,
        'quote_catalog_unavailable',503);
      return freeze(offers);
    },
    async createQuote(subject, input) {
      const scope = await authorize(subject);
      const choice = selection(input);
      const first = resolve(choice,scope.audience); const {offer} = first;
      const issuedAt = strictInstant(now()); const id = newId();
      requireThat(uuid(id), 'invalid_quote_id',503);
      requireThat(Date.parse(issuedAt) + QUOTE_LIFETIME_MS <= Date.parse('9999-12-31T23:59:59.999Z'), 'invalid_quote_clock');
      const expiresAt = strictInstant(new Date(Date.parse(issuedAt) + QUOTE_LIFETIME_MS).toISOString());
      const document = freeze({schema_version:2,protocol:'retail_quote_draft_v2',quote_id:id,...scope,
        acceptance_state:'unsigned',signing_source_bound:false,
        offer,template_version:TEMPLATE_VERSION,template_status:'draft_only',issued_at:issuedAt,expires_at:expiresAt});
      const row = {id,...scope,offer_snapshot:offer,template_version:TEMPLATE_VERSION,template_status:'draft_only',
        issued_at:issuedAt,expires_at:expiresAt,canonical_quote:canonical(document)};
      row.quote_digest = digest(row.canonical_quote);
      const fresh = await authorize(subject); const beforeWrite = strictInstant(now());
      requireThat(CONTEXT_KEYS.every(key => scope[key] === fresh[key]), 'quote_scope_changed',403);
      requireThat(canonical(resolve(choice,scope.audience)) === canonical(first), 'quote_catalog_changed');
      requireThat(Date.parse(beforeWrite) >= Date.parse(issuedAt) && Date.parse(beforeWrite) < Date.parse(expiresAt), 'quote_expired');
      // INSERT acknowledgment is not proof of persistence. For a lost reply,
      // reconcile this same generated ID; no second insert/effect is attempted.
      let insertion;
      try { insertion = await db.from(TABLE).insert(row); } catch (error) {
        if (typeof error?.code === 'string' && (/^[0-9A-Z]{5}$/.test(error.code) || error.code.startsWith('PGRST'))) {
          fail('quote_create_failed',503);
        }
        // Unknown transport outcome: one scoped read below. No second INSERT.
      }
      if (insertion?.error) fail('quote_create_failed',503);
      const after = await authorize(subject);
      requireThat(CONTEXT_KEYS.every(key => scope[key] === after[key]), 'quote_scope_changed',403);
      const stored = await read(id,after);
      requireThat(stored, 'quote_create_unverified',503);
      const result = response(stored,after,strictInstant(now()));
      requireThat(result.quote_digest === row.quote_digest && stored.canonical_quote === row.canonical_quote, 'quote_create_conflict');
      return result;
    },
    async readQuote(subject,id) {
      const scope = await authorize(subject);
      requireThat(uuid(id), 'invalid_quote_id',400);
      const row = await read(id,scope);
      if (!row) fail('quote_not_found',404);
      requireThat(row.id === id, 'invalid_quote_readback');
      const fresh = await authorize(subject);
      requireThat(CONTEXT_KEYS.every(key => scope[key] === fresh[key]), 'quote_scope_changed',403);
      return response(row,fresh,strictInstant(now()));
    }
  });
}

module.exports = { TEMPLATE_VERSION, QUOTE_LIFETIME_MS, createMembershipQuoteDraftService };
