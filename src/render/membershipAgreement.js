'use strict';

const fs = require('fs');
const path = require('path');
const Handlebars = require('handlebars');

const templatePath = path.join(__dirname, '..', '..', 'templates', 'pdf', 'membership-agreement.hbs');
const templateSrc = fs.readFileSync(templatePath, 'utf8');
const template = Handlebars.compile(templateSrc);

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

function normalizeMembershipAgreementInput(input = {}) {
  return {
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
    pool_discount_pct: normalizeMoneyInput(input.pool_discount_pct ?? input.poolDiscountPct),
    pool_total_cents: normalizeCentsInput(String(input.pool_total_cents ?? input.poolTotalCents ?? '')),
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
  const normalized = normalizeMembershipAgreementInput(payload);
  const execution = normalizeExecutionInput(options.execution || payload.execution || {});
  const showPackageTerms = shouldShowPackageTerms(payload, options);
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

  const renderData = {
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
    package_platform_fee: formatUsd(normalized.platform_fee),
    package_per_role_fee: formatUsd(normalized.per_role_fee),
    package_additional_interview_fee: formatUsd(normalized.additional_interview_fee),
    package_included_interviews_per_role: normalized.included_interviews_per_role || '—',
    // The Enterprise interview pool bought at signup, and the price every
    // interview beyond it is charged at.
    show_interview_pool_terms: showPackageTerms
      && normalized.membership_tier === 'enterprise'
      && !!normalized.pool_quantity,
    package_pool_quantity: normalized.pool_quantity || '—',
    package_pool_discount_pct: normalized.pool_discount_pct
      ? `${normalized.pool_discount_pct}%`
      : '0%',
    package_pool_total: normalized.pool_total_cents == null
      ? '—'
      : formatUsdCents(normalized.pool_total_cents),
    package_usage_interview_fee: normalized.usage_interview_fee_cents == null
      ? '—'
      : formatUsdCents(normalized.usage_interview_fee_cents),
    package_max_interview_minutes: normalized.max_interview_minutes || '—',
    package_fee_period_label: normalized.billing_option === 'annual' ? 'per year' : 'per month',
    show_first_role_prepay_terms: showPackageTerms && normalized.first_role_prepay.present,
    first_role_prepay_selected: normalized.first_role_prepay.selected,
    first_role_prepay_amount: formatUsdCents(normalized.first_role_prepay.discounted_credit_amount_cents),
    first_role_normal_role_fee: formatUsdCents(normalized.first_role_prepay.normal_role_fee_cents),
    first_role_prepay_discount_percent: normalized.first_role_prepay.discount_percent || '10',
    initial_term_start_display: formatDateShort(normalized.initial_term_start),
    initial_renewal_date_display: formatDateShort(normalized.initial_renewal_date),
    term_starts_on_payment: normalized.term_start_basis === 'successful_payment',
    billing_option: normalized.billing_option === 'annual' ? 'Annual' : 'Monthly',
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
    html: template(renderData),
    normalized
  };
}

module.exports = {
  buildMembershipAgreementHtml,
  normalizeMembershipAgreementInput
};
