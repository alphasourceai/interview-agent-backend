'use strict';

const DEV_SERVICE_ID = 'srv-db5bfjlckfvc739klcvg';
const OLD_DEV_SERVICE_ID = 'srv-dalm95942hec73cvjbv0';
const DEV_DATABASE_URL = 'https://hjombgfusdgsqipimhnc.supabase.co';
const DEV_FRONTEND_URL = 'https://interview-agent-frontend-qa.onrender.com';
const CODE = 'GUARDED_DEV_BILLING_HOLD';
const DETAIL = 'This dev build supports pricing and agreement previews. Payments, renewals, usage collection, sending and signing are not available yet.';
const OFF_FLAGS = Object.freeze([
  'ENTERPRISE_MONTHLY_USAGE_ENABLED',
  'SALES_TEAM_PROVIDER_SYNC_ENABLED', 'GHL_SALES_SYNC_ENABLED',
  'SALES_VOICE_HANDOFF_ENABLED', 'SALES_VOICE_DB_ROUTES_ENABLED',
  'SALES_WON_TEAM_CHANNEL_ENABLED', 'SUPPORT_VOICE_ENABLED', 'SUPPORT_HANDOFF_ENABLED',
  'SMS_ENABLED', 'SMS_LOOKUP_ENABLED', 'AUTOMATION_DIGEST_SCHEDULER_SEND_ENABLED',
  'INTERVIEW_RECOVERY_CORE_ENABLED', 'INTERVIEW_RECOVERY_CORE_EMAIL_ENABLED',
  'ENABLE_QA_SYNTHETIC_INTERVIEWS', 'SENTRY_ENABLED'
]);
const FORBIDDEN_CREDENTIALS = Object.freeze([
  'SENDGRID_API_KEY', 'GHL_PRIVATE_INTEGRATION_TOKEN', 'SLACK_SALES_WON_BOT_TOKEN',
  'SALES_VOICE_HANDOFF_ROUTES_JSON', 'SALES_VOICE_GHL_WEBHOOKS_JSON',
  'SUPPORT_PHONE_HANDOFF_TOKEN', 'TELNYX_API_KEY', 'XAI_API_KEY', 'TAVUS_API_KEY',
  'OPENAI_API_KEY', 'KB_SERVICE_API_KEY', 'TAVUS_REPLICA_ID', 'TAVUS_PERSONA_ID',
  'TAVUS_RECORDING_AWS_ASSUME_ROLE_ARN', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN', 'GOOGLE_APPLICATION_CREDENTIALS', 'CONTRACTS_CRON_SECRET',
  'USAGE_BILLING_CRON_SECRET', 'AUTOMATION_DIGEST_CRON_SECRET',
  'AUTOMATION_DIGEST_RUNNER_SECRET', 'OTP_CLEANUP_CRON_SECRET',
  'RECORDING_CLEANUP_CRON_SECRET', 'SALES_INTEGRATIONS_RUNNER_SECRET'
]);
const PREVIEW_POSTS = new Set([
  '/sales/deals/preview', '/admin/billing/agreements/preview',
  '/admin/billing/agreements/preview-html', '/admin/billing/agreements/preview-pdf'
]);

function isGuardedPricingDev(env = process.env) {
  return env.APP_ENV === 'development' || env.RENDER_SERVICE_ID === DEV_SERVICE_ID;
}
function hold() {
  return Object.assign(new Error(DETAIL), { code: CODE, status: 503, detail: DETAIL, retryable: false });
}
function assertGuardedDevOutboundAllowed() {
  if (isGuardedPricingDev()) throw hold();
}
function assertGuardedPricingDevConfiguration(env = process.env) {
  if (env.RENDER_SERVICE_ID === OLD_DEV_SERVICE_ID) throw new Error('guarded_dev_old_service_refused');
  if (!isGuardedPricingDev(env)) return;
  const url = value => String(value || '').replace(/\/$/, '');
  if (env.APP_ENV !== 'development'
    || (env.RENDER_SERVICE_ID && env.RENDER_SERVICE_ID !== DEV_SERVICE_ID)
    || url(env.SUPABASE_URL) !== DEV_DATABASE_URL || url(env.FRONTEND_URL) !== DEV_FRONTEND_URL) {
    throw new Error('guarded_dev_environment_pin_mismatch');
  }
  if (OFF_FLAGS.some(key => !['', 'false', '0'].includes(String(env[key] ?? '')))) {
    throw new Error('guarded_dev_external_operation_flag_refused');
  }
  if (FORBIDDEN_CREDENTIALS.some(key => String(env[key] || '').trim())) {
    throw new Error('guarded_dev_external_credential_refused');
  }
  if (Object.entries(env).some(([key, value]) => key.startsWith('STRIPE_') && /^(?:sk|rk|pk)_live_/.test(String(value || '').trim()))) {
    throw new Error('guarded_dev_live_stripe_credential_refused');
  }
}
function guardedPricingCapabilities(env = process.env) {
  const guarded = isGuardedPricingDev(env);
  return { guarded_pricing_preview: guarded, initial_checkout: !guarded,
    renewal_actions: !guarded, usage_collection: !guarded,
    agreement_sending: !guarded, agreement_signing: !guarded, detail: guarded ? DETAIL : null };
}
function guardedPricingDevFence(req, res, next) {
  if (!isGuardedPricingDev()) return next();
  const url = new URL(req.originalUrl || req.url || '/', 'http://local.invalid');
  const pathname = url.pathname.toLowerCase().replace(/\/$/, '');
  const method = String(req.method || '').toUpperCase();
  const override = req.headers?.['x-http-method-override'] != null || req.headers?.['x-method-override'] != null || url.searchParams.has('_method');
  if (!override && (['GET', 'HEAD', 'OPTIONS'].includes(method)
    || (method === 'POST' && (PREVIEW_POSTS.has(pathname) || pathname === '/webhook/stripe')))) return next();
  res.setHeader('Cache-Control', 'no-store');
  if (req.headers?.origin === DEV_FRONTEND_URL) {
    res.setHeader('Access-Control-Allow-Origin', DEV_FRONTEND_URL);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Vary', 'Origin');
  }
  return res.status(503).json({ error: 'billing_unavailable', code: CODE, detail: DETAIL });
}

module.exports = { DEV_SERVICE_ID, DEV_DATABASE_URL, DEV_FRONTEND_URL, CODE, DETAIL,
  OFF_FLAGS, FORBIDDEN_CREDENTIALS, isGuardedPricingDev, hold,
  assertGuardedDevOutboundAllowed, assertGuardedPricingDevConfiguration,
  guardedPricingCapabilities, guardedPricingDevFence };
