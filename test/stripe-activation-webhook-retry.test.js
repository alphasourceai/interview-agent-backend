'use strict'

const assert = require('node:assert/strict')
const path = require('node:path')
const { test } = require('node:test')

let currentEvent = null
const fakeStripe = {
  webhooks: { constructEvent() { return currentEvent } },
  subscriptions: { async retrieve() { throw new Error('Unexpected subscription lookup') } }
}
const stripePath = require.resolve('stripe')
require.cache[stripePath] = {
  id: stripePath, filename: stripePath, loaded: true,
  exports: function StripeStub() { return fakeStripe }
}

const state = { billingEvent: null, claimStatus: 'activation_in_progress', claimCalls: 0 }
const fakeDb = {
  async rpc(name) {
    assert.equal(name, 'claim_public_purchase_activation')
    state.claimCalls += 1
    return { data: { status: state.claimStatus, intent_id: 'intent-qa' }, error: null }
  },
  from(table) {
    assert.equal(table, 'billing_events')
    const query = {
      action: null, payload: null, filters: [],
      insert(payload) { this.action = 'insert'; this.payload = payload; return this },
      update(payload) { this.action = 'update'; this.payload = payload; return this },
      select() { this.action = 'select'; return this },
      eq(column, value) { this.filters.push({ column, value }); return this },
      neq() { return this },
      async maybeSingle() { return { data: state.billingEvent && { ...state.billingEvent }, error: null } },
      then(resolve, reject) {
        try {
          if (this.action === 'insert') {
            if (state.billingEvent) return resolve({ error: { code: '23505', message: 'duplicate key' } })
            state.billingEvent = { ...this.payload, processed_ok: false }
          } else if (this.action === 'update' && state.billingEvent) {
            if (!(this.payload.processed_ok === false && state.billingEvent.processed_ok === true)) {
              Object.assign(state.billingEvent, this.payload)
            }
          }
          return resolve({ error: null })
        } catch (error) { return reject(error) }
      }
    }
    return query
  }
}
const supabaseClientPath = path.join(__dirname, '..', 'src', 'clients', 'supabase.js')
const enterpriseWebhookPath = path.join(__dirname, '..', 'src', 'services', 'existingEnterprisePaymentWebhook.js')
require.cache[supabaseClientPath] = {
  id: supabaseClientPath, filename: supabaseClientPath, loaded: true,
  exports: { supabaseAdmin: fakeDb }
}
require.cache[enterpriseWebhookPath] = {
  id: enterpriseWebhookPath, filename: enterpriseWebhookPath, loaded: true,
  exports: { classifyExistingEnterprisePaymentEvent: async () => null }
}

const router = require('../src/routes/webhooks/stripe')
const handler = router.stack.find((layer) => layer.route?.path === '/').route.stack[0].handle

async function invoke(event) {
  currentEvent = event
  const response = {
    code: null, body: null,
    status(code) { this.code = code; return this },
    json(body) { this.body = body; return this }
  }
  await handler({ body: Buffer.from('{}'), headers: { 'stripe-signature': 'qa-only' }, request_id: 'qa-request' }, response)
  return response
}

function paidAgreementEvent(id = 'evt_qa_1') {
  return {
    id, type: 'checkout.session.completed', created: 1780000000,
    data: { object: {
      id: 'cs_qa_1', mode: 'subscription', payment_status: 'paid',
      metadata: { source: 'agreement_checkout', agreement_id: 'agreement-qa' }
    } }
  }
}

test('fresh lease produces retryable 503 and leaves the paid billing event incomplete', async () => {
  state.billingEvent = null
  state.claimCalls = 0
  state.claimStatus = 'activation_in_progress'
  const response = await invoke(paidAgreementEvent())
  assert.equal(response.code, 503)
  assert.equal(response.body.code, 'AGREEMENT_ACTIVATION_RETRY_REQUIRED')
  assert.equal(state.billingEvent.processed_ok, false)
  assert.equal(state.claimCalls, 1)
})

test('same incomplete paid event re-enters while a completed event is a no-op', async () => {
  const retry = await invoke(paidAgreementEvent())
  assert.equal(retry.code, 503)
  assert.equal(state.claimCalls, 2)
  assert.equal(state.billingEvent.processed_ok, false)

  state.billingEvent.processed_ok = true
  const completed = await invoke(paidAgreementEvent())
  assert.equal(completed.code, 200)
  assert.equal(state.claimCalls, 2)
})

test('duplicate unrelated event remains a 200 no-op', async () => {
  state.billingEvent = { stripe_event_id: 'evt_unrelated', processed_ok: false }
  const response = await invoke({ id: 'evt_unrelated', type: 'customer.updated', data: { object: {} } })
  assert.equal(response.code, 200)
  assert.equal(state.claimCalls, 2)
})
