'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { test } = require('node:test')

const supabaseClientPath = path.join(__dirname, '..', 'src', 'clients', 'supabase.js')
require.cache[supabaseClientPath] = {
  id: supabaseClientPath,
  filename: supabaseClientPath,
  loaded: true,
  exports: { supabaseAdmin: {} }
}

const { promotionEligibilityError, replacementCheckoutDisposition } = require('../src/routes/sales')
const {
  shouldApplyGenericSubscriptionUpdate,
  claimAgreementPurchaseActivation,
  releaseAgreementPurchaseActivationClaim,
  isInitialAgreementCheckoutInvoice,
  markAgreementCheckoutPaid
} = require('../src/routes/webhooks/stripe')
const { buildExecutedMembershipAgreementHtml } = require('../src/routes/public/membershipAgreements/signing')

test('sales promotion validation rejects restrictions that cannot be honored before checkout', () => {
  const pricing = { platform_fee_cents: 29900, first_role_prepay_cents: 0 }
  assert.match(
    promotionEligibilityError({ restrictions: { first_time_transaction: true } }, pricing),
    /customer history/i
  )
  assert.match(
    promotionEligibilityError({ restrictions: { minimum_amount: 40000, minimum_amount_currency: 'usd' } }, pricing),
    /minimum/i
  )
  assert.match(
    promotionEligibilityError({ coupon: { applies_to: { products: ['prod_restricted'] } } }, pricing),
    /product-restricted/i
  )
  assert.match(
    promotionEligibilityError({ coupon: { amount_off: 1000, currency: 'eur' } }, pricing),
    /USD/i
  )
  assert.equal(promotionEligibilityError({ restrictions: {} }, pricing), '')
})

test('expired agreement replacement refuses completed or paid Stripe sessions', () => {
  assert.equal(replacementCheckoutDisposition({ status: 'complete', payment_status: 'unpaid' }), 'paid')
  assert.equal(replacementCheckoutDisposition({ status: 'open', payment_status: 'paid' }), 'paid')
  assert.equal(replacementCheckoutDisposition({ status: 'open', payment_status: 'unpaid' }), 'open')
  assert.equal(replacementCheckoutDisposition({ status: 'expired', payment_status: 'unpaid' }), 'expired')
  assert.equal(replacementCheckoutDisposition(null), 'missing')
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'sales', 'index.js'), 'utf8')
  assert.match(source, /checkout\.sessions\.retrieve\(checkoutSessionId\)/)
  assert.match(source, /agreement_already_paid/)
  assert.match(source, /replace_sales_assisted_agreement/)
})

test('sales migration prevents preview reuse and concurrent active buyer duplicates', () => {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'supabase', 'migrations', '20260918195401_sales_workspace.sql'), 'utf8')
  assert.match(sql, /add column if not exists sales_preview_id uuid references public\.sales_deal_previews\(id\)/i)
  assert.match(sql, /create unique index if not exists public_purchase_intents_sales_preview_uidx/i)
  assert.match(sql, /create unique index if not exists public_purchase_intents_active_sales_buyer_uidx[\s\S]*lower\(buyer_email\)[\s\S]*channel = 'sales_assisted'/i)
  assert.match(sql, /alter column initial_term_start drop not null[\s\S]*alter column initial_renewal_date drop not null/i)
  assert.match(sql, /sales_preview_id uuid references public\.sales_deal_previews\(id\) on delete restrict/i)
  assert.match(sql, /add column if not exists activation_claimed_at timestamptz/i)
  assert.match(sql, /add column if not exists activation_claim_key text/i)
})

function activationClaimDb(intent, options = {}) {
  const state = { intent: intent ? { ...intent } : null }
  return {
    state,
    async rpc(name, args) {
      const row = state.intent
      if (name === 'claim_public_purchase_activation') {
        if (options.beforeClaim) options.beforeClaim(state)
        if (!row || row.agreement_id !== args.p_agreement_id) {
          return { data: { status: row ? 'agreement_superseded' : 'no_intent', intent_id: row?.id }, error: null }
        }
        if (row.status === 'canceled' || row.canceled_at) {
          return { data: { status: 'purchase_canceled', intent_id: row.id }, error: null }
        }
        if (row.activation_claimed_at && Date.parse(row.activation_claimed_at) >= Date.now() - 300000) {
          return { data: { status: 'activation_in_progress', intent_id: row.id }, error: null }
        }
        row.activation_claimed_at = new Date().toISOString()
        row.activation_claim_key = args.p_claim_key
        return { data: { status: 'claimed', intent_id: row.id }, error: null }
      }
      if (name === 'heartbeat_public_purchase_activation') {
        if (!row || row.id !== args.p_intent_id || row.activation_claim_key !== args.p_claim_key || !row.activation_claimed_at) {
          return { data: false, error: null }
        }
        row.activation_claimed_at = new Date().toISOString()
        return { data: true, error: null }
      }
      if (name === 'release_public_purchase_activation') {
        if (!row || row.id !== args.p_intent_id || row.activation_claim_key !== args.p_claim_key) {
          return { data: false, error: null }
        }
        row.activation_claimed_at = null
        row.activation_claim_key = null
        return { data: true, error: null }
      }
      throw new Error(`Unexpected RPC: ${name}`)
    },
    from() {
      const query = {
        action: 'select',
        payload: null,
        filters: [],
        select() { return this },
        update(payload) { this.action = 'update'; this.payload = payload; return this },
        eq(column, value) { this.filters.push({ op: 'eq', column, value }); return this },
        neq(column, value) { this.filters.push({ op: 'neq', column, value }); return this },
        is(column, value) { this.filters.push({ op: 'is', column, value }); return this },
        async maybeSingle() {
          const matches = state.intent && this.filters.every(({ op, column, value }) => {
            if (op === 'is') return value === null ? state.intent[column] == null : state.intent[column] === value
            if (op === 'neq') return String(state.intent[column] ?? '') !== String(value ?? '')
            return String(state.intent[column] ?? '') === String(value ?? '')
          })
          if (this.action === 'update' && options.beforeClaim) options.beforeClaim(state)
          const stillMatches = state.intent && this.filters.every(({ op, column, value }) => {
            if (op === 'is') return value === null ? state.intent[column] == null : state.intent[column] === value
            if (op === 'neq') return String(state.intent[column] ?? '') !== String(value ?? '')
            return String(state.intent[column] ?? '') === String(value ?? '')
          })
          if (!matches || !stillMatches) return { data: null, error: null }
          if (this.action === 'update') Object.assign(state.intent, this.payload)
          return { data: state.intent ? { ...state.intent } : null, error: null }
        }
      }
      return query
    }
  }
}

test('payment activation atomically claims an open sales intent', async () => {
  const db = activationClaimDb({
    id: 'intent-1',
    agreement_id: 'agreement-1',
    status: 'checkout_pending',
    activated_at: null,
    canceled_at: null,
    activation_claimed_at: null,
    activation_claim_key: null
  })
  const claim = await claimAgreementPurchaseActivation('agreement-1', 'cs_1', db)
  assert.equal(claim.proceed, true)
  assert.equal(claim.claimed, true)
  assert.equal(claim.intentId, 'intent-1')
  assert.match(claim.key, /^cs_1:[0-9a-f-]{36}$/)
  assert.equal(db.state.intent.activation_claim_key, claim.key)
  assert.ok(db.state.intent.activation_claimed_at)
})

test('only the initial subscription invoice may activate an agreement checkout', () => {
  assert.equal(isInitialAgreementCheckoutInvoice('invoice.payment_succeeded', 'agreement_checkout', 'agreement-1', 'subscription_create'), true)
  assert.equal(isInitialAgreementCheckoutInvoice('invoice.payment_succeeded', 'agreement_checkout', 'agreement-1', 'subscription_cycle'), false)
  assert.equal(isInitialAgreementCheckoutInvoice('invoice.payment_succeeded', 'agreement_checkout', 'agreement-1', ''), false)
  assert.equal(isInitialAgreementCheckoutInvoice('invoice.payment_failed', 'agreement_checkout', 'agreement-1', 'subscription_create'), false)
})

test('payment activation loses to a concurrent cancellation without reactivating it', async () => {
  const db = activationClaimDb({
    id: 'intent-2',
    agreement_id: 'agreement-2',
    status: 'checkout_pending',
    activated_at: null,
    canceled_at: null,
    activation_claimed_at: null,
    activation_claim_key: null
  }, {
    beforeClaim(state) {
      state.intent.status = 'canceled'
      state.intent.canceled_at = '2026-09-18T21:00:00.000Z'
    }
  })
  const claim = await claimAgreementPurchaseActivation('agreement-2', 'cs_2', db)
  assert.deepEqual(claim, {
    proceed: false,
    result: { ok: false, status: 'purchase_canceled', purchase_intent_id: 'intent-2' }
  })
  assert.equal(db.state.intent.activation_claimed_at, null)
})

test('payment activation loses safely when agreement replacement moves the intent during the claim', async () => {
  const db = activationClaimDb({
    id: 'intent-3',
    agreement_id: 'agreement-old',
    status: 'checkout_pending',
    activated_at: null,
    canceled_at: null,
    activation_claimed_at: null,
    activation_claim_key: null
  }, {
    beforeClaim(state) {
      state.intent.agreement_id = 'agreement-new'
    }
  })
  const claim = await claimAgreementPurchaseActivation('agreement-old', 'cs_old', db)
  assert.deepEqual(claim, {
    proceed: false,
    result: { ok: false, status: 'agreement_superseded', purchase_intent_id: 'intent-3' }
  })
  assert.equal(db.state.intent.activation_claimed_at, null)
})

test('non-ok activation releases its exact purchase claim for a legitimate retry', async () => {
  const db = activationClaimDb({
    id: 'intent-4',
    agreement_id: 'agreement-4',
    status: 'checkout_pending',
    activated_at: null,
    canceled_at: null,
    activation_claimed_at: null,
    activation_claim_key: null
  })
  const result = await markAgreementCheckoutPaid('agreement-4', {
    checkoutSessionId: 'cs_4',
    db,
    activate: async () => ({ ok: false, status: 'agreement_superseded' })
  })
  assert.deepEqual(result, { ok: false, status: 'agreement_superseded' })
  assert.equal(db.state.intent.activation_claimed_at, null)
  assert.equal(db.state.intent.activation_claim_key, null)
})

test('a fresh activation lease excludes a concurrent paid webhook', async () => {
  const db = activationClaimDb({
    id: 'intent-lease', agreement_id: 'agreement-lease', status: 'checkout_pending',
    activated_at: null, canceled_at: null, activation_claimed_at: null, activation_claim_key: null
  })
  const first = await claimAgreementPurchaseActivation('agreement-lease', 'cs_lease', db)
  const second = await claimAgreementPurchaseActivation('agreement-lease', null, db)
  assert.equal(first.claimed, true)
  assert.deepEqual(second, {
    proceed: false,
    result: { ok: false, status: 'activation_in_progress', purchase_intent_id: 'intent-lease' }
  })
  assert.equal(db.state.intent.activation_claim_key, first.key)
})

test('an expired claim can be reclaimed but the old fence cannot release the new owner', async () => {
  const db = activationClaimDb({
    id: 'intent-crash', agreement_id: 'agreement-crash', status: 'checkout_pending',
    activated_at: null, canceled_at: null,
    activation_claimed_at: '2026-09-01T00:00:00.000Z', activation_claim_key: 'old-fence'
  })
  const reclaimed = await claimAgreementPurchaseActivation('agreement-crash', 'cs_crash', db)
  assert.equal(reclaimed.claimed, true)
  assert.notEqual(reclaimed.key, 'old-fence')
  await releaseAgreementPurchaseActivationClaim('intent-crash', 'old-fence', db)
  assert.equal(db.state.intent.activation_claim_key, reclaimed.key)
  assert.ok(db.state.intent.activation_claimed_at)
})

test('heartbeats keep a live owner from being reclaimed', async () => {
  const db = activationClaimDb({
    id: 'intent-heartbeat', agreement_id: 'agreement-heartbeat', status: 'checkout_pending',
    activated_at: null, canceled_at: null,
    activation_claimed_at: '2026-09-01T00:00:00.000Z', activation_claim_key: 'live-fence'
  })
  const beat = await db.rpc('heartbeat_public_purchase_activation', {
    p_intent_id: 'intent-heartbeat', p_claim_key: 'live-fence'
  })
  assert.equal(beat.data, true)
  const contender = await claimAgreementPurchaseActivation('agreement-heartbeat', 'cs_other', db)
  assert.equal(contender.result.status, 'activation_in_progress')
  assert.equal(db.state.intent.activation_claim_key, 'live-fence')
})

test('a lost activation fence aborts before the activation callback can write', async () => {
  const db = activationClaimDb({
    id: 'intent-lost', agreement_id: 'agreement-lost', status: 'checkout_pending',
    activated_at: null, canceled_at: null, activation_claimed_at: null, activation_claim_key: null
  })
  let wrote = false
  await assert.rejects(markAgreementCheckoutPaid('agreement-lost', {
    checkoutSessionId: 'cs_lost', db,
    activate: async ({ assertActivationFence }) => {
      db.state.intent.activation_claim_key = 'winner-fence'
      await assertActivationFence()
      wrote = true
      return { ok: true }
    }
  }), /fence was lost/)
  assert.equal(wrote, false)
  assert.equal(db.state.intent.activation_claim_key, 'winner-fence')
})

test('completed activation with a fresh lease still excludes a sibling event', async () => {
  const db = activationClaimDb({
    id: 'intent-completed', agreement_id: 'agreement-completed', status: 'completed',
    activated_at: '2026-09-30T12:00:00.000Z', canceled_at: null,
    activation_claimed_at: new Date().toISOString(), activation_claim_key: 'first-fence'
  })
  const result = await claimAgreementPurchaseActivation('agreement-completed', 'cs_replay', db)
  assert.equal(result.proceed, false)
  assert.equal(result.result.status, 'activation_in_progress')
  assert.equal(db.state.intent.activation_claim_key, 'first-fence')
})

test('completed activation replay acquires a new fence after the prior tail releases', async () => {
  const db = activationClaimDb({
    id: 'intent-replay', agreement_id: 'agreement-replay', status: 'completed',
    activated_at: '2026-09-30T12:00:00.000Z', canceled_at: null,
    activation_claimed_at: null, activation_claim_key: null
  })
  const result = await claimAgreementPurchaseActivation('agreement-replay', 'cs_replay', db)
  assert.equal(result.claimed, true)
  assert.match(result.key, /^cs_replay:/)
})

test('activation recovery migration fences every service-role function', () => {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'supabase', 'migrations', '20260930172541_stripe_activation_recovery.sql'), 'utf8')
  for (const functionName of [
    'claim_public_purchase_activation',
    'heartbeat_public_purchase_activation',
    'release_public_purchase_activation',
    'complete_public_purchase_activation'
  ]) {
    assert.match(sql, new RegExp(`create or replace function public\\.${functionName}\\(`, 'i'))
    assert.match(sql, new RegExp(`revoke all on function public\\.${functionName}\\(`, 'i'))
    assert.match(sql, new RegExp(`grant execute on function public\\.${functionName}\\(`, 'i'))
  }
  assert.match(sql, /activation_claimed_at >= v_now - interval '5 minutes'/i)
  assert.match(sql, /activation_claim_key is distinct from p_claim_key/i)
  assert.match(sql, /on conflict \(id\) do nothing/i)
  assert.match(sql, /checkout_paid_at = coalesce\(checkout_paid_at, p_paid_at\)/i)
})

test('paid agreement webhook source leaves incomplete events retryable', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'webhooks', 'stripe.js'), 'utf8')
  assert.match(source, /priorEvent\.processed_ok === true/)
  assert.match(source, /if \(!retryableAgreementEvent && !retailRecurringEvent\?\.requiresReentry\) return res\.status\(200\)/)
  assert.match(source, /if \(retryableAgreementEvent\) \{\s*return res\.status\(503\)/)
  assert.match(source, /requireAgreementActivationResult\(activation\)/)
})

test('signed agreement render uses the stored deadline in Denver regardless of host timezone', () => {
  const { html } = buildExecutedMembershipAgreementHtml({
    client_legal_name: 'Acme Dental Group',
    primary_admin_name: 'Alex Rivera',
    admin_email: 'alex@example.com',
    membership_tier: 'basic',
    initial_term_start: '2026-09-19',
    initial_renewal_date: '2027-09-19',
    agreement_expires_at: '2026-09-20T06:00:00.000Z',
    billing_option: 'annual',
    auto_renew: true,
    notice_deadline_days: 30,
    template_snapshot: { source: 'sales_assisted' }
  }, {
    accepted: true,
    signer_typed_name: 'Alex Rivera',
    signed_at: '2026-09-19T20:00:00.000Z'
  })
  assert.match(html, /Signature and initial payment deadline/)
  assert.match(html, /September 19, 2026 at 11:59 PM MDT/)
  assert.doesNotMatch(html, /September 20, 2026 at 6:59 AM/)
})

test('agreement checkout webhooks do not fall through to generic client activation', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'webhooks', 'stripe.js'), 'utf8')
  // The guard also requires paymentSettled, so an unpaid completed session grants
  // nothing on the generic path either. The agreement invariant is unchanged.
  assert.match(source, /if \(!isPaidAgreementCheckout && paymentSettled\) \{[\s\S]*buildClientSubscriptionUpdatesFromStripe/i)
  assert.match(source, /const isAgreementCheckoutInvoice = isInitialAgreementCheckoutInvoice\([\s\S]*metadataSource,[\s\S]*eventObject\?\.billing_reason/i)
  assert.match(source, /customerId && !isManagedSubscriptionInvoice && !isAgreementCheckoutInvoice/i)
})

test('generic subscription webhooks wait for guarded agreement-checkout activation', async () => {
  const dbFor = (intent) => ({
    from() {
      return {
        select() { return this },
        eq() { return this },
        async maybeSingle() { return { data: intent, error: null } }
      }
    }
  })
  const metadata = { source: 'agreement_checkout', agreement_id: 'agreement-1' }
  assert.equal(await shouldApplyGenericSubscriptionUpdate(metadata, dbFor({ status: 'checkout_pending', activated_at: null, canceled_at: null })), false)
  assert.equal(await shouldApplyGenericSubscriptionUpdate(metadata, dbFor({ status: 'canceled', activated_at: null, canceled_at: '2026-09-18T20:00:00.000Z' })), false)
  assert.equal(await shouldApplyGenericSubscriptionUpdate(metadata, dbFor({ status: 'completed', activated_at: '2026-09-18T20:01:00.000Z', canceled_at: null })), true)
  assert.equal(await shouldApplyGenericSubscriptionUpdate({ source: 'admin_subscription_checkout' }, dbFor(null)), true)
})
