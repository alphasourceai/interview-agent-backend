'use strict';

// LOCAL/UNMOUNTED adapter for createImmediateUsageInvoice's accepted Usage
// branch. Existing cron/admin entry/auth remain the only future callers. No
// new route, collection scheduler, account setup or subscription mutation.
const { snapshotStripeSdkData: sdk } = require('./enterprisePoolPaymentProof');
const { prepareAndReserveEnterpriseExistingUsage: reserve, readEnterpriseExistingUsageProvider: read,
  changeEnterpriseExistingUsageProvider: change } = require('./enterpriseExistingUsageReservation');
const p = require('./enterpriseExistingUsageInvoiceProof');
const check = v => { if (!v) throw Object.assign(new Error('enterprise_usage_invoice_held'),
  { code: 'enterprise_usage_invoice_held', status: 409 }); };
const stateResult = (status, extra = {}) => ({ status, ...extra, provider_effect_authorized: false,
  paid_access_authorized: false, payroll_authorized: false });

async function invoiceEnterpriseExistingUsage({ db, stripe, billingClientId, effectsEnabled = false, maxSteps = 8 }) {
  require('../config/guardedPricingDev').assertGuardedDevOutboundAllowed();
  if (effectsEnabled !== true) return stateResult('disabled');
  check(Number.isSafeInteger(maxSteps) && maxSteps >= 1 && maxSteps <= 50);
  const api = () => check(stripe?.getApiField('version') === '2023-10-16');
  async function provider(fn) { api(); try { return sdk(await fn()); } catch (e) {
    if (e?.code === 'enterprise_usage_invoice_held') throw e;
    throw Object.assign(new Error('enterprise_usage_invoice_unknown'), { code: 'enterprise_usage_invoice_unknown', status: 503 });
  } }
  const get = batchId => read({ db, billingClientId, ...(batchId ? { batchId } : {}) });
  async function command(state, action, step, extra = {}) {
    return change({ db, state, action, step, ...extra });
  }
  async function method(b) {
    const customer = await provider(() => stripe.customers.retrieve(b.customer_id));
    const subscription = await provider(() => stripe.subscriptions.retrieve(b.subscription_id));
    const cd = customer.invoice_settings?.default_payment_method, sd = subscription.default_payment_method;
    check((cd === null || typeof cd === 'string') && (sd === null || typeof sd === 'string')
      && !(cd && sd && cd !== sd) && /^pm_[A-Za-z0-9_]+$/.test(cd || sd || ''));
    return p.selectUsageInvoicePaymentMethod({ binding: b, customer, subscription,
      paymentMethod: await provider(() => stripe.paymentMethods.retrieve(cd || sd)) });
  }
  function stepAfter(state) {
    const leaf = state.batch.provider_operation, groups = state.binding.groups;
    if (!leaf?.step) return 'invoice';
    const step = leaf.step, op = leaf.operations[step];
    if (!op.proof) return step;
    if (step === 'invoice') return `item:${groups[0].role_id}`;
    if (step.startsWith('item:')) {
      const n = groups.findIndex(g => g.role_id === step.slice(5)); check(n >= 0);
      return n + 1 < groups.length ? `item:${groups[n + 1].role_id}` : 'finalize';
    }
    return step === 'finalize' ? 'pay' : null;
  }
  function phase(state, census, n, stage) {
    const b = state.binding, invoiceId = state.batch.provider_operation.invoice_id;
    return p.verifyUsageInvoicePhase({ binding: b, invoiceId, invoice: census.invoice,
      items: census.items, lines: census.lines, provenRoleIds: b.groups.slice(0, n).map(g => g.role_id),
      stage, replayInvoiceId: stage === 'shell' ? invoiceId : null });
  }
  async function paid(state, census) {
    const i = census.invoice, b = state.binding, leaf = state.batch.provider_operation;
    check(/^pi_[A-Za-z0-9_]+$/.test(i?.payment_intent || '') && /^ch_[A-Za-z0-9_]+$/.test(i?.charge || ''));
    const paymentIntent = await provider(() => stripe.paymentIntents.retrieve(i.payment_intent));
    const charge = await provider(() => stripe.charges.retrieve(i.charge));
    const refunds = await p.completePages(args => provider(() => stripe.refunds.list({ charge: i.charge, ...args })), 're');
    // A fresh native observation supplies the readback upper bound, not a
    // browser/client clock and not a provider/bank settlement timestamp.
    const current = await get(state.batch.id);
    const proof = p.verifyUsageInvoicePaid({ binding: b, invoiceId: leaf.invoice_id, invoice: i,
      items: census.items, lines: census.lines, paymentMethodId: leaf.operations.pay.request.body.payment_method,
      paymentIntent, charge, refunds, observationEpoch: Math.floor(Date.parse(current.observed_at) / 1000) });
    return { current, proof };
  }
  let state = await get();
  if (state.status === 'not_due') {
    const prepared = await reserve({ db, billingClientId });
    if (prepared.phase !== 'reserved') return stateResult(prepared.phase);
    state = await get(prepared.batch_id);
  }
  const batchId = state.batch.id, ownedLeases = new Set();
  for (let n = 0; n < maxSteps; n++) {
    state = await get(batchId); const b = state.binding, leaf = state.batch.provider_operation;
    if (leaf?.status === 'paid') return stateResult('paid', { batch_id: batchId, invoice_id: leaf.invoice_id });
    // Resume the single post-finalize ledger stamp before storing a pay step.
    if (leaf?.step === 'finalize' && leaf.operations.finalize.proof) {
      const claim = ownedLeases.has(leaf.lease_id) && Date.parse(leaf.claimed_until)>Date.parse(state.observed_at)
        ? {leaf} : await command(state, 'claim', 'finalize');
      if (claim.status === 'busy') return stateResult('busy', { batch_id: batchId });
      state = await get(batchId);
      await command(state, 'stamp', 'finalize', { leaseId: claim.leaf.lease_id });
      state = await get(batchId);
    }
    const step = stepAfter(state); check(step);
    let request, currentOp = state.batch.provider_operation?.operations[step];
    if (!currentOp) {
      const invoiceId = state.batch.provider_operation?.invoice_id;
      if (step === 'invoice') request = p.usageInvoiceCreateRequest(b);
      else if (step.startsWith('item:')) request = p.usageInvoiceItemRequest(b, invoiceId, step.slice(5));
      else if (step === 'finalize') request = p.usageInvoiceFinalizeRequest(b, invoiceId);
      else {
        const census = await p.readUsageInvoiceCensus({ stripe, binding: b, invoiceId });
        phase(state, census, b.groups.length, 'finalized');
        request = p.usageInvoicePayRequest(b, invoiceId, await method(b));
        state = await get(batchId);
      }
      await command(state, 'store', step, { request }); state = await get(batchId);
      currentOp = state.batch.provider_operation.operations[step];
    }
    const claim = await command(state, 'claim', step);
    if (claim.status === 'busy') return stateResult('busy', { batch_id: batchId });
    const leaseId = claim.leaf.lease_id;
    ownedLeases.add(leaseId);
    state = await get(batchId); request = state.batch.provider_operation.operations[step].request;
    const invoiceId = state.batch.provider_operation.invoice_id;
    let census = await p.readUsageInvoiceCensus({ stripe, binding: b, invoiceId });
    let readback = null;
    const groupCount = step.startsWith('item:') ? b.groups.findIndex(g => g.role_id === step.slice(5)) + 1 : b.groups.length;
    if (currentOp.sent_at) {
      if (step.startsWith('item:') || step === 'finalize') {
        try { readback = phase(state, census, groupCount, step === 'finalize' ? 'finalized' : 'items'); }
        catch (e) { if (e.code !== 'enterprise_usage_invoice_held') throw e; }
      } else if (step === 'pay' && census.invoice?.status === 'paid') {
        const result = await paid(state, census); state = result.current; readback = result.proof;
      }
    }
    if (!readback) {
      if (step.startsWith('item:')) phase(state, census, groupCount - 1, groupCount === 1 ? 'shell' : 'items');
      else if (step === 'finalize') phase(state, census, groupCount, 'items');
      else if (step === 'pay') {
        phase(state, census, groupCount, 'finalized'); check(await method(b) === request.body.payment_method);
      } else {
        const matches=census.invoices.filter(i=>i.metadata?.enterprise_usage_batch_id===batchId);
        check(matches.length<=(currentOp.sent_at?1:0));
      }
      state = await get(batchId);
      // Native CAS records first sent_at before any SDK write and rejects a
      // late resend. A timeout is left unknown on that SAME key/body/step.
      await command(state, 'sent', step, { leaseId });
      let ack;
      if (step === 'invoice') ack = await provider(() => stripe.invoices.create(request.body, { idempotencyKey: request.key }));
      else if (step.startsWith('item:')) ack = await provider(() => stripe.invoiceItems.create(request.body, { idempotencyKey: request.key }));
      else if (step === 'finalize') ack = await provider(() => stripe.invoices.finalizeInvoice(invoiceId, request.body, { idempotencyKey: request.key }));
      else ack = await provider(() => stripe.invoices.pay(invoiceId, request.body, { idempotencyKey: request.key }));
      check(typeof ack?.id === 'string');
      state = await get(batchId);
      census = await p.readUsageInvoiceCensus({ stripe, binding: b, invoiceId: step === 'invoice' ? ack.id : invoiceId });
      if (step === 'invoice') {
        readback = p.verifyUsageInvoicePhase({ binding: b, invoiceId: ack.id, invoice: census.invoice, items: census.items,
          lines: census.lines, provenRoleIds: [], stage: 'shell', replayInvoiceId: ack.id });
      } else if (step === 'pay') {
        check(ack.id === invoiceId); const result = await paid(state, census); state = result.current; readback = result.proof;
      } else {
        readback = phase(state, census, groupCount, step === 'finalize' ? 'finalized' : 'items');
        check(step === 'finalize' ? ack.id === invoiceId : readback.items.some(i => i.role_id === step.slice(5) && i.invoice_item_id === ack.id));
      }
    }
    state = await get(batchId);
    const result = await command(state, 'observe', step, { leaseId, proof: readback });
    if (result.leaf.status === 'paid') return stateResult('paid', { batch_id: batchId, invoice_id: result.leaf.invoice_id });
  }
  return stateResult('pending', { batch_id: batchId });
}
module.exports = { invoiceEnterpriseExistingUsage };
