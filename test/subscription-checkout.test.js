'use strict'

const assert = require('node:assert/strict')
const path = require('node:path')
const http = require('node:http')
const InstalledStripe = require('stripe')
const crypto = require('node:crypto')
const { test } = require('node:test')

const checkoutPath = path.join(__dirname, '..', 'src', 'services', 'subscriptionCheckout.js')
const supabaseClientPath = path.join(__dirname, '..', 'src', 'clients', 'supabase.js')
const clientBillingScopePath = path.join(__dirname, '..', 'src', 'services', 'clientBillingScope.js')
const urlConfigPath = path.join(__dirname, '..', 'src', 'config', 'urlConfig.js')
const stripePath = require.resolve('stripe')
const retailRows = new Map(), TOKEN = 'SYNTHETIC_CHECKOUT_SIGNER_TOKEN';
function retailArgs(snapshot, promotionCodeId = '') {
  const id = crypto.randomUUID(), intent = promotionCodeId ? { id:crypto.randomUUID(),promotion_code_id:promotionCodeId } : null;
  const row = { id,client_id:'client-1',agreement_expires_at:new Date(Date.now()+7*86400000).toISOString(),
    signer_token_hash:crypto.createHash('sha256').update(TOKEN).digest('hex'),
    template_snapshot:{ source:intent?'sales_assisted':'admin',package_snapshot:structuredClone(snapshot) } };
  if (intent) intent.expires_at=row.agreement_expires_at;
  retailRows.set(id,{ row,intent });
  return { clientId:'client-1',planTier:snapshot.plan_key,billingInterval:snapshot.billing_cadence,
    packageSnapshot:snapshot,retailAgreement:row,metadataSource:'agreement_checkout',promotionCodeId,
    idempotencyKey:`agreement_checkout:${id}:${snapshot.plan_key}:${snapshot.billing_cadence}`,
    cancelUrl:`https://qa.alphasourceai.com/membership-agreement/sign/${TOKEN}` };
}

function injectModule(filename, exports) {
  require.cache[filename] = {
    id: filename,
    filename,
    loaded: true,
    exports
  }
}

function matchesFilters(row, filters) {
  return filters.every(({ column, value }) => String(row?.[column] ?? '') === String(value ?? ''))
}

class FakeQuery {
  constructor(db, table) {
    this.db = db
    this.table = table
    this.filters = []
    this.updatePayload = null
    this.insertPayload = null
  }

  select() {
    return this
  }

  eq(column, value) {
    this.filters.push({ column, value })
    return this
  }

  order() {
    return this
  }

  update(payload) {
    this.updatePayload = payload
    return this
  }
  insert(payload) { this.insertPayload=payload;return this }
  async single() { const r=await this.execute();return{data:r.data[0]||null,error:r.error} }

  rows() {
    if (this.table === 'clients') return this.db.clients
    if (this.table === 'billing_customers') return this.db.billingCustomers
    return []
  }

  async maybeSingle() {
    if(this.updatePayload){const r=await this.execute();return{data:r.data[0]||null,error:r.error}}
    return { data: this.rows().find((row) => matchesFilters(row, this.filters)) || null, error: null }
  }

  async execute() {
    if(this.insertPayload) {
      assert.equal(this.table,'billing_customers');
      if(this.db.billingCustomers.some(r=>r.stripe_customer_id===this.insertPayload.stripe_customer_id))return{data:[],error:{code:'23505'}};
      const row={id:crypto.randomUUID(),...this.insertPayload};this.db.billingCustomers.push(row);
      this.db.inserts.push({table:this.table,payload:this.insertPayload});return{data:[row],error:null,count:1};
    }
    if (this.updatePayload) {
      const rows = this.rows().filter((row) => matchesFilters(row, this.filters))
      for (const row of rows) Object.assign(row, this.updatePayload)
      this.db.updates.push({ table: this.table, payload: this.updatePayload, rows })
      return { data: rows, error: null }
    }
    const rows=this.rows().filter((row) => matchesFilters(row, this.filters));return { data: rows,error:null,count:rows.length }
  }

  then(resolve, reject) {
    return this.execute().then(resolve, reject)
  }
}

function makeDb() {
  const db = {
    clients: [{
      id: 'client-1',
      name: 'Acme Dental Group',
      email: 'alex@acmedental.example',
      client_admin_name: 'Alex Rivera',
      stripe_customer_id: 'cus_existing'
    }],
    billingCustomers: [{
      id: 'billing-customer-1',
      client_id: 'client-1',
      stripe_customer_id: 'cus_existing'
    }],
    updates: [],inserts:[],
    attempts:new Map(),rpcCalls:[],
    // Explicit injected native boundary for JS orchestration only. These are
    // NOT SQL proofs; the disposable PostgreSQL suite exercises real RPCs.
    async rpc(name,args) {
      this.rpcCalls.push({name,args:structuredClone(args)});
      if (name === 'claim_retail_existing_checkout_attempt') {
        const persisted = retailRows.get(args.p_agreement);assert.ok(persisted);
        assert.deepEqual(args.p_expected_template,persisted.row.template_snapshot);
        let attempt = this.attempts.get(args.p_agreement);
        if (!attempt) {
          const row=persisted.row,b=Date.now();
          attempt={agreement_id:row.id,client_id:row.client_id,created_at:new Date(b).toISOString(),
            source:{version:'retail_existing_checkout_attempt_v1',agreement_id:row.id,client_id:row.client_id,
              customer_id:args.p_customer,template_snapshot:structuredClone(row.template_snapshot),
              agreement_expires_at:row.agreement_expires_at,signer_token_hash:row.signer_token_hash,
              intent:persisted.intent,config:structuredClone(args.p_config)},
            expires_at:Math.floor(Math.min(Date.parse(row.agreement_expires_at),
              persisted.intent?Date.parse(persisted.intent.expires_at):Infinity,b+86400000-1000)/1000),
            embedded:args.p_embedded,replacement_id:args.p_replacement,checkout_session_id:null};
          this.attempts.set(row.id,attempt);
          row.checkout_attempt_source=structuredClone(attempt.source);
        }
        return{data:structuredClone(attempt),error:null};
      }
      assert.equal(name,'pin_retail_existing_checkout_session');
      const actual=this.attempts.get(args.p_agreement);assert.deepEqual(args.p_attempt,{...actual,checkout_session_id:args.p_attempt.checkout_session_id});
      assert.ok(!actual.checkout_session_id||actual.checkout_session_id===args.p_session);
      actual.checkout_session_id=args.p_session;return{data:structuredClone(actual),error:null};
    },
    from(table) {
      return new FakeQuery(this, table)
    }
  }
  return db
}

function positivePromotion(id='promo_validated') { return {object:'promotion_code',id,active:true,livemode:false,customer:null,expires_at:null,
  max_redemptions:null,times_redeemed:0,
  restrictions:{first_time_transaction:false,minimum_amount:null,minimum_amount_currency:null},
  coupon:{object:'coupon',id:'SYNTHETIC',valid:true,livemode:false,percent_off:10,amount_off:null,currency:null,
    duration:'once',duration_in_months:null,redeem_by:null,max_redemptions:null,times_redeemed:0}}; }
function loadCheckout({ stripeCalls, stripeConstructor, sessionResponder, customerOverride = {},db = makeDb(),sessionMutation,lineMutation,subscriptions=[],promotionResponder=positivePromotion }) {
  delete require.cache[checkoutPath]
  delete require.cache[supabaseClientPath]
  delete require.cache[clientBillingScopePath]
  delete require.cache[urlConfigPath]
  delete require.cache[stripePath]

  injectModule(supabaseClientPath, { supabaseAdmin: db })
  injectModule(clientBillingScopePath, {
    requireParentClient: async () => ({ ok: true, clientId: 'client-1' })
  })
  injectModule(urlConfigPath, {
    resolvePublicBackendBase(value) {
      return value || 'https://api.qa.alphasourceai.com'
    },
    buildMembershipAgreementSignUrl(token) { return `https://qa.alphasourceai.com/membership-agreement/sign/${token}` },
    buildClientDashboardReturnUrl(query = {}) {
      const params = new URLSearchParams(query)
      return `https://qa.alphasourceai.com/dashboard?${params.toString()}`
    }
  })
  let lastPayload,lastSession,lastPromotion;
  const lineDiscounts = () => {
    const amounts=lastPayload.line_items.map(line=>line.price_data.unit_amount);
    if(!lastPayload.discounts?.length)return amounts.map(()=>0);
    const c=lastPromotion.coupon;
    if(c.percent_off!=null)return amounts.map(amount=>Math.round(amount*c.percent_off/100));
    const fixed=c.currency_options?.usd?.amount_off??c.amount_off,total=amounts.reduce((a,b)=>a+b,0);
    let allocated=0;return amounts.map((amount,n)=>{const value=n===amounts.length-1?fixed-allocated:Math.floor(fixed*amount/total);allocated+=value;return value});
  };
  injectModule(stripePath, stripeConstructor || function Stripe() {
    return {
      promotionCodes:{retrieve:async id=>{lastPromotion=promotionResponder(id);return structuredClone(lastPromotion)}},
      customers: {
        retrieve: async (id) => ({ id, discount: null, balance: 0, ...customerOverride }),
        update: async (id, payload) => {
          stripeCalls.customerUpdates.push({ id, payload })
          return { id, ...payload }
        },
        create: async (payload) => {
          stripeCalls.customerCreates.push(payload)
          return { id: 'cus_created', ...payload }
        }
      },
      subscriptions: {
        list: async (payload) => {
          stripeCalls.subscriptionLists.push(payload)
          return { data: subscriptions }
        }
      },
      prices:{retrieve:async key=>{
        const n=Number(key.replace('price_SYNTHETIC_','')),l=lastPayload.line_items[n];
        return{object:'price',id:key,currency:'usd',unit_amount:l.price_data.unit_amount,
          type:l.price_data.recurring?'recurring':'one_time',recurring:l.price_data.recurring?{...l.price_data.recurring,usage_type:'licensed'}:null};
      }},
      checkout: {
        sessions: {
          create: async (payload, options) => {
            stripeCalls.sessions.push({ payload, options })
            lastPayload=payload;
            lastSession=sessionResponder ? sessionResponder(payload, options)
              : { id:'cs_test_subscription',url:'https://checkout.stripe.test/cs_test_subscription' };
            return lastSession;
          },
          retrieve:async sessionId=>{
            const total=lastPayload.line_items.reduce((sum,l)=>sum+l.price_data.unit_amount,0);
            const promoId=lastPayload.discounts?.[0]?.promotion_code;
            const discount=lineDiscounts().reduce((sum,amount)=>sum+amount,0);
            const s={object:'checkout.session',id:sessionId,mode:'subscription',status:'open',payment_status:'unpaid',
              currency:'usd',livemode:false,customer:lastPayload.customer,subscription:null,expires_at:lastPayload.expires_at,
              ui_mode:lastPayload.ui_mode||'hosted',metadata:lastPayload.metadata,amount_subtotal:total,amount_total:total-discount,
              return_url:lastPayload.return_url,success_url:lastPayload.success_url,cancel_url:lastPayload.cancel_url,
              allow_promotion_codes:lastPayload.allow_promotion_codes??null,total_details:{amount_discount:discount,amount_shipping:0,amount_tax:0,
                breakdown:{discounts:promoId?[{amount:discount,discount:{object:'discount',id:'di_SYNTHETIC',promotion_code:promoId,
                  customer:lastPayload.customer,coupon:structuredClone(lastPromotion.coupon)}}]:[]}},
              ...lastSession};
            return sessionMutation?sessionMutation(s):s;
          },
          listLineItems:async()=>{ const lines={object:'list',has_more:false,data:lastPayload.line_items.map((l,n)=>({
            id:`li_SYNTHETIC_${n}`,quantity:l.quantity,currency:'usd',amount_subtotal:l.price_data.unit_amount,
            amount_discount:lineDiscounts()[n],amount_tax:0,
            amount_total:l.price_data.unit_amount-lineDiscounts()[n],
            price:{object:'price',id:`price_SYNTHETIC_${n}`,currency:'usd',unit_amount:l.price_data.unit_amount,
              type:l.price_data.recurring?'recurring':'one_time',recurring:l.price_data.recurring?{...l.price_data.recurring,usage_type:'licensed'}:null}
          }))};return lineMutation?lineMutation(lines):lines; }
        }
      }
    }
  })
  return require(checkoutPath)
}

test('subscription checkout adds configured one-time first-role prepay line item and metadata when selected', async () => {
  const previous = {
    STRIPE_PRICE_BASIC_MONTHLY: process.env.STRIPE_PRICE_BASIC_MONTHLY,
    STRIPE_PRICE_BASIC_FIRST_ROLE_PREPAY: process.env.STRIPE_PRICE_BASIC_FIRST_ROLE_PREPAY,
    STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY
  }
  const stripeCalls = { sessions: [], customerUpdates: [], customerCreates: [], subscriptionLists: [] }
  process.env.STRIPE_PRICE_BASIC_MONTHLY = 'price_basic_monthly'
  process.env.STRIPE_PRICE_BASIC_FIRST_ROLE_PREPAY = 'price_basic_first_role_prepay'
  process.env.STRIPE_SECRET_KEY = 'sk_test_fake'
  try {
    const { createSubscriptionCheckoutSession } = loadCheckout({ stripeCalls })
    const result = await createSubscriptionCheckoutSession({
      clientId: 'client-1',
      planTier: 'Essential',
      billingInterval: 'monthly',
      metadataSource: 'agreement_checkout',
      metadata: {
        agreement_id: 'agreement-1',
        purchase_intent_id: 'intent-1'
      },
      firstRolePrepay: {
        selected: true,
        credit_type: 'first_role_prepay',
        amount_cents: 35900,
        normal_role_fee_cents: 39900,
        discount_percent: 10
      },
      idempotencyKey: 'agreement_checkout:agreement-1:basic:monthly',
      requestContext: {
        forwardedProto: 'https',
        forwardedHost: 'api.qa.alphasourceai.com'
      }
    })

    assert.equal(result.session.id, 'cs_test_subscription')
    assert.equal(stripeCalls.sessions.length, 1)
    const payload = stripeCalls.sessions[0].payload
    assert.deepEqual(payload.line_items, [
      { price: 'price_basic_monthly', quantity: 1 },
      { price: 'price_basic_first_role_prepay', quantity: 1 }
    ])
    assert.equal(payload.metadata.first_role_prepay_selected, 'true')
    assert.equal(payload.metadata.plan_tier, 'basic')
    assert.equal(payload.metadata.first_role_prepay_credit_type, 'first_role_prepay')
    assert.equal(payload.metadata.first_role_prepay_amount_cents, '35900')
    assert.equal(payload.metadata.first_role_prepay_normal_role_fee_cents, '39900')
    assert.equal(payload.metadata.first_role_prepay_discount_percent, '10')
    assert.equal(payload.subscription_data.metadata.first_role_prepay_amount_cents, '35900')
    assert.equal(payload.metadata.agreement_id, 'agreement-1')
    assert.equal(payload.metadata.purchase_intent_id, 'intent-1')
    assert.equal('expires_at' in payload, false)
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
})

test('sales agreement checkout enforces Stripe expiration bounds without changing legacy callers', async () => {
  const previous = {
    STRIPE_PRICE_BASIC_MONTHLY: process.env.STRIPE_PRICE_BASIC_MONTHLY,
    STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY
  }
  process.env.STRIPE_PRICE_BASIC_MONTHLY = 'price_basic_monthly'
  process.env.STRIPE_SECRET_KEY = 'sk_test_fake'
  const baseNow = '2026-11-01T06:05:00.000Z'
  try {
    const shortCalls = { sessions: [], customerUpdates: [], customerCreates: [], subscriptionLists: [] }
    const shortCheckout = loadCheckout({ stripeCalls: shortCalls }).createSubscriptionCheckoutSession
    await assert.rejects(
      () => shortCheckout({
        clientId: 'client-1',
        planTier: 'basic',
        billingInterval: 'monthly',
        checkoutExpiresAt: '2026-11-01T06:25:00.000Z',
        now: baseNow
      }),
      (error) => error.code === 'agreement_checkout_window_closed'
    )
    assert.equal(shortCalls.sessions.length, 0)

    const twoHourCalls = { sessions: [], customerUpdates: [], customerCreates: [], subscriptionLists: [] }
    const twoHourCheckout = loadCheckout({ stripeCalls: twoHourCalls }).createSubscriptionCheckoutSession
    await twoHourCheckout({
      clientId: 'client-1',
      planTier: 'basic',
      billingInterval: 'monthly',
      checkoutExpiresAt: '2026-11-01T08:05:00.000Z',
      now: baseNow
    })
    assert.equal(twoHourCalls.sessions[0].payload.expires_at, Date.parse('2026-11-01T08:05:00.000Z') / 1000)

    const longCalls = { sessions: [], customerUpdates: [], customerCreates: [], subscriptionLists: [] }
    const longCheckout = loadCheckout({ stripeCalls: longCalls }).createSubscriptionCheckoutSession
    await longCheckout({
      clientId: 'client-1',
      planTier: 'basic',
      billingInterval: 'monthly',
      checkoutExpiresAt: '2026-11-02T07:05:00.000Z',
      now: baseNow
    })
    assert.equal(longCalls.sessions[0].payload.expires_at, (Date.parse(baseNow) + 24 * 60 * 60 * 1000 - 1000) / 1000)
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
})

test('subscription checkout fails selected first-role prepay when one-time Stripe price env is missing', async () => {
  const previous = {
    STRIPE_PRICE_PRO_ANNUAL: process.env.STRIPE_PRICE_PRO_ANNUAL,
    STRIPE_PRICE_PRO_FIRST_ROLE_PREPAY: process.env.STRIPE_PRICE_PRO_FIRST_ROLE_PREPAY,
    STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY
  }
  const stripeCalls = { sessions: [], customerUpdates: [], customerCreates: [], subscriptionLists: [] }
  process.env.STRIPE_PRICE_PRO_ANNUAL = 'price_pro_annual'
  delete process.env.STRIPE_PRICE_PRO_FIRST_ROLE_PREPAY
  process.env.STRIPE_SECRET_KEY = 'sk_test_fake'
  try {
    const { createSubscriptionCheckoutSession } = loadCheckout({ stripeCalls })
    await assert.rejects(
      () => createSubscriptionCheckoutSession({
        clientId: 'client-1',
        planTier: 'pro',
        billingInterval: 'annual',
        metadataSource: 'agreement_checkout',
        firstRolePrepay: {
          selected: true,
          credit_type: 'first_role_prepay',
          amount_cents: 62900,
          normal_role_fee_cents: 69900,
          discount_percent: 10
        }
      }),
      /First-role prepay Stripe price is not configured/
    )
    assert.equal(stripeCalls.sessions.length, 0)
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
})

test('subscription checkout applies a validated promotion code instead of allowing arbitrary entry', async () => {
  const previous = {
    STRIPE_PRICE_BASIC_MONTHLY: process.env.STRIPE_PRICE_BASIC_MONTHLY,
    STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY
  }
  const stripeCalls = { sessions: [], customerUpdates: [], customerCreates: [], subscriptionLists: [] }
  process.env.STRIPE_PRICE_BASIC_MONTHLY = 'price_basic_monthly'
  process.env.STRIPE_SECRET_KEY = 'sk_test_fake'
  try {
    const { createSubscriptionCheckoutSession } = loadCheckout({ stripeCalls })
    await createSubscriptionCheckoutSession({
      clientId: 'client-1',
      planTier: 'basic',
      billingInterval: 'monthly',
      promotionCodeId: 'promo_validated',
      requestContext: { forwardedHost: 'api.qa.alphasourceai.com' }
    })
    const payload = stripeCalls.sessions[0].payload
    assert.deepEqual(payload.discounts, [{ promotion_code: 'promo_validated' }])
    assert.equal('allow_promotion_codes' in payload, false)
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
})

function retailSnapshot(planKey='basic',commitmentMonths=3,paymentOption='prepaid',firstRolePrepaySelected=false) {
  return require('../src/services/alphaScreenPackages').buildAlphaScreenPackageSnapshot(planKey,paymentOption==='prepaid'?'prepaid':'monthly',{
    commitmentMonths,paymentOption,firstRolePrepaySelected,channel:'sales',offerVersion:require('../src/services/membershipOffers').OFFER_VERSION
  })
}
function retailCalls() {return {sessions:[],customerUpdates:[],customerCreates:[],subscriptionLists:[]}}
test('existing subscription checkout prices all24 retail variants from frozen package terms, without new Auth or Stripe-price configuration',async()=>{
  for(const planKey of ['basic','pro'])for(const months of [3,6,12])for(const payment of ['prepaid','monthly_installments'])for(const role of [false,true]){
    const calls=retailCalls(),snapshot=retailSnapshot(planKey,months,payment,role),offer=snapshot.membership_terms;
    const {createSubscriptionCheckoutSession:create}=loadCheckout({stripeCalls:calls});
    await create({...retailArgs(snapshot),
      metadata:{client_id:'wrong-client',plan_tier:'enterprise',billing_interval:'annual',membership_commitment_months:'99',first_role_prepay_selected:'wrong'}});
    assert.equal(calls.sessions.length,1);const {payload:p,options}=calls.sessions[0];assert.equal(p.mode,'subscription');
    assert.equal(p.customer,'cus_existing');assert.equal(p.line_items.length,role?2:1);
    assert.equal(p.line_items[0].price_data.unit_amount,offer.platform_payment_cents);
    assert.deepEqual(p.line_items[0].price_data.recurring,{interval:'month',interval_count:payment==='prepaid'?months:1});
    assert.equal(p.allow_promotion_codes,false);assert.equal(p.metadata.client_id,'client-1');assert.equal(p.metadata.plan_tier,planKey);
    assert.equal(p.metadata.billing_interval,snapshot.billing_cadence);assert.equal(p.metadata.membership_commitment_months,String(months));
    assert.equal(p.metadata.first_role_prepay_selected,String(role));assert.equal(p.metadata.first_role_prepay_amount_cents,String(offer.first_role_prepay.amount_cents));
    assert.deepEqual(p.subscription_data.metadata,p.metadata);assert.equal('trial_end' in p.subscription_data,false);
    assert.equal('billing_cycle_anchor' in p.subscription_data,false);assert.ok(options.idempotencyKey.startsWith('agreement_checkout:'));
    if(role){assert.equal(p.line_items[1].price_data.unit_amount,planKey==='basic'?35900:62900);assert.equal('recurring' in p.line_items[1].price_data,false)}
  }
});
test('new retail checkout rejects mismatched plan/cadence/role, malformed source and unsafe identity before provider effects',async()=>{
  const snapshot=retailSnapshot(),cases=[{planTier:'pro'},{billingInterval:'annual'},{idempotencyKey:''},{idempotencyKey:'ambiguous key'},
    {idempotencyKey:'A'.repeat(256)},
    {firstRolePrepay:{selected:true,credit_type:'first_role_prepay',amount_cents:35900,normal_role_fee_cents:39900,discount_percent:10}},
    {packageSnapshot:{pricing_protocol:'retail_package_terms_v2'}}];
  for(const change of cases){const calls=retailCalls(),{createSubscriptionCheckoutSession:create}=loadCheckout({stripeCalls:calls});
    await assert.rejects(create({...retailArgs(snapshot),...change}));
    assert.equal(calls.sessions.length,0);assert.equal(calls.customerCreates.length,0);assert.equal(calls.customerUpdates.length,0);assert.equal(calls.subscriptionLists.length,0)}
});
test('new retail Checkout does not create a second hosted session after an ambiguous embedded result',async()=>{
  const calls=retailCalls(),{createSubscriptionCheckoutSession:create}=loadCheckout({stripeCalls:calls});
  await assert.rejects(create({...retailArgs(retailSnapshot()),embedded:true}),e=>e.code==='retail_checkout_ack_unknown');
  assert.equal(calls.sessions.length,1);assert.equal(calls.sessions[0].payload.ui_mode,'embedded');
});
test('confirmed new retail embedded checkout retains its primary session without a second payable fallback',async()=>{
  const calls=retailCalls(),{createSubscriptionCheckoutSession:create}=loadCheckout({stripeCalls:calls,
    sessionResponder:()=>({id:'cs_SYNTHETIC_EMBEDDED',url:null,client_secret:'SYNTHETIC_NOT_A_REAL_SECRET'})});
  const result=await create({...retailArgs(retailSnapshot()),embedded:true});
  assert.equal(calls.sessions.length,1);assert.equal(result.session.id,'cs_SYNTHETIC_EMBEDDED');assert.equal(result.fallbackSession,null);
  assert.equal(result.checkoutClientSecret,'SYNTHETIC_NOT_A_REAL_SECRET');
});
test('monthly retail installments preserve the existing validated promotion-code behavior',async()=>{
  const calls=retailCalls(),{createSubscriptionCheckoutSession:create}=loadCheckout({stripeCalls:calls});
  await create(retailArgs(retailSnapshot('basic',3,'monthly_installments'),'promo_validated'));
  assert.deepEqual(calls.sessions[0].payload.discounts,[{promotion_code:'promo_validated'}]);
  assert.equal('allow_promotion_codes' in calls.sessions[0].payload,false);
});
test('fixed monthly promotions with real role allocation preserve the accepted price and return only a confirmed Session',async()=>{
  for(const role of [false,true]){
    const calls=retailCalls(),promotionResponder=id=>{const p=positivePromotion(id);p.coupon.percent_off=null;
      p.coupon.currency='eur';p.coupon.amount_off=1;p.coupon.currency_options={usd:{amount_off:100}};return p;};
    const {createSubscriptionCheckoutSession:create}=loadCheckout({stripeCalls:calls,promotionResponder});
    const snapshot=retailSnapshot('basic',3,'monthly_installments',role),result=await create(retailArgs(snapshot,'promo_validated'));
    assert.equal(result.session.amount_total,snapshot.membership_terms.initial_payment_cents-100);
    assert.deepEqual(calls.sessions[0].payload.discounts,[{promotion_code:'promo_validated'}]);
  }
});
test('customer-scoped promotions match a live existing owner before any writer or hold without customer creation',async()=>{
  const promotionResponder=id=>({...positivePromotion(id),customer:'cus_existing'});
  const calls=retailCalls(),{createSubscriptionCheckoutSession:create}=loadCheckout({stripeCalls:calls,promotionResponder});
  await create(retailArgs(retailSnapshot('basic',3,'monthly_installments'),'promo_validated'));assert.equal(calls.sessions.length,1);
  for(const kind of ['other','missing','deleted']){
    const db=makeDb(),dark=retailCalls();
    if(kind==='missing'){db.clients[0].stripe_customer_id=null;db.billingCustomers=[]}
    const {createSubscriptionCheckoutSession:fn}=loadCheckout({db,stripeCalls:dark,
      customerOverride:kind==='deleted'?{deleted:true}:{},
      promotionResponder:id=>({...positivePromotion(id),customer:kind==='other'?'cus_OTHER':'cus_existing'})});
    await assert.rejects(fn(retailArgs(retailSnapshot('basic',3,'monthly_installments'),'promo_validated')),
      {code:'retail_checkout_promotion_customer_mismatch'});
    assert.deepEqual(dark,retailCalls());assert.deepEqual(db.updates,[]);assert.deepEqual(db.inserts,[]);assert.deepEqual(db.rpcCalls,[]);
  }
});
test('API2023 discount expansion accepts a real promotion object, rejects null/deleted/wrong-object ids',async()=>{
  const mutations=[d=>d.promotion_code=null,d=>d.promotion_code={object:'other',id:'promo_validated'},
    d=>d.promotion_code={object:'promotion_code',id:'promo_validated',deleted:true},d=>d.coupon='SYNTHETIC',d=>d.coupon.deleted=true];
  const calls=retailCalls(),{createSubscriptionCheckoutSession:create}=loadCheckout({stripeCalls:calls,
    sessionMutation:s=>{s.total_details.breakdown.discounts[0].discount.promotion_code={object:'promotion_code',id:'promo_validated'};return s;}});
  await create(retailArgs(retailSnapshot('basic',3,'monthly_installments'),'promo_validated'));assert.equal(calls.sessions.length,1);
  for(const mutate of mutations){const dark=retailCalls(),{createSubscriptionCheckoutSession:fn}=loadCheckout({stripeCalls:dark,
    sessionMutation:s=>{mutate(s.total_details.breakdown.discounts[0].discount);return s;}});
    await assert.rejects(fn(retailArgs(retailSnapshot('basic',3,'monthly_installments'),'promo_validated')),
      {code:'retail_checkout_session_promotion_mismatch'});assert.equal(dark.sessions.length,1);}
});
test('documented nullable discount customer and shipping amounts pass, live owner binds and foreign/deleted owner refuses',async()=>{
  for(const customer of [null,{object:'customer',id:'cus_existing'}]){
    const calls=retailCalls(),{createSubscriptionCheckoutSession:create}=loadCheckout({stripeCalls:calls,
      sessionMutation:s=>{s.total_details.amount_shipping=null;s.total_details.breakdown.discounts[0].discount.customer=customer;return s;}});
    await create(retailArgs(retailSnapshot('basic',3,'monthly_installments'),'promo_validated'));assert.equal(calls.sessions.length,1);
  }
  for(const customer of ['cus_OTHER',{object:'customer',id:'cus_existing',deleted:true},{object:'other',id:'cus_existing'},undefined]){
    const calls=retailCalls(),{createSubscriptionCheckoutSession:create}=loadCheckout({stripeCalls:calls,
      sessionMutation:s=>{s.total_details.breakdown.discounts[0].discount.customer=customer;return s;}});
    await assert.rejects(create(retailArgs(retailSnapshot('basic',3,'monthly_installments'),'promo_validated')),
      {code:'retail_checkout_session_promotion_mismatch'});assert.equal(calls.sessions.length,1);
  }
  for(const payment of ['prepaid','monthly_installments']) {
    const calls=retailCalls(),{createSubscriptionCheckoutSession:create}=loadCheckout({stripeCalls:calls,
      sessionMutation:s=>{s.total_details.amount_shipping=null;return s;}});
    await create(retailArgs(retailSnapshot('basic',3,payment)));assert.equal(calls.sessions.length,1);
    const dark=retailCalls(),{createSubscriptionCheckoutSession:fn}=loadCheckout({stripeCalls:dark,
      sessionMutation:s=>{s.total_details.amount_shipping=1;s.amount_total++;return s;}});
    await assert.rejects(fn(retailArgs(retailSnapshot('basic',3,payment))),{code:'retail_checkout_session_prices_mismatch'});
    assert.equal(dark.sessions.length,1);
  }
});
test('missing expanded no-promo breakdown or truncated/incomplete priced lines withhold the URL',async()=>{
  for(const kind of ['breakdown','lineMoney','listMissing','truncated']){
    const calls=retailCalls(),{createSubscriptionCheckoutSession:create}=loadCheckout({stripeCalls:calls,
      sessionMutation:s=>{if(kind==='breakdown')delete s.total_details.breakdown;return s;},
      lineMutation:rows=>{if(kind==='lineMoney')delete rows.data[0].amount_tax;
        if(kind==='listMissing')rows.data=null;if(kind==='truncated')rows.has_more=true;return rows;}});
    await assert.rejects(create(retailArgs(retailSnapshot('basic',3,'monthly_installments'))));assert.equal(calls.sessions.length,1);
  }
});
test('new monthly zero/unknown/restricted promotion refuses before every DB and provider write',async()=>{
  for(const kind of ['percent100','covering','unavailable','wrongId','modern','expired','restricted']){
    const db=makeDb(),calls=retailCalls();
    const promotionResponder=id=>{const p=positivePromotion(id);
      if(kind==='percent100')p.coupon.percent_off=100;
      if(kind==='covering'){p.coupon.percent_off=null;p.coupon.amount_off=44900;p.coupon.currency='usd'}
      if(kind==='unavailable')throw Error('synthetic provider unavailable');
      if(kind==='wrongId')p.id='promo_OTHER';
      if(kind==='modern'){p.promotion={coupon:p.coupon};delete p.coupon}
      if(kind==='expired')p.expires_at=1;
      if(kind==='restricted')p.coupon.applies_to={products:['prod_OTHER']};
      return p;};
    const {createSubscriptionCheckoutSession:create}=loadCheckout({db,stripeCalls:calls,promotionResponder});
    await assert.rejects(create(retailArgs(retailSnapshot('basic',3,'monthly_installments'),'promo_validated')),
      e=>typeof e.code==='string'&&e.code.startsWith('retail_checkout_'));
    assert.deepEqual(db.updates,[]);assert.deepEqual(db.inserts,[]);assert.deepEqual(db.rpcCalls,[]);
    assert.deepEqual(calls,retailCalls());
  }
});
test('new installment customer credits/unknown shapes refuse before all writers without clearing anything',async()=>{
  for(const customerOverride of [{balance:-1},{balance:1},{discount:{id:'di_OTHER'}},{invoice_credit_balance:[]},
    {invoice_credit_balance:{usd:1}},{invoice_credit_balance:{usd:'0'}},{cash_balance:{}},{cash_balance:{object:'cash_balance'}},
    {cash_balance:{object:'cash_balance',available:null}},
    {cash_balance:{object:'cash_balance',available:{usd:1}}}]){
    const db=makeDb(),calls=retailCalls(),{createSubscriptionCheckoutSession:create}=loadCheckout({db,stripeCalls:calls,customerOverride});
    await assert.rejects(create(retailArgs(retailSnapshot('basic',6,'monthly_installments'))),{code:'retail_customer_adjustment_denied'});
    assert.deepEqual(calls,retailCalls());assert.deepEqual(db.updates,[]);assert.deepEqual(db.inserts,[]);assert.deepEqual(db.rpcCalls,[]);
  }
});
test('zero or tampered installment open-session amounts and promo identity never expose a URL or mint fallback',async()=>{
  for(const kind of ['zero','taxOnly','wrongPromo','wrongCoupon','missingDiscount','editor','lineDiscount','foreignMode']){
    const calls=retailCalls(),db=makeDb();
    const sessionMutation=s=>{
      if(kind==='zero'){s.total_details.amount_discount=s.amount_subtotal;s.amount_total=0}
      if(kind==='taxOnly'){s.total_details.amount_discount=s.amount_subtotal;s.total_details.amount_tax=100;s.amount_total=100}
      if(kind==='wrongPromo')s.total_details.breakdown.discounts[0].discount.promotion_code='promo_OTHER';
      if(kind==='wrongCoupon')s.total_details.breakdown.discounts[0].discount.coupon.id='OTHER';
      if(kind==='missingDiscount')delete s.total_details.breakdown;
      if(kind==='editor')s.allow_promotion_codes=true;
      if(kind==='lineDiscount')s.total_details.amount_discount++;
      if(kind==='foreignMode')s.livemode=true;
      return s;};
    const {createSubscriptionCheckoutSession:create}=loadCheckout({db,stripeCalls:calls,sessionMutation});
    await assert.rejects(create(retailArgs(retailSnapshot('basic',3,'monthly_installments'),'promo_validated')),
      e=>typeof e.code==='string'&&e.code.startsWith('retail_checkout_session_'));
    assert.equal(calls.sessions.length,1);assert.equal(db.rpcCalls.filter(c=>c.name==='pin_retail_existing_checkout_session').length,0);
  }
});
test('new prepaid refuses extra promotions before provider effects and customer discounts/credits before updates or checkout',async()=>{
  const base=retailArgs(retailSnapshot());
  const calls=retailCalls(),{createSubscriptionCheckoutSession:create}=loadCheckout({stripeCalls:calls});
  await assert.rejects(create({...base,promotionCodeId:'promo_synthetic'}),e=>e.code==='retail_prepaid_discount_denied');
  assert.equal(calls.sessions.length,0);assert.equal(calls.customerCreates.length,0);assert.equal(calls.customerUpdates.length,0);
  for(const customerOverride of [{discount:{id:'di_synthetic'}},{balance:-120000},{balance:100},{balance:undefined},{discount:undefined},
    {discounts:['di_synthetic']},{invoice_credit_balance:{usd:100}},{cash_balance:{available:{usd:100}}},{deleted:true}]){
    const c=retailCalls(),{createSubscriptionCheckoutSession:fn}=loadCheckout({stripeCalls:c,customerOverride});
    await assert.rejects(fn(base),e=>e.code==='retail_customer_adjustment_denied');
    assert.equal(c.sessions.length,0);assert.equal(c.customerCreates.length,0);assert.equal(c.customerUpdates.length,0);assert.equal(c.subscriptionLists.length,0);
  }
});
test('installed Stripe16 SDK serializes and retrieves new retail terms through the existing Checkout function on loopback only',async t=>{
  let sdkSession,sdkLines;
  const requests=[],server=http.createServer(async(req,res)=>{
    let body='';for await(const b of req)body+=b;const p=new URLSearchParams(body);
    requests.push({method:req.method,path:req.url,body:p,version:req.headers['stripe-version'],key:req.headers['idempotency-key']});
    let data;if(req.method==='GET'&&req.url==='/v1/customers/cus_existing')data={object:'customer',id:'cus_existing',discount:null,balance:0};
    else if(req.method==='GET'&&req.url==='/v1/promotion_codes/promo_SDK_SYNTHETIC')data=positivePromotion('promo_SDK_SYNTHETIC');
    else if(req.method==='POST'&&req.url==='/v1/customers/cus_existing')data={object:'customer',id:'cus_existing'};
    else if(req.method==='GET'&&req.url.startsWith('/v1/subscriptions?'))data={object:'list',data:[],has_more:false};
    else if(req.method==='POST'&&req.url==='/v1/checkout/sessions'){
      const metadata=Object.fromEntries([...p].filter(([k])=>/^metadata\[[^\]]+\]$/.test(k)).map(([k,v])=>[k.slice(9,-1),v]));
      const amounts=[0,1].map(n=>Number(p.get(`line_items[${n}][price_data][unit_amount]`)));
      const total=amounts.reduce((a,b)=>a+b,0);
      const promoId=p.get('discounts[0][promotion_code]'),discounts=amounts.map(amount=>promoId?Math.round(amount*.1):0);
      const discount=discounts.reduce((a,b)=>a+b,0);
      sdkSession={object:'checkout.session',id:'cs_SYNTHETIC',url:'https://checkout.stripe.test/SYNTHETIC',
        customer:p.get('customer'),mode:'subscription',status:'open',payment_status:'unpaid',currency:'usd',livemode:false,
        subscription:null,metadata,expires_at:Number(p.get('expires_at')),ui_mode:'hosted',amount_subtotal:total,amount_total:total-discount,
        success_url:p.get('success_url'),cancel_url:p.get('cancel_url'),allow_promotion_codes:p.get('allow_promotion_codes')==='true',
        total_details:{amount_discount:discount,amount_shipping:0,amount_tax:0,breakdown:{discounts:promoId?
          [{amount:discount,discount:{object:'discount',id:'di_SDK_SYNTHETIC',promotion_code:promoId,
            customer:p.get('customer'),coupon:positivePromotion(promoId).coupon}}]:[]}}};
      sdkLines={object:'list',has_more:false,data:amounts.map((amount,n)=>({id:`li_SDK_${n}`,quantity:1,currency:'usd',amount_subtotal:amount,
        amount_discount:discounts[n],amount_tax:0,amount_total:amount-discounts[n],
        price:{object:'price',id:`price_SDK_${n}`,currency:'usd',unit_amount:amount,type:n?'one_time':'recurring',
          recurring:n?null:{interval:'month',interval_count:Number(p.get('line_items[0][price_data][recurring][interval_count]')),usage_type:'licensed'}}}))};
      data=sdkSession;
    }
    else if(req.method==='GET'&&req.url.split('?')[0]==='/v1/checkout/sessions/cs_SYNTHETIC')data=sdkSession;
    else if(req.method==='GET'&&req.url.startsWith('/v1/checkout/sessions/cs_SYNTHETIC/line_items?'))data=sdkLines;
    else{res.writeHead(400,{'Content-Type':'application/json'});return res.end(JSON.stringify({error:{type:'invalid_request_error',message:'unexpected synthetic request'}}))}
    res.writeHead(200,{'Content-Type':'application/json','Stripe-Version':'2023-10-16'});res.end(JSON.stringify(data));
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>{server.closeAllConnections();server.close(r)}));
  const stripeConstructor=function(_key,opts){assert.equal(opts.apiVersion,'2023-10-16');return new InstalledStripe('sk_test_SYNTHETIC_NOT_A_CREDENTIAL',{
    apiVersion:opts.apiVersion,host:'127.0.0.1',port:server.address().port,protocol:'http',maxNetworkRetries:0})};
  for(const plan of ['basic','pro'])for(const months of [3,6,12])for(const payment of ['prepaid','monthly_installments']){
    const calls=retailCalls(),s=retailSnapshot(plan,months,payment,true),{createSubscriptionCheckoutSession:create}=loadCheckout({stripeCalls:calls,stripeConstructor});
    const args=retailArgs(s);await create(args);
    const request=requests.findLast(r=>r.method==='POST'&&r.path==='/v1/checkout/sessions'),p=request.body;
    assert.equal(request.path,'/v1/checkout/sessions');assert.equal(request.method,'POST');
    assert.equal(request.version,'2023-10-16');assert.equal(request.key,args.idempotencyKey);
    assert.equal(p.get('mode'),'subscription');assert.equal(p.get('line_items[0][price_data][unit_amount]'),String(s.platform_fee_cents));
    assert.equal(p.get('allow_promotion_codes'),'false');assert.equal(p.has('discounts[0][promotion_code]'),false);
    assert.equal(p.get('line_items[0][price_data][recurring][interval_count]'),String(payment==='prepaid'?months:1));
    assert.equal(p.get('line_items[1][price_data][unit_amount]'),String(plan==='basic'?35900:62900));
    assert.equal(p.has('line_items[1][price_data][recurring][interval]'),false);assert.equal(p.get('metadata[membership_commitment_months]'),String(months));
    assert.equal(p.has('subscription_data[trial_end]'),false);assert.equal(p.has('payment_method_types[0]'),false);
  }
  assert.equal(requests.filter(r=>r.path==='/v1/checkout/sessions').length,12);
  const before=requests.length,calls=retailCalls(),{createSubscriptionCheckoutSession:create}=loadCheckout({stripeCalls:calls,stripeConstructor});
  const args=retailArgs(retailSnapshot('basic',3,'monthly_installments',true),'promo_SDK_SYNTHETIC');
  const result=await create(args);assert.equal(result.session.amount_total,72720);
  const writes=requests.slice(before),posted=writes.find(r=>r.method==='POST'&&r.path==='/v1/checkout/sessions');
  assert.equal(writes[0].path,'/v1/promotion_codes/promo_SDK_SYNTHETIC');
  assert.equal(posted.body.get('discounts[0][promotion_code]'),'promo_SDK_SYNTHETIC');
  assert.equal(posted.body.has('allow_promotion_codes'),false);
  const fetched=writes.find(r=>r.method==='GET'&&r.path.split('?')[0]==='/v1/checkout/sessions/cs_SYNTHETIC');
  assert.equal(new URL(fetched.path,'http://127.0.0.1').searchParams.get('expand[0]'),'total_details.breakdown');
  assert.equal(posted.version,'2023-10-16');assert.equal(posted.key,args.idempotencyKey);
  assert.equal(requests.filter(r=>r.path==='/v1/checkout/sessions').length,13);
});

test('new retail direct service requires existing signed source and exact key before any SDK effects',async()=>{
  for(const override of [{retailAgreement:null},{idempotencyKey:'unbound_key'},{returnTab:'other'},
    {metadataSource:'admin_subscription_checkout'}]) {
    const calls=retailCalls(),{createSubscriptionCheckoutSession:create}=loadCheckout({stripeCalls:calls});
    await assert.rejects(create({...retailArgs(retailSnapshot()),...override}),{code:'retail_checkout_source_required'});
    assert.equal(calls.sessions.length,0);assert.equal(calls.customerUpdates.length,0);assert.equal(calls.customerCreates.length,0);
    assert.equal(calls.subscriptionLists.length,0);
  }
});
test('known Session is retrieved and re-pinned without creating again; transport/forwarded URL changes cannot change the frozen attempt',async()=>{
  const calls=retailCalls(),db=makeDb(),args=retailArgs(retailSnapshot()),{createSubscriptionCheckoutSession:create}=loadCheckout({stripeCalls:calls,db});
  const first=await create(args),attempt=structuredClone(db.attempts.get(args.retailAgreement.id));
  const second=await create({...args,embedded:true,requestContext:{forwardedHost:'untrusted.example.invalid',forwardedProto:'http'},now:'2099-01-01'});
  assert.equal(calls.sessions.length,1);assert.equal(first.session.id,second.session.id);assert.equal(second.checkoutClientSecret,null);
  assert.deepEqual(db.attempts.get(args.retailAgreement.id),attempt);
  assert.match(calls.sessions[0].payload.success_url,/^https:\/\/api\.qa\.alphasourceai\.com\//);
  assert.match(calls.sessions[0].payload.cancel_url,/^https:\/\/qa\.alphasourceai\.com\//);
  assert.equal(db.rpcCalls.filter(c=>c.name==='pin_retail_existing_checkout_session').length,2);
});
test('hosted unknown acknowledgment retries the same existing key and exact body, not a new mode or clock',async()=>{
  const calls=retailCalls(),db=makeDb(),args=retailArgs(retailSnapshot());let count=0;
  const {createSubscriptionCheckoutSession:create}=loadCheckout({stripeCalls:calls,db,sessionResponder:()=>{
    if(++count===1) throw new Error('SYNTHETIC lost acknowledgment');return{id:'cs_RECOVERED',url:'https://checkout.stripe.test/RECOVERED'};
  }});
  await assert.rejects(create(args),{code:'retail_checkout_ack_unknown'});
  const initial=structuredClone(calls.sessions[0]),b=db.attempts.get(args.retailAgreement.id).created_at;
  const second=await create({...args,embedded:true,now:'2099-01-01',requestContext:{forwardedHost:'untrusted.example.invalid'}});
  assert.equal(second.session.id,'cs_RECOVERED');assert.equal(calls.sessions.length,2);
  assert.deepEqual(calls.sessions[1],initial);assert.equal(db.attempts.get(args.retailAgreement.id).created_at,b);
});
test('unknown native pin acknowledgment exposes no result; retry retrieves the already-linked Session without another create',async()=>{
  const calls=retailCalls(),db=makeDb(),args=retailArgs(retailSnapshot()),original=db.rpc.bind(db);let lost=true;
  db.rpc=async(name,params)=>{const r=await original(name,params);if(name==='pin_retail_existing_checkout_session'&&lost){lost=false;return{data:null,error:null}}return r};
  const {createSubscriptionCheckoutSession:create}=loadCheckout({stripeCalls:calls,db});
  await assert.rejects(create(args),{code:'retail_checkout_store_unavailable'});
  assert.equal(calls.sessions.length,1);const result=await create(args);assert.equal(result.retailAttemptLinked,true);
  assert.equal(calls.sessions.length,1);
});
test('known terminal or source/price-mismatched Session never falls back to a fresh payable checkout',async()=>{
  for(const mutate of [s=>({...s,status:'complete',payment_status:'paid'}),s=>({...s,status:'expired'}),
    s=>({...s,customer:'cus_OTHER'}),s=>({...s,expires_at:s.expires_at+1}),s=>({...s,ui_mode:'embedded'}),
    s=>({...s,metadata:{...s.metadata,agreement_id:'OTHER'}}),s=>({...s,amount_total:0}),
    s=>({...s,success_url:'https://OTHER.example.invalid'}),s=>({...s,cancel_url:'https://OTHER.example.invalid'}),
    s=>({...s,allow_promotion_codes:true}),s=>({...s,total_details:{...s.total_details,amount_discount:1}})]) {
    const calls=retailCalls(),db=makeDb(),args=retailArgs(retailSnapshot());let change=false;
    const {createSubscriptionCheckoutSession:create}=loadCheckout({stripeCalls:calls,db,sessionMutation:s=>change?mutate(s):s});
    await create(args);change=true;await assert.rejects(create(args));assert.equal(calls.sessions.length,1);
    assert.equal(db.rpcCalls.filter(c=>c.name==='pin_retail_existing_checkout_session').length,1);
  }
  const calls=retailCalls(),db=makeDb(),args=retailArgs(retailSnapshot());let change=false;
  const {createSubscriptionCheckoutSession:create}=loadCheckout({stripeCalls:calls,db,lineMutation:ls=>{
    if(change)ls.data[0].price.recurring.interval_count=99;return ls;
  }});
  await create(args);change=true;await assert.rejects(create(args),{code:'retail_checkout_session_prices_mismatch'});
  assert.equal(calls.sessions.length,1);
});
test('existing attempted customer drift is held, never silently restored from stale billing mapping or replaced',async()=>{
  const calls=retailCalls(),db=makeDb(),args=retailArgs(retailSnapshot()),{createSubscriptionCheckoutSession:create}=loadCheckout({stripeCalls:calls,db});
  await create(args);const updates=calls.customerUpdates.length;db.clients[0].stripe_customer_id='cus_CHANGED';
  await assert.rejects(create(args),{code:'retail_checkout_customer_changed'});
  assert.equal(db.clients[0].stripe_customer_id,'cus_CHANGED');assert.equal(calls.sessions.length,1);
  assert.equal(calls.customerUpdates.length,updates);assert.equal(calls.customerCreates.length,0);
});
test('native closed/unknown store, corrupt claim acknowledgment and a wrong signing token stop before Session creation',async()=>{
  for(const mode of ['missing','closed','corrupt','token']) {
    const calls=retailCalls(),db=makeDb(),args=retailArgs(retailSnapshot()),original=db.rpc.bind(db);
    if(mode==='missing')db.rpc=undefined;
    if(mode==='closed')db.rpc=async()=>({data:null,error:{message:'retail_checkout_window_closed'}});
    if(mode==='corrupt')db.rpc=async(n,p)=>{const r=await original(n,p);r.data.expires_at++;return r};
    if(mode==='token')args.cancelUrl='https://qa.alphasourceai.com/membership-agreement/sign/WRONG_SYNTHETIC_TOKEN';
    const {createSubscriptionCheckoutSession:create}=loadCheckout({stripeCalls:calls,db});
    await assert.rejects(create(args));assert.equal(calls.sessions.length,0);
  }
});
test('native replay retains original replacement despite a changing live subscription list',async()=>{
  const calls=retailCalls(),db=makeDb(),args=retailArgs(retailSnapshot()),subscriptions=[{id:'sub_ORIGINAL',status:'active'}];
  const {createSubscriptionCheckoutSession:create}=loadCheckout({stripeCalls:calls,db,subscriptions});
  const first=await create(args);assert.equal(first.replacesStripeSubscriptionId,'sub_ORIGINAL');
  args.retailAgreement.replaces_stripe_subscription_id='sub_ORIGINAL';
  subscriptions.splice(0,subscriptions.length,{id:'sub_NEW_LIVE_SELECTION',status:'active'});
  const retry=await create(args);assert.equal(retry.replacesStripeSubscriptionId,'sub_ORIGINAL');
  assert.equal(calls.subscriptionLists.length,1);assert.equal(calls.sessions.length,1);
  assert.equal(retry.checkoutMetadata.replaces_stripe_subscription_id,'sub_ORIGINAL');
});
test('pinned native customer ignores unrelated historic billing rows and never rewrites them on retry',async()=>{
  const calls=retailCalls(),db=makeDb(),args=retailArgs(retailSnapshot()),{createSubscriptionCheckoutSession:create}=loadCheckout({stripeCalls:calls,db});
  await create(args);db.billingCustomers.unshift({id:'HISTORIC_PROFILE',client_id:'client-1',stripe_customer_id:'cus_HISTORIC'});
  const before=structuredClone(db.billingCustomers),retry=await create(args);
  assert.equal(retry.session.customer,'cus_existing');assert.equal(calls.sessions.length,1);
  assert.deepEqual(db.billingCustomers,before);
});
test('real Node microsecond parsing truncates rather than rounds into the next second',()=>{
  for (const fraction of ['999499','999500','999999','000999']) {
    const text=`2026-10-14T01:00:00.${fraction}Z`,ms=Date.parse(text);
    assert.equal(ms%1000,Number(fraction.slice(0,3)));
    assert.equal(Math.floor(ms/1000),Date.parse('2026-10-14T01:00:00Z')/1000);
  }
});
test('opaque SDK price id is verified through supported price readback, not fabricated fields or required expansion',async()=>{
  const calls=retailCalls(),args=retailArgs(retailSnapshot());
  const {createSubscriptionCheckoutSession:create}=loadCheckout({stripeCalls:calls,lineMutation:ls=>{
    for(const l of ls.data)l.price=l.price.id;return ls;
  }});
  const result=await create(args);assert.equal(result.retailAttemptLinked,true);assert.equal(calls.sessions.length,1);
});
test('new buyer creates exactly one existing billing profile before Checkout, with no Auth table, invite or historic rewrite',async()=>{
  const calls=retailCalls(),db=makeDb(),args=retailArgs(retailSnapshot());
  db.clients[0].stripe_customer_id=null;db.billingCustomers.splice(0);
  const {createSubscriptionCheckoutSession:create}=loadCheckout({stripeCalls:calls,db});
  const result=await create(args);assert.equal(result.session.customer,'cus_created');
  assert.equal(db.billingCustomers.length,1);assert.equal(db.billingCustomers[0].client_id,'client-1');
  assert.equal(db.billingCustomers[0].stripe_customer_id,'cus_created');assert.equal(db.inserts.length,1);
  assert.equal(db.inserts[0].table,'billing_customers');assert.equal(db.clients[0].stripe_customer_id,'cus_created');
  assert.equal(calls.sessions.length,1);
  await create(args);assert.equal(db.billingCustomers.length,1);assert.equal(calls.sessions.length,1);
});
test('mounted existing Enterprise service dispatches real helper for all cadences/modes, then pinned retry',async()=>{
 const {fixture}=require('./helpers/enterprise-existing-checkout-fixture');
 for(const cadence of ['monthly','annual'])for(const embedded of [true,false]){
  const f=fixture({cadence,embedded,platformSubtotal:0});
  const {createSubscriptionCheckoutSession:create}=loadCheckout({stripeCalls:{},db:f.db,stripeConstructor:function Stripe(_key,options){assert.equal(options.apiVersion,'2023-10-16');return f.stripe;}});
  const args={clientId:f.client.id,planTier:'enterprise',billingInterval:cadence,metadataSource:'agreement_checkout',enterpriseFees:f.args.fees,
   enterpriseAgreement:f.args.agreement,embedded,cancelUrl:f.args.cancelUrl,idempotencyKey:f.args.key};
  const a=await create(args),b=await create(args);assert.equal(a.enterpriseAttemptLinked,true);assert.equal(a.session.id,b.session.id);assert.equal(a.fallbackSession,null);
  assert.equal(f.calls.filter(c=>c.kind==='priceCreate').length,2);assert.equal(f.calls.filter(c=>c.kind==='sessionCreate').length,1);
 }
});
test('mounted marked Enterprise fee payload without native agreement/exact key refuses before Stripe constructor',async()=>{
 const {fixture}=require('./helpers/enterprise-existing-checkout-fixture');const f=fixture();let factories=0;
 const {createSubscriptionCheckoutSession:create}=loadCheckout({stripeCalls:{},db:f.db,stripeConstructor:function Stripe(){factories++;return f.stripe;}});
 for(const override of [{enterpriseAgreement:null},{idempotencyKey:'bad'},{metadataSource:'admin_subscription_checkout'}])
  await assert.rejects(create({clientId:f.client.id,planTier:'enterprise',billingInterval:'monthly',metadataSource:'agreement_checkout',enterpriseFees:f.args.fees,
   enterpriseAgreement:f.args.agreement,idempotencyKey:f.args.key,...override}));
 assert.equal(factories,0);assert.equal(f.calls.length,0);
});
test('first marked Enterprise checkout prefers native current customer over a newer historical profile without rewriting it',async()=>{
 const {fixture}=require('./helpers/enterprise-existing-checkout-fixture');const f=fixture();
 const history={id:crypto.randomUUID(),client_id:f.client.id,stripe_customer_id:'cus_HISTORICAL'};f.db.tables.billing_customers.unshift(history);
 const {createSubscriptionCheckoutSession:create}=loadCheckout({stripeCalls:{},db:f.db,stripeConstructor:function Stripe(){return f.stripe;}});
 await create({clientId:f.client.id,planTier:'enterprise',billingInterval:'monthly',metadataSource:'agreement_checkout',enterpriseFees:f.args.fees,
  enterpriseAgreement:f.args.agreement,idempotencyKey:f.args.key,cancelUrl:f.args.cancelUrl});
 assert.equal(f.a.enterprise_checkout_source.material.customer_id,'cus_SYNTHETIC');assert.equal(history.stripe_customer_id,'cus_HISTORICAL');
 assert.equal(f.calls.filter(c=>c.kind==='customer'&&c.id==='cus_HISTORICAL').length,0);
});
test('wrong, null or truncated global billing profile ownership is held before any payable Session',async()=>{
  for(const mode of ['owner','null','truncated','readerror','insertfailure']){
    const calls=retailCalls(),db=makeDb(),args=retailArgs(retailSnapshot());
    if(mode==='owner')db.billingCustomers[0].client_id='another_client';
    if(mode==='null')db.billingCustomers[0].client_id=null;
    if(mode==='truncated'||mode==='readerror'||mode==='insertfailure'){
      const original=db.from.bind(db);
      if(mode==='insertfailure')db.billingCustomers.splice(0);
      db.from=table=>{const q=original(table),exec=q.execute.bind(q);q.execute=async()=>{
        const r=await exec();if(table==='billing_customers'&&q.filters.some(f=>f.column==='stripe_customer_id')){
          if(mode==='truncated')r.count=2;if(mode==='readerror')r.error={message:'SYNTHETIC read unavailable'};
        }
        if(table==='billing_customers'&&q.insertPayload&&mode==='insertfailure')return{data:[],error:{code:'XX000'}};
        return r;
      };return q;};
    }
    const {createSubscriptionCheckoutSession:create}=loadCheckout({stripeCalls:calls,db});
    await assert.rejects(create(args));assert.equal(calls.sessions.length,0);
  }
});
