'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict'), crypto = require('node:crypto');
const { createMembershipAccountLinkEnvelope: create } = require('../src/services/membershipAccountLinkEnvelope');
const sha = v => crypto.createHash('sha256').update(v).digest('hex');
const id = n => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const projectUrl = 'https://abcdefghijklmnopqrst.supabase.co';
const origins = { dev: 'https://interview-agent-frontend-qa.onrender.com', qa: 'https://alphasourceai-com.onrender.com', production: 'https://www.alphasourceai.com' };
function fixture(environment = 'dev') {
  const key = crypto.randomBytes(32), token = crypto.randomBytes(32).toString('hex');
  const b = { purpose: 'membership_account_setup_invite_v1', environment, project_url: projectUrl, frontend_origin: origins[environment],
    operation_id: id(1), purchase_id: id(2), context_id: id(3), user_id: id(4), source_fingerprint: sha('SYNTHETIC SOURCE'),
    buyer_email: 'demo+setup@example.invalid', token_sha256: sha(token), link_sha256: '' };
  const params = new URLSearchParams({ token, type: 'invite', redirect_to: `${b.frontend_origin}/membership-v2/setup/${b.purchase_id}` });
  const link = `${projectUrl}/auth/v1/verify?${params}`; b.link_sha256 = sha(link);
  const config = { environment, projectUrl, activeKeyId: 'k1', keys: { k1: key } };
  return { b, key, token, link, config, service: create(config) };
}
const canonical = v => v && typeof v === 'object'
  ? `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}` : JSON.stringify(v);
const aad = e => Buffer.from(canonical({ protocol: e.protocol, key_id: e.key_id, binding: e.binding }));
const denied = f => assert.throws(f, e => e.message === 'membership_account_link_invalid' && e.code === e.message && !e.cause);
function encrypt(x, plain, b = x.b) {
  const e = { protocol: 'membership_account_link_envelope_v1', key_id: 'k1', binding: { ...b }, nonce: crypto.randomBytes(12).toString('base64url') };
  const c = crypto.createCipheriv('aes-256-gcm', x.key, Buffer.from(e.nonce, 'base64url'), { authTagLength: 16 }); c.setAAD(aad(e));
  e.ciphertext = Buffer.concat([c.update(plain), c.final()]).toString('base64url'); e.tag = c.getAuthTag().toString('base64url'); return e;
}
test('all explicit environments round-trip with independent AES oracle and no exposed provider bearer/link', () => {
  for (const env of Object.keys(origins)) {
    const x = fixture(env), e = x.service.seal({ binding: x.b, link: x.link }), other = x.service.seal({ binding: x.b, link: x.link });
    assert.equal(x.service.open({ envelope: e, binding: x.b }), x.link); assert.notEqual(e.nonce, other.nonce); assert.notEqual(e.ciphertext, other.ciphertext);
    const d = crypto.createDecipheriv('aes-256-gcm', x.key, Buffer.from(e.nonce, 'base64url'), { authTagLength: 16 }); d.setAAD(aad(e)); d.setAuthTag(Buffer.from(e.tag, 'base64url'));
    assert.equal(Buffer.concat([d.update(Buffer.from(e.ciphertext, 'base64url')), d.final()]).toString(), x.link);
    const serialized = JSON.stringify(e); assert.ok(!serialized.includes(x.link) && !serialized.includes(x.token));
    assert.ok(Object.isFrozen(e) && Object.isFrozen(e.binding)); assert.equal(e.binding.token_sha256, sha(x.token)); x.service.destroy();
  }
});
test('independently sealed valid vector and arbitrary query order remain compatible', () => {
  const x = fixture(), u = new URL(x.link); u.search = new URLSearchParams({ type: 'invite', redirect_to: u.searchParams.get('redirect_to'), token: x.token }).toString();
  const link = u.href, b = { ...x.b, link_sha256: sha(link) }; const e = encrypt(x, link, b);
  assert.equal(x.service.open({ envelope: e, binding: b }), link); x.service.destroy();
});
test('every provenance field substitution fails even if an attacker changes stored binding too', () => {
  const x = fixture(), e = x.service.seal({ binding: x.b, link: x.link });
  for (const field of Object.keys(x.b)) {
    const b = { ...x.b, [field]: field.endsWith('_id') ? id(99) : field.includes('sha256') || field === 'source_fingerprint' ? 'f'.repeat(64)
      : field === 'environment' ? 'production' : field === 'buyer_email' ? 'other@example.invalid' : 'unexpected' };
    denied(() => x.service.open({ envelope: e, binding: b })); denied(() => x.service.open({ envelope: { ...e, binding: b }, binding: b }));
  }
  x.service.destroy();
});
test('nonce, ciphertext, tag, protocol and key substitutions never return plaintext', () => {
  const x = fixture(), e = x.service.seal({ binding: x.b, link: x.link });
  for (const field of ['nonce', 'ciphertext', 'tag']) { const b = Buffer.from(e[field], 'base64url'); b[0] ^= 1;
    denied(() => x.service.open({ envelope: { ...e, [field]: b.toString('base64url') }, binding: x.b })); }
  for (const changed of [{ ...e, protocol: 'membership_capability_envelope_v1' }, { ...e, key_id: 'absent' }]) denied(() => x.service.open({ envelope: changed, binding: x.b }));
  const wrong = create({ ...x.config, keys: { k1: crypto.randomBytes(32) } }); denied(() => wrong.open({ envelope: e, binding: x.b })); wrong.destroy(); x.service.destroy();
});
test('wrong project and cross-environment decrypt fail under same physical key', () => {
  const x = fixture(), e = x.service.seal({ binding: x.b, link: x.link });
  const project = create({ ...x.config, projectUrl: 'https://zyxwvutsrqponmlkjihg.supabase.co' }); denied(() => project.open({ envelope: e, binding: x.b }));
  const env = create({ ...x.config, environment: 'production' }); denied(() => env.open({ envelope: e, binding: x.b })); project.destroy(); env.destroy(); x.service.destroy();
});
test('host/path/type/redirect/query credentials and alternate capabilities are closed, including authenticated malicious ciphertext', () => {
  const x = fixture(), links = [];
  const mutate = f => { const u = new URL(x.link); f(u); links.push(u.href); };
  mutate(u => u.hostname = 'other.supabase.co'); mutate(u => u.protocol = 'http:'); mutate(u => u.username = 'user'); mutate(u => u.password = 'secret');
  mutate(u => u.pathname = '/auth/v1/admin/users'); mutate(u => u.hash = '#fragment'); mutate(u => u.port = '444');
  mutate(u => u.searchParams.set('type', 'recovery')); mutate(u => u.searchParams.set('redirect_to', 'https://evil.invalid/setup'));
  mutate(u => u.searchParams.set('redirect_to', `${x.b.frontend_origin}/membership-v2/setup/${id(90)}`));
  mutate(u => u.searchParams.append('type', 'invite')); mutate(u => u.searchParams.append('unknown', 'anything'));
  mutate(u => u.searchParams.delete('token')); mutate(u => u.searchParams.set('token', 'g'.repeat(64)));
  mutate(u => u.searchParams.set('token', 'f'.repeat(64))); links.push(x.link + '\n'); links.push(x.link.replace('/auth/v1/verify', '/auth/v1/../v1/verify'));
  for (const link of links) {
    const b = { ...x.b, link_sha256: sha(link) }; denied(() => x.service.seal({ binding: b, link }));
    denied(() => x.service.open({ envelope: encrypt(x, link, b), binding: b }));
  }
  x.service.destroy();
});
test('wrong second token/link digest, noncanonical buyer email and zero IDs fail before encryption', () => {
  const x = fixture();
  for (const b of [{ ...x.b, token_sha256: x.token }, { ...x.b, link_sha256: 'f'.repeat(64) }, { ...x.b, buyer_email: 'Demo@example.invalid' },
    { ...x.b, user_id: '00000000-0000-0000-0000-000000000000' }, { ...x.b, extra: true }, { ...x.b, purpose: 'retail_signer_v2' }]) denied(() => x.service.seal({ binding: b, link: x.link }));
  x.service.destroy();
});
test('closed records reject accessor, prototype, nonenumerable, symbols and proxies without running traps', () => {
  const x = fixture(), e = x.service.seal({ binding: x.b, link: x.link }); let invoked = 0;
  const getter = { ...x.b }; Object.defineProperty(getter, 'buyer_email', { enumerable: true, get() { invoked++; throw Error('SECRET'); } });
  const hidden = { ...x.b }; Object.defineProperty(hidden, 'buyer_email', { value: x.b.buyer_email, enumerable: false });
  const proxy = new Proxy(x.b, { ownKeys() { invoked++; throw Error('SECRET'); } });
  for (const b of [getter, hidden, proxy, Object.assign(Object.create({ inherited: true }), x.b), { ...x.b, [Symbol('secret')]: true }]) {
    denied(() => x.service.seal({ binding: b, link: x.link })); denied(() => x.service.open({ envelope: e, binding: b }));
  }
  denied(() => x.service.open(new Proxy({}, { ownKeys() { invoked++; throw Error('SECRET'); } })));
  denied(() => x.service.seal({ binding: x.b, link: x.link, extra: true })); assert.equal(invoked, 0); x.service.destroy();
});
test('bad/oversized canonical encodings fail before decryption and high-bit plaintext cannot mask into valid URL', () => {
  const x = fixture(), e = x.service.seal({ binding: x.b, link: x.link });
  for (const field of ['nonce', 'ciphertext', 'tag']) for (const value of [null, '', '!', e[field] + '=', 'A'.repeat(50000), e[field].slice(1)])
    denied(() => x.service.open({ envelope: { ...e, [field]: value }, binding: x.b }));
  const plain = Buffer.from(x.link); plain[0] |= 128; const b = { ...x.b, link_sha256: sha(plain) };
  denied(() => x.service.open({ envelope: encrypt(x, plain, b), binding: b })); x.service.destroy();
});
test('nonzero-offset keys copy exact bytes without consulting overridden typed-array getters', () => {
  const x = fixture(), e = x.service.seal({ binding: x.b, link: x.link }), outer = crypto.randomBytes(100); outer.set(x.key, 25);
  const view = new Uint8Array(outer.buffer, outer.byteOffset + 25, 32); let invoked = 0;
  for (const k of ['length', 'buffer', 'byteOffset']) Object.defineProperty(view, k, { get() { invoked++; throw Error('SECRET'); } });
  const s = create({ ...x.config, keys: { k1: view } }); outer.fill(0); assert.equal(s.open({ envelope: e, binding: x.b }), x.link); assert.equal(invoked, 0);
  s.destroy(); x.service.destroy();
});
test('input keys and bindings are owned copies; rotation, retirement, rename and destroy are explicit', () => {
  const x = fixture(), key = Buffer.from(x.key), b = { ...x.b }, e = x.service.seal({ binding: b, link: x.link }); x.key.fill(0); b.buyer_email = 'changed@example.invalid';
  assert.equal(x.service.open({ envelope: e, binding: x.b }), x.link); assert.equal(e.binding.buyer_email, x.b.buyer_email);
  const rotated = create({ ...x.config, activeKeyId: 'next', keys: { k1: key, next: crypto.randomBytes(32) } });
  assert.equal(rotated.open({ envelope: e, binding: x.b }), x.link); assert.equal(rotated.seal({ binding: x.b, link: x.link }).key_id, 'next');
  const renamed = create({ ...x.config, activeKeyId: 'renamed', keys: { renamed: key } }); denied(() => renamed.open({ envelope: { ...e, key_id: 'renamed' }, binding: x.b }));
  const retired = create({ ...x.config, activeKeyId: 'next', keys: { next: crypto.randomBytes(32) } }); denied(() => retired.open({ envelope: e, binding: x.b }));
  for (const s of [x.service, rotated, renamed, retired]) { s.destroy(); s.destroy(); denied(() => s.open({ envelope: e, binding: x.b })); denied(() => s.keyIdentity('k1')); }
});
test('factory rejects ambiguous, ambient, shared, duplicate and malformed configuration without exposing diagnostics', () => {
  const x = fixture(), configs = [undefined, {}, { ...x.config, environment: 'staging' }, { ...x.config, projectUrl: projectUrl + '/' },
    { ...x.config, activeKeyId: 'missing' }, { ...x.config, keys: {} }, { ...x.config, keys: { k1: 'secret' } },
    { ...x.config, keys: { k1: Buffer.alloc(31) } }, { ...x.config, keys: { k1: x.key, k2: x.key } },
    { ...x.config, keys: Object.fromEntries([1, 2, 3, 4, 5].map(v => ['k' + v, crypto.randomBytes(32)])) },
    { ...x.config, keys: { k1: new Uint8Array(new SharedArrayBuffer(32)) } },
    new Proxy({}, { ownKeys() { throw Error('SECRET MUST NOT ESCAPE'); } })];
  for (const config of configs) assert.throws(() => create(config), e => e.message === 'membership_account_link_not_configured' && e.code === e.message && !e.cause);
  const keys = {}; Object.defineProperty(keys, 'k1', { enumerable: true, get() { throw Error('SECRET MUST NOT ESCAPE'); } });
  assert.throws(() => create({ ...x.config, keys }), e => e.message === 'membership_account_link_not_configured'); x.service.destroy();
});
