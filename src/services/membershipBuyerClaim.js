'use strict';
// UNMOUNTED. Existing, freshly authenticated buyer identity only. No account
// creation/reset/invite, client access, funded admission, collection or messages.
const { createClient } = require('@supabase/supabase-js');
const { isProxy } = require('node:util').types;
const UUID = /^(?!00000000-0000-0000-0000-000000000000$)[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TOKEN = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const HOLD = 'membership_buyer_claim_held';
function held() { const e = new Error(HOLD); e.code = HOLD; e.status = 409; throw e; }
const check = v => { if (!v) held(); };
function exact(v, keys) {
  if (!v || typeof v !== 'object' || isProxy(v) || ![Object.prototype, null].includes(Object.getPrototypeOf(v))) return false;
  const d = Object.getOwnPropertyDescriptors(v);
  return Reflect.ownKeys(d).length === keys.length && keys.every(k => d[k]?.enumerable && Object.hasOwn(d[k], 'value'));
}
function jwtPart(v) { try { return JSON.parse(Buffer.from(v.split('.')[1], 'base64url').toString('utf8')); } catch (_) { held(); } }
function email(v) {
  check(typeof v === 'string' && v.length <= 254);
  const s = v.replace(/^[ \t\r\n\f\v]+|[ \t\r\n\f\v]+$/g, '').replace(/[A-Z]/g, c => c.toLowerCase());
  check(/^[!-~]+@[!-~]+$/.test(s) && !/[\s]/.test(s) && s.split('@').length === 2); return s;
}
function publicKey(v) {
  if (typeof v !== 'string' || v.length > 4096) return false;
  if (/^sb_publishable_[A-Za-z0-9_-]{16,}$/.test(v)) return true;
  if (!TOKEN.test(v)) return false;
  const p = jwtPart(v); return p?.role === 'anon'; // Config class, not JWT authentication.
}
function createMembershipBuyerClaim({ db, projectUrl, publicApiKey, environment, contextId, fetchImplementation = globalThis.fetch } = {}) {
  check(typeof projectUrl === 'string' && /^https:\/\/[a-z0-9]{20}\.supabase\.co$/.test(projectUrl)
    && db?.supabaseUrl === projectUrl && typeof db.rpc === 'function' && publicKey(publicApiKey)
    && ['dev', 'qa', 'production'].includes(environment) && UUID.test(contextId || '') && typeof fetchImplementation === 'function');
  // Dedicated installed SDK: no stored session, refresh, writes or service key.
  const authClient = createClient(projectUrl, publicApiKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: async (url, options) => {
      check(String(url) === `${projectUrl}/auth/v1/user` && options?.method === 'GET' && !options.body);
      const headers = new Headers(options.headers);
      check(headers.get('apikey') === publicApiKey && TOKEN.test((headers.get('authorization') || '').replace(/^Bearer /, '')));
      return fetchImplementation(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(10000) });
    } }
  });
  async function rpc(name, args) {
    const r = await db.rpc(name, args); check(r && !r.error); return r.data;
  }
  const nativeArgs = (operationId, a) => ({ p_operation: operationId, p_context: contextId, p_actor: a,
    p_project: projectUrl, p_environment: environment });
  async function context(operationId, a) {
    check(db.supabaseUrl === projectUrl);
    const c = await rpc('membership_v2_buyer_context', nativeArgs(operationId, a));
    check(c?.project_url === projectUrl && c.environment === environment && c.claim_enabled === true); return c;
  }
  async function actor(token) {
    const r = await authClient.auth.getUser(token); check(!r.error && r.data?.user);
    const u = r.data.user;
    check(typeof u.id === 'string' && UUID.test(u.id) && u.is_anonymous === false
      && typeof u.email_confirmed_at === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(u.email_confirmed_at)
      && Number.isFinite(Date.parse(u.email_confirmed_at)));
    // Decode only AFTER Auth server accepted this exact token. Native session
    // row is checked/locked too; decoded claims alone never authorize a claim.
    const p = jwtPart(token);
    check(p.sub === u.id && p.iss === `${projectUrl}/auth/v1` && p.role === 'authenticated'
      && typeof p.session_id === 'string' && UUID.test(p.session_id)
      && Number.isSafeInteger(p.exp) && p.exp >= 946684800 && p.exp <= 4102444799);
    return { user_id: u.id, email: email(u.email), confirmed_at: u.email_confirmed_at,
      session_id: p.session_id, expires_epoch: p.exp };
  }
  async function claim(input) {
    try {
      check(exact(input, ['operationId', 'accessToken']) && typeof input.operationId === 'string' && UUID.test(input.operationId)
        && typeof input.accessToken === 'string' && input.accessToken.length <= 16384 && TOKEN.test(input.accessToken));
      const a = await actor(input.accessToken); await context(input.operationId, a);
      let ack;
      try { ack = await db.rpc('membership_v2_record_buyer_claim', nativeArgs(input.operationId, a)); }
      catch (_) { /* Unknown ACK: fresh authorized read once, no second insert. */ }
      // Every read, including successful ACK, requires a fresh same actor.
      const fresh = await actor(input.accessToken);
      check(fresh.user_id === a.user_id && fresh.email === a.email && fresh.session_id === a.session_id);
      await context(input.operationId, fresh);
      const row = await rpc('membership_v2_read_buyer_claim', nativeArgs(input.operationId, fresh));
      check(row?.operation_id === input.operationId && row.user_id === fresh.user_id && UUID.test(row.claim_id || '')
        && ['access', 'term', 'commission', 'collection'].every(k => row[`${k}_eligible`] === false));
      if (ack && !ack.error) check(ack.data?.claim_id === row.claim_id);
      return Object.freeze({ claimId: row.claim_id, operationId: row.operation_id, accountOwnershipVerified: true,
        paidAt: row.provider_paid_at, activationEnabled: false, commissionEnabled: false, collectionEnabled: false });
    } catch (_) { held(); }
  }
  return Object.freeze({ claim });
}
module.exports = { createMembershipBuyerClaim };
