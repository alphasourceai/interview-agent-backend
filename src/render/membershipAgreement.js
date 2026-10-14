'use strict';

const fs = require('fs');
const path = require('path');
const Handlebars = require('handlebars');
const {readEnterprisePoolSnapshot,enterprisePoolCheckoutQuote}=require('../services/enterprisePoolSnapshot');
const {readRetailPackageOffer}=require('../services/membershipPackageCompatibility');
const {STRIPE_RECURRING_OFFER_VERSION}=require('../services/membershipOffers');

const templatePath = path.join(__dirname, '..', '..', 'templates', 'pdf', 'membership-agreement.hbs');
const templateSrc = fs.readFileSync(templatePath, 'utf8');
const template = Handlebars.compile(templateSrc);
// Regenerate earlier accepted agreements from their original body, never
// silently move their cancellation deadline to a different billing policy.
const nativeStripeTemplate=Handlebars.compile(fs.readFileSync(path.join(__dirname,'..','..','templates','pdf',
  'membership-agreement-native-stripe.hbs'),'utf8'));

const LOGO_FILENAME = 'No bg - color logo - dark text.png';

let cachedLogoSrc = null;
let triedLogoLoad = false;

function normalizeText(value) {
  return String(value || '').trim();
}

function normalizeTier(value) {
  const normalized = normalizeText(value).toLowerCase();
  if (normalized === 'pro') return 'pro';
  if (normalized === 'enterprise') return 'enterprise';
  return 'basic';
}

function normalizeBillingOption(value) {
  const normalized = normalizeText(value).toLowerCase();
  return normalized === 'annual' ? 'annual' : 'monthly';
}

function normalizeTermStartBasis(value) {
  const normalized = normalizeText(value).toLowerCase();
  return normalized === 'successful_payment' ? 'successful_payment' : 'agreement_date';
}

function normalizeAutoRenew(value) {
  if (typeof value === 'boolean') return value;
  const normalized = normalizeText(value).toLowerCase();
  if (!normalized) return true;
  return ['1', 'true', 'yes', 'y'].includes(normalized);
}

function normalizeNoticeDays(value) {
  const parsed = parseInt(String(value || '').trim(), 10);
  if (!Number.isFinite(parsed) || parsed < 1) return 30;
  return parsed;
}

function normalizeMoneyInput(value) {
  const raw = normalizeText(value).replace(/[$,\s]/g, '');
  if (!raw) return '';
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return '';
  return `${Math.round(parsed * 100) / 100}`;
}

function normalizeWholeNumberInput(value, { allowZero = false } = {}) {
  const raw = normalizeText(value);
  if (!raw) return '';
  const parsed = parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < (allowZero ? 0 : 1)) return '';
  return `${parsed}`;
}

// The first value the form actually sent. A numeric 0 is a value; an empty
// string is not. `||` reads 0 as absent, which is why an Enterprise agreement
// could not express a zero fee or "no included interviews per role" — both of
// which are legitimate settings, the second meaning the client runs on their
// pool and the meter alone.
function firstSupplied(...values) {
  for (const value of values) {
    if (value === null || value === undefined) continue;
    if (typeof value === 'string' && value.trim() === '') continue;
    return value;
  }
  return '';
}

function normalizeCentsInput(value) {
  const raw = normalizeText(value).replace(/[$,\s]/g, '');
  if (!raw) return null;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return Math.round(parsed);
}

function normalizeFirstRolePrepayInput(value) {
  const source = value && typeof value === 'object' ? value : null;
  if (!source) {
    return {
      present: false,
      selected: false,
      credit_type: 'first_role_prepay',
      normal_role_fee_cents: null,
      discounted_credit_amount_cents: null,
      discount_percent: null,
      non_refundable: true,
      expires: false
    };
  }
  return {
    present: true,
    selected: normalizeBooleanFlag(source.selected),
    credit_type: normalizeText(source.credit_type || source.creditType) || 'first_role_prepay',
    normal_role_fee_cents: normalizeCentsInput(source.normal_role_fee_cents || source.normalRoleFeeCents),
    discounted_credit_amount_cents: normalizeCentsInput(source.discounted_credit_amount_cents || source.discountedCreditAmountCents || source.amount_cents || source.amountCents),
    discount_percent: normalizeCentsInput(source.discount_percent || source.discountPercent),
    non_refundable: source.non_refundable === undefined && source.nonRefundable === undefined
      ? true
      : normalizeBooleanFlag(source.non_refundable ?? source.nonRefundable),
    expires: normalizeBooleanFlag(source.expires)
  };
}

function normalizeDateInput(value) {
  const raw = normalizeText(value);
  if (!raw) return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return '';
  const year = parsed.getUTCFullYear();
  const month = `${parsed.getUTCMonth() + 1}`.padStart(2, '0');
  const day = `${parsed.getUTCDate()}`.padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function formatDateShort(isoDate) {
  const raw = normalizeDateInput(isoDate);
  if (!raw) return '—';
  const [year, month, day] = raw.split('-');
  return `${month}/${day}/${year}`;
}

function formatDateLong(isoDate) {
  const raw = normalizeDateInput(isoDate);
  if (!raw) return '—';
  const [year, month, day] = raw.split('-');
  const parsed = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  if (Number.isNaN(parsed.getTime())) return '—';
  return parsed.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC'
  });
}

function titleCase(value) {
  const normalized = normalizeText(value).toLowerCase();
  if (!normalized) return '—';
  return normalized.charAt(0).toUpperCase() + normalized.slice(1);
}

function formatMembershipTier(value) {
  const normalized = normalizeTier(value);
  return normalized === 'basic' ? 'Essential' : titleCase(normalized);
}

function formatUsd(value) {
  const raw = normalizeText(value);
  if (!raw) return '—';
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return '—';
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }).format(parsed);
}

function formatUsdCents(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return '—';
  return formatUsd(parsed / 100);
}

function normalizeExecutionInput(input = {}) {
  const accepted = input.accepted === true;
  const signerTypedName = normalizeText(input.signer_typed_name || input.signerTypedName);
  const signedAtRaw = normalizeText(input.signed_at || input.signedAt);
  const signedAtNormalized = normalizeDateInput(signedAtRaw);
  const signatureImageSrc = normalizeSignatureImageSrc(input.signature_image_src || input.signatureImageSrc);
  return {
    accepted,
    signer_typed_name: signerTypedName,
    signed_at: signedAtNormalized,
    signature_image_src: signatureImageSrc
  };
}

function normalizeSignatureImageSrc(value) {
  const raw = normalizeText(value);
  if (!raw) return '';
  const match = raw.match(/^data:(image\/(?:png|jpeg|jpg|webp));base64,([a-z0-9+/=\s]+)$/i);
  if (!match) return '';
  const mime = String(match[1] || '').toLowerCase() === 'image/jpg' ? 'image/jpeg' : String(match[1] || '').toLowerCase();
  const base64 = String(match[2] || '').replace(/\s+/g, '');
  if (!base64) return '';
  return `data:${mime};base64,${base64}`;
}

function readLogoAsDataUri() {
  if (process.env.PDF_LOGO_DATA_URI) return String(process.env.PDF_LOGO_DATA_URI);
  if (triedLogoLoad) return cachedLogoSrc || '';
  triedLogoLoad = true;

  const candidates = [
    path.join(__dirname, '..', '..', 'templates', 'pdf', 'assets', LOGO_FILENAME),
    path.join(__dirname, '..', '..', 'templates', 'pdf', 'assets', 'logo.png')
  ];

  for (const logoPath of candidates) {
    try {
      if (fs.existsSync(logoPath)) {
        const base64 = fs.readFileSync(logoPath).toString('base64');
        cachedLogoSrc = `data:image/png;base64,${base64}`;
        return cachedLogoSrc;
      }
    } catch (_) {}
  }

  cachedLogoSrc = '';
  return '';
}

function retailAgreementMismatch() { const e=new Error('retail_agreement_terms_mismatch');e.code=e.message;e.status=409;throw e; }

function normalizeRetailAgreementInput(input, offer, normalized) {
  const supplied=(keys, expected, convert=value=>value)=>{
    for(const key of keys) if(Object.hasOwn(input,key) && input[key]!==undefined && convert(input[key])!==expected) retailAgreementMismatch();
  };
  const number=value=>typeof value==='number'?value:(typeof value==='string' && value.trim()!==''?Number(value.replace(/[$,\s]/g,'')):NaN);
  const cadence=offer.payment_option==='prepaid'?'prepaid':'monthly';
  supplied(['membership_tier','membershipTier'],offer.plan_key,value=>{
    const tier=normalizeText(value).toLowerCase();return tier==='essential'?'basic':tier;
  });
  supplied(['billing_option','billingOption'],cadence);
  supplied(['commitment_months','commitmentMonths'],offer.commitment_months,number);
  supplied(['payment_option','paymentOption'],offer.payment_option);
  supplied(['pricing_version','pricingVersion','offer_version','offerVersion'],offer.offer_version);
  supplied(['term_start_basis','termStartBasis'],'successful_payment',value=>value==='first_payment_success'?'successful_payment':value);
  supplied(['auto_renew','autoRenew'],true,value=>typeof value==='boolean'?value:
    (typeof value==='string' && ['1','true','yes','y'].includes(value.trim().toLowerCase())));
  for(const [keys,expected] of [
    [['platform_fee','platformFee','membership_fee','membershipFee'],offer.platform_payment_cents/100],
    [['per_role_fee','perRoleFee'],offer.per_role_fee_cents/100],
    [['additional_interview_fee','additionalInterviewFee'],offer.additional_interview_fee_cents/100],
    [['included_interviews_per_role','includedInterviewsPerRole'],offer.included_interviews_per_role],
    [['max_interview_minutes','maxInterviewMinutes','interview_duration_minutes','interviewDurationMinutes'],offer.max_interview_minutes],
    [['scored_question_count','scoredQuestionCount'],offer.scored_question_count]]) supplied(keys,expected,number);
  supplied(['billing_model','billingModel'],offer.billing_model);
  supplied(['rollover_days','rolloverDays'],offer.rollover_days,value=>value===null?null:number(value));
  for(const key of ['first_role_prepay','firstRolePrepay']) if(Object.hasOwn(input,key) && input[key]!==undefined) {
    const role=input[key];if(!role || typeof role!=='object')retailAgreementMismatch();
    const check=(keys,expected,convert=value=>value)=>{
      for(const field of keys)if(Object.hasOwn(role,field)&&convert(role[field])!==expected)retailAgreementMismatch();
    };
    check(['selected'],offer.first_role_prepay.selected);
    check(['normal_role_fee_cents','normalRoleFeeCents'],offer.per_role_fee_cents,number);
    check(['discounted_credit_amount_cents','discountedCreditAmountCents','amount_cents','amountCents'],offer.first_role_prepay.amount_cents,number);
    check(['credit_type','creditType'],'first_role_prepay');check(['non_refundable','nonRefundable'],true);check(['expires'],false);
    // Existing role-credit storage uses this compatibility constant. It is not
    // displayed as a historical discount calculation or used to price a role.
    check(['discount_percent','discountPercent'],10,number);
  }
  return {...normalized,membership_tier:offer.plan_key,billing_option:cadence,commitment_months:offer.commitment_months,
    payment_option:offer.payment_option,pricing_version:offer.offer_version,platform_fee:String(offer.platform_payment_cents/100),
    per_role_fee:String(offer.per_role_fee_cents/100),additional_interview_fee:String(offer.additional_interview_fee_cents/100),
    included_interviews_per_role:String(offer.included_interviews_per_role),max_interview_minutes:String(offer.max_interview_minutes),
    scored_question_count:String(offer.scored_question_count),billing_model:offer.billing_model,rollover_days:offer.rollover_days,
    initial_term_start:'',initial_renewal_date:'',term_start_basis:'successful_payment',auto_renew:offer.renewal.default_auto_renew,
    first_role_prepay:{present:true,selected:offer.first_role_prepay.selected,credit_type:'first_role_prepay',
      normal_role_fee_cents:offer.per_role_fee_cents,discounted_credit_amount_cents:offer.first_role_prepay.amount_cents,
      discount_percent:10,non_refundable:true,expires:false}};
}

function normalizeMembershipAgreementInput(input = {}, options = {}) {
  const retailOffer=readRetailPackageOffer(options.packageSnapshot);
  const poolOffer=readEnterprisePoolSnapshot(input);
  if(poolOffer){
    if(normalizeTier(input.membership_tier||input.membershipTier)!=='enterprise')throw new Error('invalid_enterprise_pool_snapshot');
    enterprisePoolCheckoutQuote(input);
  }
  const normalized = {
    client_id: normalizeText(input.client_id || input.clientId),
    client_legal_name: normalizeText(input.client_legal_name || input.clientLegalName),
    dba_trade_name: normalizeText(input.dba_trade_name || input.dbaTradeName),
    primary_admin_name: normalizeText(input.primary_admin_name || input.primaryAdmin),
    admin_email: normalizeText(input.admin_email || input.adminEmail).toLowerCase(),
    membership_tier: normalizeTier(input.membership_tier || input.membershipTier),
    // Coerced to a string through firstSupplied: normalizeText reads a numeric 0
    // as empty, and on Enterprise every one of these may legitimately be zero.
    platform_fee: normalizeMoneyInput(String(firstSupplied(input.platform_fee, input.platformFee, input.membership_fee, input.membershipFee))),
    per_role_fee: normalizeMoneyInput(String(firstSupplied(input.per_role_fee, input.perRoleFee))),
    additional_interview_fee: normalizeMoneyInput(String(firstSupplied(input.additional_interview_fee, input.additionalInterviewFee))),
    // Zero included interviews per role is a supported Enterprise setting: the
    // client is then billed from the pool and the meter from the first
    // interview.
    included_interviews_per_role: normalizeWholeNumberInput(
      String(firstSupplied(input.included_interviews_per_role, input.includedInterviewsPerRole)),
      { allowZero: true }
    ),
    // Coerced to a string first: normalizeText reads a numeric 0 as empty, and a
    // zero-cent usage price is a real price, not an absence.
    usage_interview_fee_cents: normalizeCentsInput(String(input.usage_interview_fee_cents ?? input.usageInterviewFeeCents ?? '')),
    // The block of interviews an Enterprise client buys at signup. Absent or
    // zero means no pool, which is a valid agreement. The discount and total are
    // priced by enterprisePoolPricing when the agreement is sent and carried
    // here, because this normalizer is synchronous and has no database.
    pool_quantity: normalizeWholeNumberInput(input.pool_quantity ?? input.poolQuantity),
    // Through firstSupplied like the fees: a 0% discount is a price, not an absence.
    pool_discount_pct: normalizeMoneyInput(String(firstSupplied(input.pool_discount_pct, input.poolDiscountPct))),
    // True only when the admin routes priced the pool from the bands themselves
    // (withPricedPool); checkout honours an agreed discount only then.
    pool_discount_priced: input.pool_discount_priced === true || String(input.pool_discount_priced) === 'true',
    pool_total_cents: normalizeCentsInput(String(input.pool_total_cents ?? input.poolTotalCents ?? '')),
    pool_offer_snapshot:poolOffer,
    pool_offer_digest:poolOffer?input.pool_offer_digest:null,
    max_interview_minutes: normalizeWholeNumberInput(input.max_interview_minutes || input.maxInterviewMinutes || input.interview_duration_minutes || input.interviewDurationMinutes),
    // Enterprise settings beyond the prices. Validated by enterpriseSettings.js
    // before an agreement is sent; empty means "use the plan default".
    scored_question_count: normalizeWholeNumberInput(input.scored_question_count || input.scoredQuestionCount),
    billing_model: normalizeText(input.billing_model || input.billingModel).toLowerCase(),
    rollover_days: normalizeWholeNumberInput(input.rollover_days || input.rolloverDays),
    first_role_prepay: normalizeFirstRolePrepayInput(input.first_role_prepay || input.firstRolePrepay),
    initial_term_start: normalizeDateInput(input.initial_term_start || input.initialTermStart),
    initial_renewal_date: normalizeDateInput(input.initial_renewal_date || input.initialRenewalDate),
    agreement_expires_at: normalizeText(input.agreement_expires_at || input.agreementExpiresAt),
    term_start_basis: normalizeTermStartBasis(input.term_start_basis || input.termStartBasis),
    billing_option: normalizeBillingOption(input.billing_option || input.billingOption),
    auto_renew: normalizeAutoRenew(input.auto_renew ?? input.autoRenew),
    notice_deadline_days: normalizeNoticeDays(input.notice_deadline_days || input.noticeDeadlineDays)
  };
  return retailOffer?normalizeRetailAgreementInput(input,retailOffer,normalized):normalized;
}

const ENTERPRISE_BILLING_MODEL_WORDS = Object.freeze({
  usage: Object.freeze({
    label: 'Usage',
    description: 'Interviews beyond the included count per role, and beyond any interview pool, are billed per interview.'
  }),
  rollover: Object.freeze({
    label: 'Rollover',
    description: 'When a role closes, its unused included interviews become client credit, usable on any role until the credit expires.'
  }),
  fixed: Object.freeze({
    label: 'Fixed',
    description: 'Each role has its included interviews; unused interviews lapse when the role closes.'
  })
});

const USAGE_BILLING_SCHEDULE = 'Usage is billed monthly, on the 1st of each month, for the previous calendar month.';

function dollarsToCents(value) {
  const raw = normalizeText(value);
  if (!raw) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? Math.round(parsed * 100) : null;
}

// formatUsdCents passes a number to formatUsd, which reads a numeric 0 as empty;
// on an Enterprise agreement a zero fee is a real term and prints as $0.00.
function formatTermCents(cents) {
  return cents == null ? '—' : formatUsd(String(cents / 100));
}

function wholeOrNull(value) {
  const parsed = Number(normalizeText(String(value ?? '')));
  return normalizeText(String(value ?? '')) && Number.isInteger(parsed) ? parsed : null;
}

/**
 * The commercial terms of an Enterprise agreement, read from the agreement's own
 * values — the same normalized values checkout sends to Stripe — so what the
 * agreement shows is what is charged. Null for any other tier.
 *
 * `rows` is what the agreement prints, in order. A row is left out only when its
 * setting does not apply to the billing model.
 */
function buildEnterpriseCommercialTerms(normalized = {}) {
  if (normalized.membership_tier !== 'enterprise') return null;
  // Required lazily: the renderer is loaded by routes that never reach Enterprise.
  const { PLAN_CAPACITY } = require('../services/planCapacity');
  const { DEFAULT_ROLLOVER_DAYS, defaultBillingModelForPlanTier } = require('../services/billingModel');

  // The model to print: the one the agreement states, else the tier's.
  const statedModel = normalized.billing_model;
  const billingModel = ENTERPRISE_BILLING_MODEL_WORDS[statedModel] ? statedModel : defaultBillingModelForPlanTier('enterprise');
  const isUsage = billingModel === 'usage';
  const annual = normalized.billing_option === 'annual';
  const poolQuantity = wholeOrNull(normalized.pool_quantity);
  const hasPool = isUsage && poolQuantity !== null && poolQuantity > 0;

  const terms = {
    billing_model: billingModel,
    billing_interval: annual ? 'annual' : 'monthly',
    platform_fee_cents: dollarsToCents(normalized.platform_fee),
    per_role_fee_cents: dollarsToCents(normalized.per_role_fee),
    included_interviews_per_role: wholeOrNull(normalized.included_interviews_per_role),
    usage_interview_fee_cents: isUsage ? (normalized.usage_interview_fee_cents ?? null) : null,
    additional_interview_fee_cents: isUsage ? null : dollarsToCents(normalized.additional_interview_fee),
    pool: hasPool
      ? {
          quantity: poolQuantity,
          discount_pct: normalizeText(normalized.pool_discount_pct) === '' ? null : Number(normalized.pool_discount_pct),
          total_cents: normalized.pool_total_cents ?? null
        }
      : null,
    rollover_days: billingModel === 'rollover'
      ? (wholeOrNull(normalized.rollover_days) ?? DEFAULT_ROLLOVER_DAYS)
      : null,
    max_interview_minutes: wholeOrNull(normalized.max_interview_minutes) ?? PLAN_CAPACITY.enterprise.max_interview_minutes,
    scored_question_count: wholeOrNull(normalized.scored_question_count) ?? PLAN_CAPACITY.enterprise.scored_question_count,
    usage_billing_schedule: isUsage ? USAGE_BILLING_SCHEDULE : null
  };

  const words = ENTERPRISE_BILLING_MODEL_WORDS[billingModel];
  const rows = [
    { label: 'Platform Fee', value: `${formatTermCents(terms.platform_fee_cents)} ${annual ? 'per year' : 'per month'}` },
    { label: 'Billing Interval', value: annual ? 'Annual' : 'Monthly' },
    { label: 'Per-Role Fee', value: formatTermCents(terms.per_role_fee_cents) },
    { label: 'Included Interviews (Per Role)', value: String(terms.included_interviews_per_role ?? '—') },
    { label: 'Billing Model', value: words.label, note: words.description }
  ];
  if (isUsage) {
    rows.push({
      label: 'Per-Interview Usage Price',
      value: terms.usage_interview_fee_cents == null ? '—' : `${formatTermCents(terms.usage_interview_fee_cents)} per interview`
    });
  } else {
    rows.push({ label: 'Additional Interview Fee', value: formatTermCents(terms.additional_interview_fee_cents) });
  }
  if (terms.pool) {
    const snapshot=readEnterprisePoolSnapshot(normalized);
    if(snapshot){
      rows.push({label:'Interview Pool',value:`${snapshot.quantity} interviews`,note:'Bought at signup; used before any interview is billed as usage.'},
        {label:'Pool Gross',value:formatTermCents(snapshot.gross_cents)},
        {label:'Pool Volume Discount',value:`${snapshot.automatic_discount_percent}% (${formatTermCents(snapshot.automatic_discount_cents)})`},
        {label:'Pool Coupon',value:formatTermCents(snapshot.coupon_cents)},
        {label:'Pool Total',value:`${formatTermCents(snapshot.net_cents)}, charged at signup`});
    }else{
    rows.push(
      { label: 'Interview Pool', value: `${terms.pool.quantity} interviews`, note: 'Bought at signup; used before any interview is billed as usage.' },
      { label: 'Pool Discount', value: terms.pool.discount_pct == null ? '—' : `${terms.pool.discount_pct}%` },
      { label: 'Pool Total', value: terms.pool.total_cents == null ? '—' : `${formatTermCents(terms.pool.total_cents)}, charged at signup` }
    );
    }
  }
  if (terms.rollover_days !== null) {
    rows.push({ label: 'Rollover Credit', value: `${terms.rollover_days} days`, note: 'How long credit from a closed role stays usable.' });
  }
  rows.push(
    { label: 'Interview Length', value: `${terms.max_interview_minutes} minutes` },
    { label: 'Scored Questions', value: `${terms.scored_question_count} per interview` }
  );

  return { ...terms, rows };
}

function normalizeBooleanFlag(value) {
  if (value === true) return true;
  if (value === false || value === null || value === undefined) return false;
  const normalized = String(value).trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

function shouldShowPackageTerms(payload, options) {
  return normalizeBooleanFlag(
    options.showPackageTerms ??
      options.show_package_terms ??
      payload.showPackageTerms ??
      payload.show_package_terms ??
      payload.renderPackageTerms ??
      payload.render_package_terms
  );
}

function buildMembershipAgreementHtml(payload = {}, options = {}) {
  const retailOffer=readRetailPackageOffer(options.packageSnapshot);
  const normalized = normalizeMembershipAgreementInput(payload,options);
  const execution = normalizeExecutionInput(options.execution || payload.execution || {});
  const showPackageTerms = !!retailOffer || shouldShowPackageTerms(payload, options);
  const now = options.generatedAt ? new Date(options.generatedAt) : new Date();
  const displayTimeZone = normalizeText(options.timeZone || options.time_zone) || undefined;
  const generatedAtIso = now.toISOString();
  const generatedAtLabel = now.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    ...(displayTimeZone ? { timeZone: displayTimeZone } : {})
  });
  const agreementExpiresAt = normalized.agreement_expires_at ? new Date(normalized.agreement_expires_at) : null;
  const agreementExpiresAtLabel = agreementExpiresAt && Number.isFinite(agreementExpiresAt.getTime())
    ? new Date(agreementExpiresAt.getTime() - 1).toLocaleString('en-US', {
        year: 'numeric', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit',
        timeZoneName: 'short', ...(displayTimeZone ? { timeZone: displayTimeZone } : {})
      })
    : '';

  const enterpriseTerms = buildEnterpriseCommercialTerms(normalized);
  const renderData = {
    retail_terms:retailOffer?{commitment_months:retailOffer.commitment_months,
      is_installments:retailOffer.payment_option==='monthly_installments',installment_count:retailOffer.installment_count,
      platform_payment:formatUsdCents(retailOffer.platform_payment_cents),commitment_total:formatUsdCents(retailOffer.platform_commitment_total_cents),
      initial_amount:formatUsdCents(retailOffer.initial_payment_cents),scored_question_count:retailOffer.scored_question_count,
      reminder_days:retailOffer.renewal.reminder_days,rollover_days:retailOffer.rollover_days}:null,
    logo_src: readLogoAsDataUri(),
    generated_at: generatedAtIso,
    generated_at_label: generatedAtLabel,
    agreement_expires_at_label: agreementExpiresAtLabel,
    client_legal_name: normalized.client_legal_name || '______________________________',
    dba_trade_name: normalized.dba_trade_name || '______________________________',
    primary_admin_name: normalized.primary_admin_name || '______________________________',
    admin_email: normalized.admin_email || '______________________________',
    membership_tier: formatMembershipTier(normalized.membership_tier),
    is_enterprise: normalized.membership_tier === 'enterprise',
    show_package_terms: showPackageTerms,
    // An Enterprise agreement always shows its own terms, in place of the
    // package table, whatever the flag says. Every other tier is unchanged.
    enterprise_terms: enterpriseTerms,
    show_standard_package_terms: showPackageTerms && !enterpriseTerms,
    show_package_page: showPackageTerms || !!enterpriseTerms,
    package_platform_fee: formatUsd(normalized.platform_fee),
    package_per_role_fee: formatUsd(normalized.per_role_fee),
    package_additional_interview_fee: formatUsd(normalized.additional_interview_fee),
    package_included_interviews_per_role: normalized.included_interviews_per_role || '—',
    package_max_interview_minutes: normalized.max_interview_minutes || '—',
    package_fee_period_label: retailOffer?(retailOffer.payment_option==='prepaid'?`full ${retailOffer.commitment_months}-month term`:'per monthly installment'):
      normalized.billing_option === 'annual' ? 'per year' : 'per month',
    show_first_role_prepay_terms: showPackageTerms && normalized.first_role_prepay.present,
    first_role_prepay_selected: normalized.first_role_prepay.selected,
    first_role_prepay_amount: formatUsdCents(normalized.first_role_prepay.discounted_credit_amount_cents),
    first_role_normal_role_fee: formatUsdCents(normalized.first_role_prepay.normal_role_fee_cents),
    first_role_prepay_discount_percent: normalized.first_role_prepay.discount_percent || '10',
    initial_term_start_display: formatDateShort(normalized.initial_term_start),
    initial_renewal_date_display: formatDateShort(normalized.initial_renewal_date),
    term_starts_on_payment: normalized.term_start_basis === 'successful_payment',
    billing_option: retailOffer?(retailOffer.payment_option==='prepaid'?'Prepaid':`${retailOffer.installment_count} Monthly Installments`):
      normalized.billing_option === 'annual' ? 'Annual' : 'Monthly',
    auto_renew: normalized.auto_renew ? 'Yes' : 'No',
    notice_deadline_days: `${normalized.notice_deadline_days} Days`,
    notice_deadline_plain: `${normalized.notice_deadline_days}`,
    initial_term_start_long: formatDateLong(normalized.initial_term_start),
    initial_renewal_date_long: formatDateLong(normalized.initial_renewal_date),
    ack_checkbox_symbol: execution.accepted ? '☑' : '☐',
    acceptance_checkbox_symbol: execution.accepted ? '☑' : '☐',
    signer_name_line: execution.signer_typed_name || '______________________________',
    signer_date_line: execution.signed_at ? formatDateLong(execution.signed_at) : '______________________________',
    signature_image_src: execution.signature_image_src || '',
    execution_completed_label: execution.signed_at
      ? `Signed on ${formatDateLong(execution.signed_at)}`
      : ''
  };

  return {
    html: (retailOffer?.offer_version===STRIPE_RECURRING_OFFER_VERSION?nativeStripeTemplate:template)(renderData),
    normalized,
    commercial_terms: enterpriseTerms
  };
}

module.exports = {
  USAGE_BILLING_SCHEDULE,
  buildEnterpriseCommercialTerms,
  buildMembershipAgreementHtml,
  normalizeMembershipAgreementInput
};
