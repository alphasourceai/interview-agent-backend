'use strict';

const DEMO_CLIENT_ID = 'd38ade00-2026-4000-8000-000000000001';
const QA_URL = 'https://yjjxzxoghlpguquknyso.supabase.co';
const uuid = n => `d38ade00-2026-4000-8000-${String(n).padStart(12, '0')}`;
const isQa = (env = process.env) => String(env.SUPABASE_URL || '').replace(/\/$/, '') === QA_URL;
const isDemo = id => String(id || '').toLowerCase() === DEMO_CLIENT_ID;

// Only these operations are permitted on demo objects. Never widen to generic POSTs.
function safeDemoRequest(req) {
  const path = String(req.originalUrl || req.url || '').split('?')[0].replace(/^\/api\//, '/');
  const method = String(req.method || '').toUpperCase();
  if (method === 'OPTIONS') return true;
  if (method === 'GET' || method === 'HEAD') {
    if (/signed-url|recording-url|\/reports\/.+\/download/.test(path)) return false;
    return /^\/(auth\/(me|ping)|clients\/(my|entities|billing\/summary)|dashboard(?:\/|$)|roles(?:\/|$)|client-members(?:\/|$)|files\/resume-signed-url|reports(?:\/|$)|demo(?:\/|$)|automation(?:\/|$))/.test(path);
  }
  if (method === 'PATCH') return /^\/roles\/d38ade00-2026-4000-8000-\d{12}\/status$/.test(path);
  return method === 'POST' && path === '/demo/reset';
}

function referencesDemo(req) {
  // Fixed namespace covers every baseline client/role/candidate/interview/report.
  // Flatten parsed input without trusting a client-provided demo boolean.
  return /d38ade00-2026-4000-8000-|sales-demo-northstar/i.test(
    `${req.originalUrl || req.url || ''} ${JSON.stringify(req.body || {})}`
  );
}

function demoFence(req, res, next) {
  if (!referencesDemo(req)) return next();
  if (!isQa()) return res.status(404).json({ error: 'demo_not_available' });
  // Overview reads candidates once per client, including the demo. Let this
  // exact read reach its existing requireAuth + requireAdmin guards. Keep it
  // OUT of safeDemoRequest: restricted demo managers cannot use admin routes.
  const path = String(req.originalUrl || req.url || '').split('?')[0];
  if (['GET', 'HEAD'].includes(String(req.method || '').toUpperCase())
    && path === '/admin/candidates') return next();
  if (!safeDemoRequest(req)) return res.status(403).json({
    error: 'demo_action_disabled', detail: 'Demo data cannot send messages, start interviews, invite users, or create charges.'
  });
  return next();
}

function assertDemoPrincipal(req, authUser, env = process.env) {
  const marker = authUser?.app_metadata?.sales_demo_client_id;
  if (!marker) return null;
  if (!isDemo(marker) || !isQa(env) || req.isGlobalAdmin) return 'demo_access_denied';
  req.isSalesDemo = true;
  return safeDemoRequest(req) ? null : 'demo_action_disabled';
}

module.exports = { DEMO_CLIENT_ID, QA_URL, uuid, isQa, isDemo, safeDemoRequest, referencesDemo, demoFence, assertDemoPrincipal };
