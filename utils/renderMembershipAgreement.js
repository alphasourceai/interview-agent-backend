'use strict';

const fs = require('fs');
const path = require('path');
const Handlebars = require('handlebars');

const templatePath = path.join(__dirname, '..', 'templates', 'pdf', 'membership-agreement.hbs');
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

function normalizeWholeNumberInput(value) {
  const raw = normalizeText(value);
  if (!raw) return '';
  const parsed = parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return '';
  return `${parsed}`;
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
    path.join(__dirname, '..', 'templates', 'pdf', 'assets', LOGO_FILENAME),
    path.join(__dirname, '..', 'templates', 'pdf', 'assets', 'logo.png')
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
    platform_fee: normalizeMoneyInput(input.platform_fee || input.platformFee || input.membership_fee || input.membershipFee),
    per_role_fee: normalizeMoneyInput(input.per_role_fee || input.perRoleFee),
    additional_interview_fee: normalizeMoneyInput(input.additional_interview_fee || input.additionalInterviewFee),
    included_interviews_per_role: normalizeWholeNumberInput(input.included_interviews_per_role || input.includedInterviewsPerRole),
    initial_term_start: normalizeDateInput(input.initial_term_start || input.initialTermStart),
    initial_renewal_date: normalizeDateInput(input.initial_renewal_date || input.initialRenewalDate),
    billing_option: normalizeBillingOption(input.billing_option || input.billingOption),
    auto_renew: normalizeAutoRenew(input.auto_renew ?? input.autoRenew),
    notice_deadline_days: normalizeNoticeDays(input.notice_deadline_days || input.noticeDeadlineDays)
  };
}

function buildMembershipAgreementHtml(payload = {}, options = {}) {
  const normalized = normalizeMembershipAgreementInput(payload);
  const execution = normalizeExecutionInput(options.execution || payload.execution || {});
  const now = new Date();
  const generatedAtIso = now.toISOString();
  const generatedAtLabel = now.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric'
  });

  const renderData = {
    logo_src: readLogoAsDataUri(),
    generated_at: generatedAtIso,
    generated_at_label: generatedAtLabel,
    client_legal_name: normalized.client_legal_name || '______________________________',
    dba_trade_name: normalized.dba_trade_name || '______________________________',
    primary_admin_name: normalized.primary_admin_name || '______________________________',
    admin_email: normalized.admin_email || '______________________________',
    membership_tier: titleCase(normalized.membership_tier),
    is_enterprise: normalized.membership_tier === 'enterprise',
    enterprise_platform_fee: formatUsd(normalized.platform_fee),
    enterprise_per_role_fee: formatUsd(normalized.per_role_fee),
    enterprise_additional_interview_fee: formatUsd(normalized.additional_interview_fee),
    enterprise_included_interviews_per_role: normalized.included_interviews_per_role || '—',
    enterprise_fee_period_label: normalized.billing_option === 'annual' ? 'per year' : 'per month',
    initial_term_start_display: formatDateShort(normalized.initial_term_start),
    initial_renewal_date_display: formatDateShort(normalized.initial_renewal_date),
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
