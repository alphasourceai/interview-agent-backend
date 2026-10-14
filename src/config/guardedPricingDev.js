'use strict';

const DEV_SERVICE_ID = 'srv-db5bfjlckfvc739klcvg';
const OLD_DEV_SERVICE_ID = 'srv-dalm95942hec73cvjbv0';
const DEV_DATABASE_URL = 'https://hjombgfusdgsqipimhnc.supabase.co';
const DEV_FRONTEND_URL = 'https://interview-agent-frontend-qa.onrender.com';
const DEV_BACKEND_URL = 'https://interview-agent-dev-backend.onrender.com';
const DEV_STRIPE_ACCOUNT_ID = 'acct_1UPtmNHC5VkATVoE';
const {ownerMailRecipients}=require('./devPricingTestMail');
let verifiedSandboxFingerprint = null;
const CODE = 'GUARDED_DEV_BILLING_HOLD';
const DETAIL = 'This dev build supports pricing and agreement previews. Payments, renewals, usage collection, sending and signing are not available yet.';
const OFF_FLAGS = Object.freeze([
  'ENTERPRISE_MONTHLY_USAGE_ENABLED',
  'RETAIL_STRIPE_RENEWAL_CONTROL_ENABLED',
  'RETAIL_RENEWAL_NOTICE_ENABLED',
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
function sandboxRequested(env = process.env) { return env.DEV_PRICING_SANDBOX_ENABLED === 'true'; }
function sandboxFingerprint(env) {
  const keys = [...new Set(['APP_ENV','RENDER_SERVICE_ID','RENDER_EXTERNAL_URL','SUPABASE_URL','FRONTEND_URL',
    'DEV_PRICING_SANDBOX_ENABLED','DEV_STRIPE_ACCOUNT_ID','DEV_PRICING_EMAIL_RECIPIENTS','SENDGRID_FROM',...OFF_FLAGS,...FORBIDDEN_CREDENTIALS,
    ...Object.keys(env).filter(k=>k.startsWith('STRIPE_'))])].sort();
  return require('node:crypto').createHash('sha256').update(JSON.stringify(keys.map(k=>[k,env[k]??null]))).digest('hex');
}
function isDevBillingSandbox(env = process.env) {
  return isGuardedPricingDev(env) && sandboxRequested(env)
    && verifiedSandboxFingerprint !== null && verifiedSandboxFingerprint === sandboxFingerprint(env);
}
function isDevPricingTestMail(env=process.env){
  if(!isDevBillingSandbox(env))return false;
  try{return ownerMailRecipients(env.DEV_PRICING_EMAIL_RECIPIENTS).length>0;}catch(_){return false;}
}
function assertGuardedDevOutboundAllowed(kind) {
  if (isGuardedPricingDev() && !(kind === 'billing' && isDevBillingSandbox())) throw hold();
}
function assertGuardedPricingDevConfiguration(env = process.env) {
  if (env.RENDER_SERVICE_ID === OLD_DEV_SERVICE_ID) throw new Error('guarded_dev_old_service_refused');
  if (!['','false','0','true'].includes(String(env.DEV_PRICING_SANDBOX_ENABLED??''))) throw new Error('guarded_dev_sandbox_mode_invalid');
  if (sandboxRequested(env) && !isGuardedPricingDev(env)) throw new Error('guarded_dev_environment_pin_mismatch');
  if (!isGuardedPricingDev(env)) return;
  const mailRecipients=ownerMailRecipients(env.DEV_PRICING_EMAIL_RECIPIENTS);
  const ownerMail=mailRecipients.length>0;
  if(ownerMail&&(!sandboxRequested(env)||!/^SG\.[A-Za-z0-9_.-]{20,}$/.test(env.SENDGRID_API_KEY||'')
    ||env.SENDGRID_FROM!=='info@alphasourceai.com'))throw new Error('guarded_dev_owner_mail_configuration_invalid');
  const url = value => String(value || '').replace(/\/$/, '');
  if (env.APP_ENV !== 'development'
    || (env.RENDER_SERVICE_ID && env.RENDER_SERVICE_ID !== DEV_SERVICE_ID)
    || url(env.SUPABASE_URL) !== DEV_DATABASE_URL || url(env.FRONTEND_URL) !== DEV_FRONTEND_URL) {
    throw new Error('guarded_dev_environment_pin_mismatch');
  }
  const allowedFlags = sandboxRequested(env) ? ['ENTERPRISE_MONTHLY_USAGE_ENABLED','RETAIL_STRIPE_RENEWAL_CONTROL_ENABLED'] : [];
  if (OFF_FLAGS.some(key => !['', 'false', '0', ...(allowedFlags.includes(key)?['true']:[])].includes(String(env[key] ?? '')))) {
    throw new Error('guarded_dev_external_operation_flag_refused');
  }
  if (FORBIDDEN_CREDENTIALS.some(key => !(ownerMail&&key==='SENDGRID_API_KEY')&&String(env[key] || '').trim())) {
    throw new Error('guarded_dev_external_credential_refused');
  }
  if (Object.entries(env).some(([key, value]) => key.startsWith('STRIPE_') && /^(?:sk|rk|pk)_live_/.test(String(value || '').trim()))) {
    throw new Error('guarded_dev_live_stripe_credential_refused');
  }
  if (sandboxRequested(env) && (env.RENDER_SERVICE_ID !== DEV_SERVICE_ID || url(env.RENDER_EXTERNAL_URL) !== DEV_BACKEND_URL
    || env.DEV_STRIPE_ACCOUNT_ID !== DEV_STRIPE_ACCOUNT_ID || !/^(sk|rk)_test_[A-Za-z0-9_]+$/.test(env.STRIPE_SECRET_KEY||'')
    || !/^whsec_[A-Za-z0-9_]+$/.test(env.STRIPE_WEBHOOK_SECRET||''))) throw new Error('guarded_dev_sandbox_configuration_invalid');
}
async function initializeDevBillingSandbox({env=process.env,Stripe}={}) {
  verifiedSandboxFingerprint = null;
  assertGuardedPricingDevConfiguration(env);
  if (!sandboxRequested(env)) return;
  const fingerprint=sandboxFingerprint(env);
  // One bootstrap-only client, discarded before the existing consumers import.
  // No object authorization proxy and no change to ordinary Stripe call sites.
  const Client=Stripe||require('stripe');
  const sdk=new Client(env.STRIPE_SECRET_KEY,{apiVersion:'2023-10-16',timeout:10000,maxNetworkRetries:0});
  try {
    const account=await sdk.accounts.retrieve(), balance=await sdk.balance.retrieve();
    if(account?.id!==DEV_STRIPE_ACCOUNT_ID||balance?.livemode!==false) throw Error();
    let after,matched=0;const seen=new Set();
    for(let page=0;page<10;page++){
      const result=await sdk.webhookEndpoints.list({limit:100,...(after?{starting_after:after}:{})});
      if(!Array.isArray(result?.data)||typeof result.has_more!=='boolean'||result.data.length>100)throw Error();
      for(const endpoint of result.data){
        if(typeof endpoint.id!=='string'||seen.has(endpoint.id))throw Error();seen.add(endpoint.id);
        if(endpoint.status==='enabled'){
          if(endpoint.livemode!==false||endpoint.url!==DEV_BACKEND_URL+'/webhook/stripe'
            || ![null,undefined,'2023-10-16'].includes(endpoint.api_version))throw Error();
          matched++;
        }
      }
      if(!result.has_more)break;
      if(!result.data.length||page===9)throw Error();after=result.data.at(-1).id;
    }
    if(matched!==1)throw Error();
    for(const [key,id] of Object.entries(env).filter(([k,v])=>k.startsWith('STRIPE_PRICE_')&&String(v||'').trim())){
      const price=await sdk.prices.retrieve(id);
      if(price?.id!==id||price?.livemode!==false)throw Error();
    }
    if(sandboxFingerprint(env)!==fingerprint)throw Error();
    verifiedSandboxFingerprint=fingerprint;
  }catch(_){throw new Error('guarded_dev_sandbox_verification_failed');}
}
function guardedPricingCapabilities(env = process.env) {
  const guarded = isGuardedPricingDev(env),sandbox=isDevBillingSandbox(env);
  return { guarded_pricing_preview: guarded&&!sandbox, dev_billing_sandbox:sandbox, initial_checkout: !guarded||sandbox,
    renewal_actions: !guarded||sandbox, usage_collection: !guarded||sandbox,
    agreement_sending: !guarded||isDevPricingTestMail(env), agreement_signing: !guarded||sandbox, detail: guarded&&!sandbox ? DETAIL : null };
}
function guardedPricingDevFence(req, res, next) {
  if (!isGuardedPricingDev()) return next();
  const url = new URL(req.originalUrl || req.url || '/', 'http://local.invalid');
  const pathname = url.pathname.toLowerCase().replace(/\/$/, '');
  const method = String(req.method || '').toUpperCase();
  const override = req.headers?.['x-http-method-override'] != null || req.headers?.['x-method-override'] != null || url.searchParams.has('_method');
  const sandboxPost = new Set(['/membership-agreements/session','/membership-agreements/sign','/membership-agreements/checkout-session',
    '/clients/billing/portal-session','/clients/billing/additional-interviews/checkout-session','/clients/roles/checkout-session',
    '/admin/billing/customers','/admin/billing/invoices/sync','/sales/promotion-codes/validate']);
  const id='[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
  const clientPost=new RegExp('^/admin/clients/'+id+'/(billing/checkout-session|subscription-checkout|subscription-invoice|usage-invoice|cancel-contract)$');
  const sandboxMutation=isDevBillingSandbox()&&((method==='POST'&&(sandboxPost.has(pathname)
    ||clientPost.test(pathname)||new RegExp('^/admin/billing/agreements/'+id+'/void$').test(pathname)))
    ||method==='PATCH'&&new RegExp('^/admin/clients/'+id+'/auto-renew$').test(pathname));
  const mailMutation=isDevPricingTestMail()&&method==='POST'&&(
    ['/api/alphascreen/purchase-intents','/admin/billing/agreements/send','/sales/deals'].includes(pathname)
    ||new RegExp('^/api/alphascreen/purchase-intents/'+id+'/(agreement|email-verification/send|email-verification/verify)$').test(pathname)
    ||new RegExp('^/sales/deals/'+id+'/(resend-agreement|send-payment-reminder|cancel)$').test(pathname));
  if (!override && (['GET', 'HEAD', 'OPTIONS'].includes(method)
    ||sandboxMutation||mailMutation|| (method === 'POST' && (PREVIEW_POSTS.has(pathname) || pathname === '/webhook/stripe')))) return next();
  res.setHeader('Cache-Control', 'no-store');
  if (req.headers?.origin === DEV_FRONTEND_URL) {
    res.setHeader('Access-Control-Allow-Origin', DEV_FRONTEND_URL);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Vary', 'Origin');
  }
  return res.status(503).json({ error: 'billing_unavailable', code: CODE, detail: DETAIL });
}

module.exports = { DEV_SERVICE_ID, DEV_DATABASE_URL, DEV_FRONTEND_URL, CODE, DETAIL,
  DEV_BACKEND_URL, DEV_STRIPE_ACCOUNT_ID, sandboxRequested, isDevBillingSandbox, isDevPricingTestMail, initializeDevBillingSandbox,
  OFF_FLAGS, FORBIDDEN_CREDENTIALS, isGuardedPricingDev, hold,
  assertGuardedDevOutboundAllowed, assertGuardedPricingDevConfiguration,
  guardedPricingCapabilities, guardedPricingDevFence };
