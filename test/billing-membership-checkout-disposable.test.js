'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict'), crypto = require('node:crypto');
const { h, setup } = require('./fixtures/membership-checkout-pg');
const { createMembershipCheckoutExecutor } = require('../src/services/membershipCheckoutExecutor');
const { createMembershipCheckoutTransport } = require('../src/services/membershipCheckoutTransport');
for (const planKey of ['basic', 'pro']) for (const commitmentMonths of [3, 6, 12])
  for (const paymentOption of ['prepaid', 'monthly_installments']) for (const firstRolePrepaySelected of [false, true]) {
    test(`native Checkout ${planKey}/${commitmentMonths}/${paymentOption}/role:${firstRolePrepaySelected}`, h.opts, async () => {
      const x = setup({ planKey, commitmentMonths, paymentOption, firstRolePrepaySelected }); await x.sign();
      const result = await x.service.checkout(x.input), op = x.op(), offer = x.f.quote.offer, b = x.body();
      assert.equal(result.activation_enabled, false); assert.equal(result.account_ownership_verified, false); assert.equal(result.paid_receipt_verified, false);
      assert.equal(result.checkout_url, `https://checkout.stripe.com/c/pay/cs_test_SYNTHETIC_${op.id.replaceAll('-', '')}#provider-fragment`);
      assert.equal(b.line_items[0].price_data.unit_amount, offer.platform_payment_cents);
      assert.equal(b.line_items.length, firstRolePrepaySelected ? 2 : 1);
      if (firstRolePrepaySelected) assert.equal(b.line_items[1].price_data.unit_amount, planKey === 'basic' ? 35900 : 62900);
      assert.equal(b.line_items.reduce((n, l) => n + l.price_data.unit_amount, 0), offer.initial_payment_cents);
      assert.equal(b.expires_at, op.expires_epoch); assert.equal(b.payment_intent_data.setup_future_usage, 'off_session');
      assert.equal(op.expires_epoch, Math.min(Number(h.sql(`select floor(extract(epoch from expires_at))::bigint from membership_v2_issued_documents where id='${x.f.p.id}'`)),
        Math.floor(Date.parse(op.created_at) / 1000) + 86280));
      assert.equal(b.allow_promotion_codes, false); assert.equal(b.payment_method_types, undefined); assert.ok(!b.success_url.includes(x.input.token));
      assert.equal(x.providerCalls.filter(n => n === 'create').length, 1);
      // Lost HTTP response recovery uses the same bound provider session, not a new dispatch.
      const again = await x.service.checkout(x.input); assert.deepEqual(again, result);
      assert.equal(x.providerCalls.filter(n => n === 'create').length, 1);
      assert.equal(h.sql(`select count(*) from membership_v2_checkout_dispatches where operation_id='${op.id}'`), '1');
      assert.equal(h.sql('select count(*) from membership_v2_contracts'), '0');
    });
  }
test('native context initially disabled and wrong API/account/mode stop before create', h.opts, async () => {
  for (const hooks of [{ disabled: true }, { version: '2024-06-20' }, { responseVersion: '2024-06-20' }, { account: 'acct_OTHER' }, { live: true }]) {
    const x = setup({}, hooks); await x.sign(); await assert.rejects(x.service.checkout(x.input));
    assert.equal(x.providerCalls.filter(n => n === 'create').length, 0);
  }
});
test('lost operation acknowledgment recovers exact own proposal; lost dispatch acknowledgment never creates', h.opts, async () => {
  const x = setup({}, { afterRPC: name => name === 'membership_v2_claim_checkout_operation' ? { error: { code: 'NETWORK' } } : null });
  await x.sign(); await x.service.checkout(x.input); assert.equal(x.providerCalls.filter(n => n === 'create').length, 1);
  for (const outcome of ['throw', 'error', 'malformed']) {
    const y = setup({}, { afterRPC: name => {
      if (name !== 'membership_v2_claim_checkout_dispatch') return null;
      if (outcome === 'throw') throw Error('SYNTHETIC lost dispatch response');
      return outcome === 'error' ? { error: { code: 'NETWORK' } } : { data: { action: 'claimed' } };
    } }); await y.sign(); await assert.rejects(y.service.checkout(y.input));
    assert.equal(y.providerCalls.filter(n => n === 'create').length, 0);
    assert.equal(h.sql(`select count(*) from membership_v2_checkout_dispatches where operation_id='${y.op().id}'`), '1');
    await assert.rejects(y.service.checkout(y.input), { code: 'membership_checkout_uncertain' });
    assert.equal(y.providerCalls.filter(n => n === 'create').length, 0);
  }
});
test('provider create failure leaves committed marker and never retries or creates another key', h.opts, async () => {
  const x = setup({}, { onCreate: () => { throw Error('SYNTHETIC timeout'); } }); await x.sign();
  await assert.rejects(x.service.checkout(x.input)); await assert.rejects(x.service.checkout(x.input));
  assert.equal(x.providerCalls.filter(n => n === 'create').length, 1);
  assert.equal(h.sql(`select count(*) from membership_v2_checkout_bindings where operation_id='${x.op().id}'`), '0');
});
test('unknown binding acknowledgment reads exact committed identity without retry', h.opts, async () => {
  const x = setup({}, { afterRPC: name => name === 'membership_v2_bind_checkout' ? { error: { code: 'NETWORK' } } : null });
  await x.sign(); await x.service.checkout(x.input); assert.equal(x.calls.filter(n => n === 'membership_v2_bind_checkout').length, 1);
  assert.equal(x.providerCalls.filter(n => n === 'create').length, 1);
});
test('wrong/incomplete provider proof and forbidden URLs are held after one dispatch with no binding', h.opts, async () => {
  const hooks = [{ lines: r => { r.has_more = true; } }, { lines: r => { r.data[0].price.product.metadata.kind = 'other'; } },
    { session: r => { r.amount_total++; } }, { session: r => { r.expires_at++; } }, { session: r => { r.livemode = true; } },
    { session: r => { r.payment_status = 'paid'; } }, { session: r => { r.url = 'https://evil.invalid/c/pay/cs_test_SYNTHETIC'; } },
    { session: r => { r.url = 'https://checkout.stripe.com/c/pay/cs_test_OTHER'; } }, { session: r => { r.total_details.amount_tax = 1; } }];
  for (const hook of hooks) { const x = setup({}, hook); await x.sign(); await assert.rejects(x.service.checkout(x.input));
    assert.equal(x.providerCalls.filter(n => n === 'create').length, 1);
    assert.equal(h.sql(`select count(*) from membership_v2_checkout_bindings where operation_id='${x.op().id}'`), '0'); }
});
test('gate closing after provider effect records historical binding but returns no URL', h.opts, async () => {
  const x = setup({}, { onCreate: () => h.sql('update membership_v2_checkout_contexts set checkout_enabled=false') });
  await x.sign(); await assert.rejects(x.service.checkout(x.input));
  assert.equal(x.providerCalls.filter(n => n === 'create').length, 1);
  assert.equal(h.sql(`select count(*) from membership_v2_checkout_bindings where operation_id='${x.op().id}'`), '1');
});
test('actual signer capability and PDF bytes are rechecked, never browser price or account authority', h.opts, async () => {
  const x = setup(); await x.sign();
  for (const bad of [{ ...x.input, amount: 1 }, { ...x.input, token: 'X'.repeat(43) }]) await assert.rejects(x.service.checkout(bad));
  const path = h.sql(`select executed_pdf_path from membership_v2_document_acceptances where document_id='${x.f.p.id}'`);
  x.files.set(path, Buffer.from('%PDF-1.7\nALTERED SYNTHETIC\n%%EOF')); await assert.rejects(x.service.checkout(x.input));
  assert.equal(x.providerCalls.length, 0);
});
test('native guards reject forged derived columns, missing nonce, wrong capability and duplicate dispatch', h.opts, async () => {
  const x = setup(); await x.sign(); await x.service.checkout(x.input); const op = x.op();
  h.denied(`set role service_role;${h.insert('membership_v2_checkout_operations', { id: crypto.randomUUID(), purchase_id: op.purchase_id,
    context_id: x.contextId, request_body: { amount: 1 } })}`, /derived_fields_denied/);
  h.denied(`set role service_role;${h.insert('membership_v2_checkout_dispatches', { operation_id: op.id, dispatch_hash: 'a'.repeat(64) })}`, /dispatch_denied/);
  h.denied(`set role service_role;select membership_v2_claim_checkout_dispatch('${op.id}','${'f'.repeat(64)}','${'X'.repeat(43)}')`, /pending_purchase_source_denied/);
  h.denied(`set role service_role;select membership_v2_claim_checkout_dispatch('${op.id}','${x.f.p.signer_token_hash}','${'X'.repeat(43)}')`, /duplicate key/);
  assert.equal(h.sql(`select membership_v2_checkout_proof_matches('${op.id}','null'::jsonb)`), 'f');
  assert.equal(h.sql(`select membership_v2_checkout_proof_matches('${op.id}','[]'::jsonb)`), 'f');
});

test('zero-marker failure recovers the same immutable request on a fresh authorized call, even after 30 seconds', h.opts, async () => {
  let failOnce = true;
  const x = setup({}, { beforeRPC: name => {
    if (name === 'membership_v2_claim_checkout_dispatch' && failOnce) { failOnce = false; throw Error('SYNTHETIC pre-dispatch outage'); }
  } }); await x.sign(); await assert.rejects(x.service.checkout(x.input)); const initial = x.op();
  assert.equal(h.sql(`select count(*) from membership_v2_checkout_dispatches where operation_id='${initial.id}'`), '0');
  // Isolated privileged fixture: simulate an older operation, not a runtime
  // clock input, legal deadline rewrite, lease renewal or provider supersession.
  h.sql(`begin;alter table membership_v2_checkout_operations disable trigger membership_v2_checkout_operations_immutable;
    update membership_v2_checkout_operations set created_at=created_at-interval '1 minute' where id='${initial.id}';
    alter table membership_v2_checkout_operations enable trigger membership_v2_checkout_operations_immutable;commit;`);
  const recovered = await x.service.checkout(x.input); const after = x.op();
  assert.equal(after.id, initial.id); assert.deepEqual(after.request_body, initial.request_body); assert.equal(after.expires_epoch, initial.expires_epoch);
  assert.equal(after.idempotency_key, initial.idempotency_key); assert.equal(recovered.activation_enabled, false);
  assert.equal(x.providerCalls.filter(n => n === 'create').length, 1);
});
test('retrieved invoice metadata must echo native request, and created PaymentIntent settings are actually read', h.opts, async () => {
  // Before completion the provider's PI/Checkout customer may both be null.
  const y = setup({}, { session: r => { r.payment_intent = 'pi_SYNTHETIC'; } }); await y.sign();
  await y.service.checkout(y.input); assert.equal(y.providerCalls.filter(n => n === 'intent').length, 1);
  for (const hook of [{ session: r => { r.invoice_creation.invoice_data.metadata = {}; } },
    { session: r => { r.payment_intent = 'pi_SYNTHETIC'; }, intent: r => { r.setup_future_usage = null; } },
    { session: r => { r.payment_intent = 'pi_SYNTHETIC'; }, intent: r => { r.capture_method = 'manual'; } },
    { session: r => { r.payment_intent = 'pi_SYNTHETIC'; }, intent: r => { r.metadata = {}; } },
    { session: r => { r.payment_intent = 'pi_SYNTHETIC'; }, intent: r => { r.livemode = true; } },
    { session: r => { r.payment_intent = undefined; } }]) {
    const z = setup({}, hook); await z.sign(); await assert.rejects(z.service.checkout(z.input));
    assert.equal(h.sql(`select count(*) from membership_v2_checkout_bindings where operation_id='${z.op().id}'`), '0');
  }
});
test('RLS and ACL deny browser read/write/RPC, service mutations and context updates; triggers deny owner truncate', h.opts, async () => {
  const x = setup(); await x.sign(); await x.service.checkout(x.input);
  for (const table of ['contexts', 'operations', 'dispatches', 'bindings']) {
    const name = `membership_v2_checkout_${table}`;
    assert.equal(h.sql(`select relrowsecurity and relforcerowsecurity from pg_class where oid='${name}'::regclass`), 't');
    for (const role of ['anon', 'authenticated']) for (const q of [`select * from ${name}`, `delete from ${name}`, `truncate ${name}`])
      h.denied(`set role ${role};${q}`, /permission denied/);
    for (const q of [`update ${name} set ${table === 'contexts' ? 'checkout_enabled=checkout_enabled' : 'operation_id=operation_id'}`, `delete from ${name}`, `truncate ${name}`]) {
      if (table === 'operations' && q.includes('operation_id=operation_id')) continue;
      h.denied(`set role service_role;${q}`, /permission denied/);
    }
    h.denied(`truncate ${name} cascade`, /immutable/);
  }
  h.denied(`set role authenticated;select membership_v2_checkout_context('${x.op().purchase_id}','${x.f.p.signer_token_hash}','${x.contextId}',true)`, /permission denied/);
  h.denied("update membership_v2_checkout_contexts set frontend_origin='https://evil.invalid'", /immutable_checkout_context/);
  h.denied(`set role service_role;update membership_v2_checkout_operations set context_id='${x.contextId}'`, /permission denied/);
});
test('same signed sale racing native claims creates exactly one operation, dispatch and provider session', h.opts, async () => {
  const x = setup({}, { concurrent: true }); await x.sign();
  const results = await Promise.allSettled([x.service.checkout(x.input), x.service.checkout(x.input)]);
  assert.ok(results.some(r => r.status === 'fulfilled'));
  const delivered = results.filter(r => r.status === 'fulfilled').map(r => r.value.checkout_url);
  assert.equal(new Set(delivered).size, 1);
  assert.equal(x.providerCalls.filter(n => n === 'create').length, 1);
  assert.equal(h.sql(`select count(*) from membership_v2_checkout_operations where purchase_id='${x.op().purchase_id}'`), '1');
});
test('client rejects implicit SDK retries and connected-account override', h.opts, async () => {
  for (const key of ['stripeAccount', 'retry']) {
    const x = setup(); await x.sign();
    const stripe = { ...x.stripe, getApiField: k => k === 'version' ? '2023-10-16' : (key === 'stripeAccount' ? 'acct_OTHER' : undefined),
      getMaxNetworkRetries: () => key === 'retry' ? 2 : 0 };
    const s = createMembershipCheckoutExecutor({ db: x.db, signing: x.signing, stripe, environment: 'dev', contextId: x.contextId });
    await assert.rejects(s.checkout(x.input)); assert.equal(x.providerCalls.length, 0);
  }
});

// Actual installed stripe-node transport against loopback only. This proves
// serialization/version/retry behavior, NOT hosted Stripe/mandate acceptance.
async function sdkTransport(x, failCreate, run) {
  const http = require('node:http'), Stripe = require('stripe'), requests = [];
  function flatten(value, prefix = '', result = {}) {
    if (value && typeof value === 'object') for (const [k, v] of Object.entries(value))
      flatten(v, prefix ? `${prefix}[${k}]` : k, result);
    else result[prefix] = String(value);
    return result;
  }
  const server = http.createServer(async (req, res) => {
    let body = ''; for await (const b of req) body += b;
    const u = new URL(req.url, 'http://127.0.0.1'), observed = { method: req.method, path: u.pathname, body };
    requests.push(observed); let reply;
    try {
      assert.equal(req.headers['stripe-version'], '2023-10-16'); assert.equal(req.headers['stripe-account'], undefined);
      const options = { maxNetworkRetries: 0, timeout: 10000 };
      if (req.method === 'GET' && !u.pathname.endsWith('/line_items')) { assert.equal(u.search, ''); assert.equal(body, ''); }
      if (u.pathname === '/v1/account') reply = await x.stripe.accounts.retrieve({}, options);
      else if (u.pathname === '/v1/balance') reply = await x.stripe.balance.retrieve({}, options);
      else if (req.method === 'POST' && u.pathname === '/v1/checkout/sessions') {
        const op = x.op(); assert.equal(req.headers['idempotency-key'], op.idempotency_key);
        assert.deepEqual(Object.fromEntries(new URLSearchParams(body)), flatten(op.request_body));
        if (failCreate === true) { res.writeHead(500, { 'Content-Type': 'application/json', 'Stripe-Version': '2023-10-16' });
          res.end(JSON.stringify({ error: { type: 'api_error', message: 'SYNTHETIC provider unavailable' } })); return; }
        reply = await x.stripe.checkout.sessions.create(op.request_body, { ...options, idempotencyKey: op.idempotency_key });
        if (failCreate === 'connection-reset') { req.socket.destroy(); return; }
      } else if (u.pathname.endsWith('/line_items')) {
        assert.equal(u.searchParams.get('limit'), '100'); assert.equal(u.searchParams.get('expand[0]'), 'data.price.product');
        reply = await x.stripe.checkout.sessions.listLineItems(u.pathname.split('/').at(-2), { limit: 100, expand: ['data.price.product'] }, options);
      } else if (u.pathname.startsWith('/v1/payment_intents/')) reply = await x.stripe.paymentIntents.retrieve(u.pathname.split('/').at(-1), {}, options);
      else reply = await x.stripe.checkout.sessions.retrieve(u.pathname.split('/').at(-1), {}, options);
      delete reply.lastResponse;
      res.writeHead(200, { 'Content-Type': 'application/json', 'Stripe-Version': '2023-10-16' }); res.end(JSON.stringify(reply));
    } catch (error) {
      observed.failure = error.message; res.writeHead(400, { 'Content-Type': 'application/json', 'Stripe-Version': '2023-10-16' });
      res.end(JSON.stringify({ error: { type: 'invalid_request_error', message: 'SYNTHETIC transport assertion failed' } }));
    }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  try {
    const client = Stripe.createNodeHttpClient(), send = client.makeRequest.bind(client), transportCalls = [];
    client.makeRequest = async (...args) => {
      const call = { path: args[2], timeout: args[7] }; transportCalls.push(call);
      try { return await send(...args); } catch (error) { call.errorCode = error.code; throw error; }
    };
    const stripe = new Stripe('sk_test_SYNTHETIC_ONLY_NOT_A_SECRET', { apiVersion: '2023-10-16', maxNetworkRetries: 0,
      timeout: 60000, httpClient: createMembershipCheckoutTransport(client), protocol: 'http', host: '127.0.0.1', port: server.address().port });
    const service = createMembershipCheckoutExecutor({ db: x.db, signing: x.signing, stripe, environment: 'dev', contextId: x.contextId });
    await run(service, requests); assert.deepEqual(requests.filter(r => r.failure), []);
    assert.ok(transportCalls.length > 0); assert.ok(transportCalls.every(c => c.timeout === 10000));
    if (failCreate === 'connection-reset') assert.deepEqual(transportCalls.filter(c => c.errorCode).map(c => c.errorCode), ['ECONNRESET']);
  } finally { await new Promise(resolve => server.close(resolve)); }
}
test('installed Stripe SDK sends the exact 2023 body/expiry/idempotency header and reads bound session without recreating', h.opts, async () => {
  const x = setup({ paymentOption: 'monthly_installments', firstRolePrepaySelected: true }); await x.sign();
  await sdkTransport(x, false, async (service, requests) => {
    const a = await service.checkout(x.input), b = await service.checkout(x.input); assert.deepEqual(a, b);
    assert.equal(requests.filter(r => r.method === 'POST').length, 1);
    assert.equal(h.sql(`select count(*) from membership_v2_checkout_bindings where operation_id='${x.op().id}'`), '1');
  });
});
test('installed Stripe SDK does not retry a 500; subsequent request cannot replace the committed dispatch', h.opts, async () => {
  const x = setup(); await x.sign(); await sdkTransport(x, true, async (service, requests) => {
    await assert.rejects(service.checkout(x.input)); await assert.rejects(service.checkout(x.input));
    assert.equal(requests.filter(r => r.method === 'POST').length, 1);
    assert.equal(h.sql(`select count(*) from membership_v2_checkout_bindings where operation_id='${x.op().id}'`), '0');
  });
});
test('installed SDK actually retrieves an existing PaymentIntent with empty params and pinned request options', h.opts, async () => {
  const x = setup({}, { session: r => { r.payment_intent = 'pi_SYNTHETIC'; } }); await x.sign();
  await sdkTransport(x, false, async (service, requests) => {
    await service.checkout(x.input); assert.equal(requests.filter(r => r.path === '/v1/payment_intents/pi_SYNTHETIC').length, 1);
    assert.equal(requests.filter(r => r.method === 'POST').length, 1);
  });
});
test('actual socket reset after provider create causes one POST, permanent hold and no SDK forced replay', h.opts, async () => {
  const x = setup(); await x.sign(); await sdkTransport(x, 'connection-reset', async (service, requests) => {
    await assert.rejects(service.checkout(x.input)); await assert.rejects(service.checkout(x.input));
    assert.equal(requests.filter(r => r.method === 'POST').length, 1);
    assert.equal(x.providerCalls.filter(n => n === 'create').length, 1);
    assert.equal(h.sql(`select count(*) from membership_v2_checkout_bindings where operation_id='${x.op().id}'`), '0');
  });
});
test('unprotected SDK transport is rejected before provider I/O', h.opts, async () => {
  const x = setup(); await x.sign();
  const stripe = { ...x.stripe, getApiField: k => k === 'httpClient' ? { makeRequest() {} } : x.stripe.getApiField(k) };
  const service = createMembershipCheckoutExecutor({ db: x.db, signing: x.signing, stripe, environment: 'dev', contextId: x.contextId });
  await assert.rejects(service.checkout(x.input), { code: 'membership_checkout_provider_mismatch' }); assert.equal(x.providerCalls.length, 0);
});

test('native expiry calculator respects an earlier deadline, 30m minimum plus tolerance, and 24h upper tolerance', h.opts, () => {
  const start = '2026-10-12T12:00:00Z';
  assert.equal(h.sql(`select membership_v2_checkout_window('${start}'::timestamptz+interval '2 hours','${start}')`), String(Date.parse(start) / 1000 + 7200));
  assert.equal(h.sql(`select membership_v2_checkout_window('${start}'::timestamptz+interval '2 days','${start}')`), String(Date.parse(start) / 1000 + 86280));
  for (const minutes of [29, 30, 31, 32]) h.denied(`select membership_v2_checkout_window('${start}'::timestamptz+interval '${minutes} minutes','${start}')`, /checkout_window_closed/);
  assert.equal(h.sql(`select membership_v2_checkout_window('${start}'::timestamptz+interval '33 minutes','${start}')`), String(Date.parse(start) / 1000 + 1980));
  h.denied(`select membership_v2_checkout_window('infinity','${start}')`, /checkout_window_closed/);
});
test('native dispatch blocked on a disabled context rechecks the committed gate and writes no marker', h.opts, async () => {
  let operationId;
  const x = setup({}, { beforeRPC: async (name, p) => {
    if (name !== 'membership_v2_claim_checkout_dispatch') return;
    operationId = p.p_operation;
    const writer = h.asyncSQL(`/* CHECKOUT_CONTEXT_HELD */begin;update membership_v2_checkout_contexts set checkout_enabled=false
      where id='${x.contextId}';select pg_sleep(0.8);commit;`);
    await h.sleeping('CHECKOUT_CONTEXT_HELD');
    const reader = h.asyncSQL(`/* CHECKOUT_CONTEXT_WAIT */set role service_role;select membership_v2_claim_checkout_dispatch(
      '${p.p_operation}','${p.p_token_hash}','${p.p_nonce}')`);
    await h.blocked('CHECKOUT_CONTEXT_WAIT'); const [w, r] = await Promise.all([writer.done, reader.done]);
    assert.equal(w.status, 0, w.err); assert.notEqual(r.status, 0); assert.match(r.err, /checkout_gate_closed/);
  } }); await x.sign(); await assert.rejects(x.service.checkout(x.input));
  assert.ok(operationId); assert.equal(h.sql(`select count(*) from membership_v2_checkout_dispatches where operation_id='${operationId}'`), '0');
  assert.equal(x.providerCalls.filter(n => n === 'create').length, 0);
});
test('migration erases ambient browser defaults, pins invoker/definer search paths, and leaves every trigger enabled', h.opts, () => {
  for (const role of ['anon', 'authenticated']) {
    assert.equal(h.sql(`select count(*) from information_schema.role_table_grants where grantee='${role}' and table_name like 'membership_v2_checkout_%'`), '0');
    assert.equal(h.sql(`select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public'
      and p.proname ~ '^membership_v2_(checkout|guard_checkout|claim_checkout|bind_checkout|lock_checkout)'
      and has_function_privilege('${role}',p.oid,'execute')`), '0');
  }
  assert.equal(h.sql(`select count(*) from pg_trigger where not tgisinternal and tgrelid in
    (select oid from pg_class where relname like 'membership_v2_checkout_%') and tgenabled<>'O'`), '0');
  assert.equal(h.sql(`select count(*) from pg_proc where proname ~ '^membership_v2_(checkout|guard_checkout|claim_checkout|bind_checkout|lock_checkout)'
    and proconfig is distinct from array['search_path=pg_catalog']`), '0');
  assert.equal(h.sql(`select count(*) from pg_proc where proname ~ '^membership_v2_(checkout|guard_checkout|claim_checkout|bind_checkout|lock_checkout)'
    and prosecdef and proname<>'membership_v2_lock_checkout_context'`), '0');
});
