'use strict';

// UNMOUNTED signed-source Checkout only. Explicit private ports; no default key,
// Auth ownership, paid receipt, activation, future collection, email or retries.
const crypto = require('node:crypto');
const { isProxy } = require('node:util').types;
const { createMembershipPendingPurchase } = require('./membershipPendingPurchase');
const { buildRetailOffer, OFFER_VERSION } = require('./membershipOffers');
const { isMembershipCheckoutTransport } = require('./membershipCheckoutTransport');
const UUID = /^(?!00000000-0000-0000-0000-000000000000$)[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HASH = /^[0-9a-f]{64}$/;
const API_VERSION = '2023-10-16';
const OPTIONS = Object.freeze({ maxNetworkRetries: 0, timeout: 10000 });
const sha = v => crypto.createHash('sha256').update(v).digest('hex');
const canonical = v => v && typeof v === 'object' ? (Array.isArray(v) ? `[${v.map(canonical).join(',')}]`
  : `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`) : JSON.stringify(v);
const same = (a, b) => canonical(a) === canonical(b);
function fail(code = 'membership_checkout_held', status = 503) {
  const error = new Error(code); error.code = code; error.status = status; throw error;
}
function check(ok, code, status) { if (!ok) fail(code, status); }
function exact(v, keys) {
  return v && typeof v === 'object' && !isProxy(v) && [Object.prototype, null].includes(Object.getPrototypeOf(v))
    && Reflect.ownKeys(v).length === keys.length && Object.entries(Object.getOwnPropertyDescriptors(v))
      .every(([k, d]) => keys.includes(k) && d.enumerable && Object.hasOwn(d, 'value'));
}
const dispatchHash = (id, digest, nonce) => sha(`membership-checkout-dispatch-v2\n${id}\n${digest}\n${nonce}`);

function createMembershipCheckoutExecutor({ db, signing, stripe, environment, contextId } = {}) {
  check(['dev', 'qa', 'production'].includes(environment) && UUID.test(contextId || '')
    && typeof stripe?.getApiField === 'function' && typeof stripe.getMaxNetworkRetries === 'function'
    && typeof stripe.accounts?.retrieve === 'function' && typeof stripe.balance?.retrieve === 'function'
    && typeof stripe.paymentIntents?.retrieve === 'function'
    && ['create', 'retrieve', 'listLineItems'].every(k => typeof stripe.checkout?.sessions?.[k] === 'function'),
  'membership_checkout_not_configured');
  const pending = createMembershipPendingPurchase({ db, signing, environment });
  function version() {
    check(stripe.getApiField('version') === API_VERSION && !stripe.getApiField('stripeAccount')
      && stripe.getMaxNetworkRetries() === 0 && isMembershipCheckoutTransport(stripe.getApiField('httpClient')),
      'membership_checkout_provider_mismatch');
  }
  async function provider(call) {
    version(); let r; try { r = await call(); } catch (_) { fail('membership_checkout_provider_unavailable'); }
    version(); check(r?.lastResponse?.headers?.['stripe-version'] === API_VERSION,
      'membership_checkout_provider_version_unverified'); return r;
  }
  async function row(table, key, value, columns = '*') {
    let r; try { r = await db.from(table).select(columns).eq(key, value).maybeSingle(); }
    catch (_) { fail('membership_checkout_store_unavailable'); }
    check(r && !r.error, 'membership_checkout_store_unavailable'); return r.data;
  }
  async function rpc(name, args) {
    let r; try { r = await db.rpc(name, args); } catch (_) { fail('membership_checkout_store_unavailable'); }
    check(r && !r.error, 'membership_checkout_store_unavailable'); return r.data;
  }
  async function signed(input) {
    const r = await signing.session(input);
    check(r?.session?.document_id === input.documentId && r.session.state === 'accepted'
      && r.session.activation_enabled === false && (Buffer.isBuffer(r.pdf_bytes) || r.pdf_bytes instanceof Uint8Array));
    return { session: structuredClone(r.session), pdfHash: sha(r.pdf_bytes), pdfSize: r.pdf_bytes.length };
  }
  async function context(purchaseId, tokenHash, proof, current = true) {
    const c = await rpc('membership_v2_checkout_context', {
      p_purchase: purchaseId, p_token_hash: tokenHash, p_context: contextId, p_current: current
    });
    const p = c?.purchase, s = c?.source, config = c?.context, offer = s?.snapshot?.quote?.offer;
    check(p?.id === purchaseId && p.document_id === proof.session.document_id && p.environment === environment
      && p.source_digest === s?.digest && HASH.test(s.digest || '') && same(p.source_snapshot, s.snapshot)
      && p.activation_enabled === false && p.account_ownership_verified === false && p.provider_effects_enabled === false
      && s.snapshot.acceptance.executed_pdf_sha256 === proof.pdfHash && s.snapshot.acceptance.executed_pdf_size === proof.pdfSize
      && Date.parse(s.snapshot.acceptance.accepted_at) === Date.parse(proof.session.accepted_at)
      && same(offer, proof.session.offer) && ['sales', 'admin'].includes(s.snapshot.quote.audience)
      && config?.id === contextId && config.environment === environment && config.api_version === API_VERSION
      && config.livemode === (environment === 'production') && /^acct_[A-Za-z0-9_]+$/.test(config.provider_account_id || '')
      && /^https:\/\/([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/.test(config.frontend_origin || '')
      && config.tax_policy === 'existing_checkout_no_automatic_tax_v1' && Number.isFinite(Date.parse(c.observed_at))
      && (!current || (config.checkout_enabled === true && Date.parse(p.expires_at) > Date.parse(c.observed_at))));
    const expected = buildRetailOffer({ channel: s.snapshot.quote.audience, planKey: offer.plan_key,
      commitmentMonths: offer.commitment_months, paymentOption: offer.payment_option,
      firstRolePrepaySelected: offer.first_role_prepay.selected, offerVersion: OFFER_VERSION });
    check(same(expected, offer), 'membership_checkout_offer_unverified'); return c;
  }
  async function account(c) {
    const a = await provider(() => stripe.accounts.retrieve({}, OPTIONS));
    const b = await provider(() => stripe.balance.retrieve({}, OPTIONS));
    check(a?.object === 'account' && a.id === c.context.provider_account_id && b?.object === 'balance'
      && b.livemode === c.context.livemode, 'membership_checkout_provider_mismatch');
  }
  function operation(op, c) {
    const p = c.purchase, o = p.source_snapshot.quote.offer, body = op?.request_body;
    const m = { protocol: 'retail_checkout_v2', operation_id: op?.id, purchase_id: p.id,
      document_id: p.document_id, source_digest: p.source_digest };
    const line = (kind, cents, name) => ({ quantity: 1, price_data: { currency: 'usd', unit_amount: cents,
      product_data: { name, metadata: { ...m, kind } } } });
    const items = [line('platform', o.platform_payment_cents, `${o.display_name} platform membership — ${o.commitment_months} months`)];
    if (o.first_role_prepay.selected) items.push(line('first_role', o.first_role_prepay.amount_cents,
      'First role prepayment (one-time; does not renew)'));
    const expected = { mode: 'payment', customer_creation: 'always', customer_email: p.source_snapshot.source.buyer.buyer_email,
      client_reference_id: p.id, automatic_tax: { enabled: false }, allow_promotion_codes: false, line_items: items, metadata: m,
      invoice_creation: { enabled: true, invoice_data: { metadata: m } },
      payment_intent_data: { capture_method: 'automatic', setup_future_usage: 'off_session', metadata: m },
      success_url: `${c.context.frontend_origin}/membership/checkout-return?purchase_id=${p.id}&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${c.context.frontend_origin}/membership/checkout-return?purchase_id=${p.id}&checkout=canceled`, expires_at: op?.expires_epoch };
    check(UUID.test(op?.id || '') && op.purchase_id === p.id && op.context_id === contextId && op.source_digest === p.source_digest
      && HASH.test(op.body_digest || '') && Number.isFinite(Date.parse(op.created_at))
      && Number.isSafeInteger(op.expires_epoch) && op.expires_epoch <= Math.floor(Date.parse(p.expires_at) / 1000)
      && op.expires_epoch <= Math.floor(Date.parse(op.created_at) / 1000) + 86280 && same(body, expected)
      && op.idempotency_key === `membership-checkout-v2:${op.id}`, 'membership_checkout_operation_unverified');
    return op;
  }
  async function retrieve(op, c, id) {
    check(typeof id === 'string' && /^cs_(test|live)_[A-Za-z0-9_]+$/.test(id));
    const session = await provider(() => stripe.checkout.sessions.retrieve(id, {}, OPTIONS));
    const lines = await provider(() => stripe.checkout.sessions.listLineItems(id, { limit: 100, expand: ['data.price.product'] }, OPTIONS));
    check(session?.object === 'checkout.session' && session.id === id && Array.isArray(lines?.data)
      && session.invoice_creation?.enabled === true && session.allow_promotion_codes === false
      && same(session.invoice_creation.invoice_data?.metadata, op.request_body.invoice_creation.invoice_data.metadata)
      && lines.object === 'list' && lines.has_more === false && lines.data.length <= 2);
    // API2023 defers PI creation until Checkout confirmation. Null is not an
    // observed echo of PI settings. Once present, verify the actual object.
    if (session.payment_intent !== null) {
      const piId = typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent?.id;
      check(typeof piId === 'string' && /^pi_[A-Za-z0-9_]+$/.test(piId));
      const pi = await provider(() => stripe.paymentIntents.retrieve(piId, {}, OPTIONS));
      const customerId = v => typeof v === 'string' ? v : v?.id ?? null;
      check(pi?.object === 'payment_intent' && pi.id === piId && pi.livemode === c.context.livemode
        && pi.currency === 'usd' && pi.capture_method === 'automatic' && pi.setup_future_usage === 'off_session'
        && same(pi.metadata, op.request_body.payment_intent_data.metadata) && pi.amount === session.amount_total
        && customerId(pi.customer) === customerId(session.customer)
        && ['requires_payment_method', 'requires_confirmation', 'requires_action', 'processing'].includes(pi.status));
    }
    const items = lines.data.map(l => {
      const p = l.price, product = p?.product;
      check(l.object === 'item' && p?.object === 'price' && p.currency === 'usd' && p.livemode === c.context.livemode
        && product?.object === 'product' && product.deleted !== true && product.livemode === c.context.livemode);
      return { kind: product.metadata?.kind, line_id: l.id, price_id: p.id, product_id: product.id,
        metadata: product.metadata, name: product.name, unit_amount: p.unit_amount, amount_subtotal: l.amount_subtotal,
        amount_total: l.amount_total, quantity: l.quantity, currency: l.currency, price_type: p.type,
        recurring: p.recurring, amount_discount: l.amount_discount, amount_tax: l.amount_tax };
    }).sort((a, b) => String(a.kind).localeCompare(String(b.kind)));
    const attestation = { session_id: session.id, provider_account_id: c.context.provider_account_id, livemode: session.livemode,
      api_version: API_VERSION, mode: session.mode, currency: session.currency, customer_creation: session.customer_creation,
      customer_email: session.customer_email, client_reference_id: session.client_reference_id, metadata: session.metadata,
      invoice_metadata: session.invoice_creation.invoice_data.metadata,
      success_url: session.success_url, cancel_url: session.cancel_url, expires_at: session.expires_at,
      automatic_tax_enabled: session.automatic_tax?.enabled, amount_discount: session.total_details?.amount_discount,
      amount_tax: session.total_details?.amount_tax, amount_shipping: session.total_details?.amount_shipping,
      has_more: lines.has_more, status: session.status, payment_status: session.payment_status, created: session.created,
      items, amount_subtotal: session.amount_subtotal, amount_total: session.amount_total };
    check(await rpc('membership_v2_checkout_proof_matches', { p_operation: op.id, p_proof: attestation }) === true,
      'membership_checkout_provider_proof_unverified');
    let url; try { url = new URL(session.url); } catch (_) { fail('membership_checkout_url_unverified'); }
    check(url.protocol === 'https:' && url.hostname === 'checkout.stripe.com' && !url.username && !url.password && !url.port
      && url.pathname === `/c/pay/${id}` && !url.search && id.startsWith(c.context.livemode ? 'cs_live_' : 'cs_test_')
      && session.expires_at > Math.floor(Date.parse(c.observed_at) / 1000), 'membership_checkout_url_unverified');
    await account(c); return { attestation, url: session.url };
  }
  return Object.freeze({ async checkout(input) {
    check(exact(input, ['documentId', 'token']) && typeof input.documentId === 'string' && UUID.test(input.documentId)
      && typeof input.token === 'string' && /^[A-Za-z0-9_-]{43}$/.test(input.token), 'invalid_membership_checkout', 400);
    version(); const original = await signed(input), linked = await pending.reserve(input);
    const d = await row('membership_v2_issued_documents', 'id', input.documentId, 'id,source_fingerprint,signer_token_hash');
    check(d?.id === input.documentId && HASH.test(d.source_fingerprint || '') && HASH.test(d.signer_token_hash || ''));
    const tokenHash = sha(`retail-signing-v2\n${d.id}\n${d.source_fingerprint}\n${input.token}`);
    check(tokenHash === d.signer_token_hash, 'membership_checkout_capability_denied', 403);
    let c = await context(linked.purchase_id, tokenHash, original);
    let op = await row('membership_v2_checkout_operations', 'purchase_id', linked.purchase_id);
    // Read-only provider failures precede allocating a new operation.
    await account(c);
    const proposal = crypto.randomUUID(), nonce = crypto.randomBytes(32).toString('base64url');
    if (!op) {
      let ack;
      try { ack = await db.rpc('membership_v2_claim_checkout_operation', { p_id: proposal, p_purchase: linked.purchase_id,
        p_token_hash: tokenHash, p_context: contextId }); } catch (_) { /* Exact readback only. */ }
      op = await row('membership_v2_checkout_operations', 'purchase_id', linked.purchase_id);
      if (ack && !ack.error) check(exact(ack.data, ['action', 'operation_id'])
        && ['created', 'existing'].includes(ack.data.action) && ack.data.operation_id === op?.id);
    }
    operation(op, c); let binding = await row('membership_v2_checkout_bindings', 'operation_id', op.id);
    let verified;
    if (binding) {
      check(binding.provider_account_id === c.context.provider_account_id && binding.livemode === c.context.livemode);
      await account(c); verified = await retrieve(op, c, binding.session_id);
      check(same(binding.proof, verified.attestation), 'membership_checkout_binding_unverified');
    } else {
      check(!await row('membership_v2_checkout_dispatches', 'operation_id', op.id), 'membership_checkout_uncertain', 409);
      await account(c); check(same(await signed(input), original), 'membership_checkout_source_changed', 409);
      c = await context(linked.purchase_id, tokenHash, original); operation(op, c);
      // This RPC must COMMIT before returning. The read is a separate transaction.
      const ack = await rpc('membership_v2_claim_checkout_dispatch', { p_operation: op.id, p_token_hash: tokenHash, p_nonce: nonce });
      check(exact(ack, ['action', 'operation_id']) && ack.action === 'dispatch_claimed' && ack.operation_id === op.id);
      const dispatch = await row('membership_v2_checkout_dispatches', 'operation_id', op.id);
      check(dispatch?.operation_id === op.id && dispatch.dispatch_hash === dispatchHash(op.id, op.source_digest, nonce) && dispatch.claim_nonce === null
        && Number.isFinite(Date.parse(dispatch.started_at)) && Date.parse(dispatch.started_at) >= Date.parse(op.created_at));
      c = await context(linked.purchase_id, tokenHash, original);
      check(op.expires_epoch >= Math.floor(Date.parse(c.observed_at) / 1000) + 1930
        && Date.parse(c.observed_at) >= Date.parse(dispatch.started_at) && Date.parse(c.observed_at) < Date.parse(dispatch.started_at) + 30000);
      const created = await provider(() => stripe.checkout.sessions.create(structuredClone(op.request_body),
        { ...OPTIONS, idempotencyKey: op.idempotency_key }));
      verified = await retrieve(op, c, created?.id); let bindAck;
      try { bindAck = await db.rpc('membership_v2_bind_checkout', { p_operation: op.id, p_token_hash: tokenHash, p_proof: verified.attestation }); }
      catch (_) { /* No retry; record may have committed. */ }
      binding = await row('membership_v2_checkout_bindings', 'operation_id', op.id);
      check(binding?.operation_id === op.id && binding.session_id === verified.attestation.session_id && same(binding.proof, verified.attestation)
        && binding.provider_account_id === c.context.provider_account_id && binding.livemode === c.context.livemode);
      if (bindAck && !bindAck.error) check(exact(bindAck.data, ['action', 'operation_id', 'session_id'])
        && ['bound', 'existing'].includes(bindAck.data.action) && bindAck.data.operation_id === op.id && bindAck.data.session_id === binding.session_id);
    }
    check(same(await signed(input), original), 'membership_checkout_source_changed', 409);
    const fresh = await context(linked.purchase_id, tokenHash, original); operation(op, fresh);
    check(op.expires_epoch > Math.floor(Date.parse(fresh.observed_at) / 1000)); version();
    return Object.freeze({ purchase_id: linked.purchase_id, checkout_url: verified.url,
      account_ownership_verified: false, activation_enabled: false, paid_receipt_verified: false });
  } });
}

module.exports = { createMembershipCheckoutExecutor };
