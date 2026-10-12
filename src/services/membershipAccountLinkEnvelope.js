'use strict';
// PURE, UNMOUNTED. Protects an already generated provider invitation; does not
// generate links, establish identity, authorize sending, or grant client access.
const crypto = require('node:crypto');
const { isProxy } = require('node:util').types;
const { validMembershipBuyerEmail } = require('./membershipCapabilityPredicates');
const PROTOCOL = 'membership_account_link_envelope_v1';
const PURPOSE = 'membership_account_setup_invite_v1';
const UUID = /^(?!00000000-0000-0000-0000-000000000000$)[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HASH = /^[0-9a-f]{64}$/, KEY = /^[A-Za-z0-9._-]{1,64}$/;
const ORIGINS = Object.freeze({ dev: 'https://interview-agent-frontend-qa.onrender.com',
  qa: 'https://alphasourceai-com.onrender.com', production: 'https://www.alphasourceai.com' });
const FIELDS = ['purpose', 'environment', 'project_url', 'frontend_origin', 'operation_id', 'purchase_id',
  'context_id', 'user_id', 'source_fingerprint', 'buyer_email', 'token_sha256', 'link_sha256'];
const sha = v => crypto.createHash('sha256').update(v).digest('hex');
const typedPrototype = Object.getPrototypeOf(Uint8Array.prototype);
const typedLength = Object.getOwnPropertyDescriptor(typedPrototype, 'length').get;
const typedBuffer = Object.getOwnPropertyDescriptor(typedPrototype, 'buffer').get;
const typedOffset = Object.getOwnPropertyDescriptor(typedPrototype, 'byteOffset').get;
function fail(code = 'membership_account_link_invalid') { const e = new Error(code); e.code = code; throw e; }
const check = v => { if (!v) fail(); };
function record(v, keys) {
  check(v && typeof v === 'object' && !isProxy(v) && [Object.prototype, null].includes(Object.getPrototypeOf(v)));
  const d = Object.getOwnPropertyDescriptors(v), own = Reflect.ownKeys(d);
  check(own.length === keys.length && keys.every(k => d[k]?.enumerable && Object.hasOwn(d[k], 'value')));
  return Object.fromEntries(keys.map(k => [k, d[k].value]));
}
const canonical = v => v && typeof v === 'object'
  ? `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}` : JSON.stringify(v);
function bind(v, environment, projectUrl) {
  const b = record(v, FIELDS);
  check(b.purpose === PURPOSE && b.environment === environment && b.project_url === projectUrl
    && b.frontend_origin === ORIGINS[environment] && validMembershipBuyerEmail(b.buyer_email)
    && ['operation_id', 'purchase_id', 'context_id', 'user_id'].every(k => typeof b[k] === 'string' && UUID.test(b[k]))
    && ['source_fingerprint', 'token_sha256', 'link_sha256'].every(k => typeof b[k] === 'string' && HASH.test(b[k])));
  return Object.freeze(b);
}
function verifyLink(link, b) {
  check(typeof link === 'string' && link.length >= 100 && link.length <= 2048 && /^[\x21-\x7e]+$/.test(link));
  const u = new URL(link), project = new URL(b.project_url);
  check(u.href === link && u.origin === project.origin && !u.username && !u.password && !u.port && !u.hash
    && u.pathname === '/auth/v1/verify' && link.startsWith(`${b.project_url}/auth/v1/verify?`));
  const entries = [...u.searchParams.entries()];
  check(entries.length === 3 && new Set(entries.map(([k]) => k)).size === 3
    && entries.every(([k]) => ['token', 'type', 'redirect_to'].includes(k)));
  const token = u.searchParams.get('token');
  // Provider hashed_token is itself a bearer. Persist only its SECOND hash in
  // binding/AAD, never the provider bearer or OTP outside encrypted plaintext.
  check(HASH.test(token || '') && u.searchParams.get('type') === 'invite'
    && u.searchParams.get('redirect_to') === `${b.frontend_origin}/membership-v2/setup/${b.purchase_id}`
    && sha(token) === b.token_sha256 && sha(link) === b.link_sha256);
}
function decode(v, min, max = min) {
  check(typeof v === 'string' && v.length >= Math.ceil(min * 8 / 6) && v.length <= Math.ceil(max * 8 / 6)
    && /^[A-Za-z0-9_-]+$/.test(v));
  const b = Buffer.from(v, 'base64url');
  if (b.length < min || b.length > max || b.toString('base64url') !== v) { b.fill(0); fail(); }
  return b;
}
function create(config) {
  config = record(config, ['environment', 'projectUrl', 'activeKeyId', 'keys']);
  const { environment, projectUrl, activeKeyId } = config;
  check(typeof environment === 'string' && Object.hasOwn(ORIGINS, environment) && typeof projectUrl === 'string'
    && /^https:\/\/[a-z0-9]{20}\.supabase\.co$/.test(projectUrl)
    && typeof activeKeyId === 'string' && KEY.test(activeKeyId));
  const keyNames = config.keys && !isProxy(config.keys) ? Reflect.ownKeys(config.keys) : [];
  check(keyNames.length >= 1 && keyNames.length <= 4 && keyNames.every(k => typeof k === 'string' && KEY.test(k)));
  const keys = record(config.keys, keyNames), owned = new Map(); let destroyed = false;
  try {
    for (const id of keyNames) {
      const key = keys[id]; check(!isProxy(key) && (Buffer.isBuffer(key) || key instanceof Uint8Array)
        && !(typedBuffer.call(key) instanceof SharedArrayBuffer) && typedLength.call(key) === 32);
      const copied = Buffer.from(new Uint8Array(typedBuffer.call(key), typedOffset.call(key), 32));
      if ([...owned.values()].some(k => crypto.timingSafeEqual(k, copied))) { copied.fill(0); fail(); }
      owned.set(id, copied);
    }
    check(owned.has(activeKeyId));
  } catch (_) { for (const k of owned.values()) k.fill(0); fail(); }
  const alive = () => check(!destroyed);
  const aad = (keyId, b) => Buffer.from(canonical({ protocol: PROTOCOL, key_id: keyId, binding: b }), 'utf8');
  const guarded = f => (...args) => { try { return f(...args); } catch (_) { fail(); } };
  return Object.freeze({
    environment, projectUrl,
    keyIdentity: guarded(id => {
      alive(); check(typeof id === 'string' && KEY.test(id) && owned.has(id));
      return Object.freeze({ environment, project_url: projectUrl, key_id: id, physical_key_fingerprint: sha(owned.get(id)) });
    }),
    seal: guarded(input => {
      alive(); input = record(input, ['binding', 'link']); const b = bind(input.binding, environment, projectUrl);
      verifyLink(input.link, b);
      let plain, nonce, additional, encrypted, tag;
      try {
        plain = Buffer.from(input.link, 'utf8'); nonce = crypto.randomBytes(12); additional = aad(activeKeyId, b);
        const c = crypto.createCipheriv('aes-256-gcm', owned.get(activeKeyId), nonce, { authTagLength: 16 }); c.setAAD(additional);
        encrypted = Buffer.concat([c.update(plain), c.final()]); tag = c.getAuthTag();
        return Object.freeze({ protocol: PROTOCOL, key_id: activeKeyId, binding: b, nonce: nonce.toString('base64url'),
          ciphertext: encrypted.toString('base64url'), tag: tag.toString('base64url') });
      } finally { for (const bytes of [plain, nonce, additional, encrypted, tag]) bytes?.fill(0); }
    }),
    open: guarded(input => {
      alive(); input = record(input, ['envelope', 'binding']); const b = bind(input.binding, environment, projectUrl);
      const e = record(input.envelope, ['protocol', 'key_id', 'binding', 'nonce', 'ciphertext', 'tag']);
      check(e.protocol === PROTOCOL && typeof e.key_id === 'string' && KEY.test(e.key_id) && owned.has(e.key_id)
        && canonical(bind(e.binding, environment, projectUrl)) === canonical(b));
      let nonce, encrypted, tag, additional, partial, tail, plain;
      try {
        nonce = decode(e.nonce, 12); encrypted = decode(e.ciphertext, 100, 2048); tag = decode(e.tag, 16); additional = aad(e.key_id, b);
        const d = crypto.createDecipheriv('aes-256-gcm', owned.get(e.key_id), nonce, { authTagLength: 16 }); d.setAAD(additional); d.setAuthTag(tag);
        partial = d.update(encrypted); tail = d.final(); plain = Buffer.concat([partial, tail]);
        check(plain.length >= 100 && plain.length <= 2048);
        const link = plain.toString('utf8'); verifyLink(link, b); return link;
      } finally { for (const bytes of [nonce, encrypted, tag, additional, partial, tail, plain]) bytes?.fill(0); }
    }),
    destroy() { if (!destroyed) { destroyed = true; for (const k of owned.values()) k.fill(0); owned.clear(); } }
  });
}
module.exports = { createMembershipAccountLinkEnvelope(config) {
  try { return create(config); } catch (_) { fail('membership_account_link_not_configured'); }
} };
