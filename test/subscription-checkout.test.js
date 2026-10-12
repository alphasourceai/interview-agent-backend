'use strict'

const assert = require('node:assert/strict')
const path = require('node:path')
const http = require('node:http')
const InstalledStripe = require('stripe')
const { test } = require('node:test')

const checkoutPath = path.join(__dirname, '..', 'src', 'services', 'subscriptionCheckout.js')
const supabaseClientPath = path.join(__dirname, '..', 'src', 'clients', 'supabase.js')
const clientBillingScopePath = path.join(__dirname, '..', 'src', 'services', 'clientBillingScope.js')
const urlConfigPath = path.join(__dirname, '..', 'src', 'config', 'urlConfig.js')
const stripePath = require.resolve('stripe')

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

  rows() {
    if (this.table === 'clients') return this.db.clients
    if (this.table === 'billing_customers') return this.db.billingCustomers
    return []
  }

  async maybeSingle() {
    return { data: this.rows().find((row) => matchesFilters(row, this.filters)) || null, error: null }
  }

  async execute() {
    if (this.updatePayload) {
      const rows = this.rows().filter((row) => matchesFilters(row, this.filters))
      for (const row of rows) Object.assign(row, this.updatePayload)
      this.db.updates.push({ table: this.table, payload: this.updatePayload, rows })
      return { data: rows, error: null }
    }
    return { data: this.rows().filter((row) => matchesFilters(row, this.filters)), error: null }
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
    updates: [],
    from(table) {
      return new FakeQuery(this, table)
    }
  }
  return db
}

function loadCheckout({ stripeCalls, stripeConstructor, sessionResponder }) {
  delete require.cache[checkoutPath]
  delete require.cache[supabaseClientPath]
  delete require.cache[clientBillingScopePath]
  delete require.cache[urlConfigPath]
  delete require.cache[stripePath]

  injectModule(supabaseClientPath, { supabaseAdmin: makeDb() })
  injectModule(clientBillingScopePath, {
    requireParentClient: async () => ({ ok: true, clientId: 'client-1' })
  })
  injectModule(urlConfigPath, {
    resolvePublicBackendBase(value) {
      return value || 'https://api.qa.alphasourceai.com'
    },
    buildClientDashboardReturnUrl(query = {}) {
      const params = new URLSearchParams(query)
      return `https://qa.alphasourceai.com/dashboard?${params.toString()}`
    }
  })
  injectModule(stripePath, stripeConstructor || function Stripe() {
    return {
      customers: {
        retrieve: async (id) => ({ id }),
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
          return { data: [] }
        }
      },
      checkout: {
        sessions: {
          create: async (payload, options) => {
            stripeCalls.sessions.push({ payload, options })
            if (sessionResponder) return sessionResponder(payload, options)
            return { id: 'cs_test_subscription', url: 'https://checkout.stripe.test/cs_test_subscription' }
          }
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
    await create({clientId:'client-1',planTier:planKey,billingInterval:snapshot.billing_cadence,packageSnapshot:snapshot,
      metadataSource:'agreement_checkout',idempotencyKey:`existing-agreement:${planKey}:${months}:${payment}:${role}`,
      metadata:{client_id:'wrong-client',plan_tier:'enterprise',billing_interval:'annual',membership_commitment_months:'99',first_role_prepay_selected:'wrong'}});
    assert.equal(calls.sessions.length,1);const {payload:p,options}=calls.sessions[0];assert.equal(p.mode,'subscription');
    assert.equal(p.customer,'cus_existing');assert.equal(p.line_items.length,role?2:1);
    assert.equal(p.line_items[0].price_data.unit_amount,offer.platform_payment_cents);
    assert.deepEqual(p.line_items[0].price_data.recurring,{interval:'month',interval_count:payment==='prepaid'?months:1});
    assert.equal(p.allow_promotion_codes,true);assert.equal(p.metadata.client_id,'client-1');assert.equal(p.metadata.plan_tier,planKey);
    assert.equal(p.metadata.billing_interval,snapshot.billing_cadence);assert.equal(p.metadata.membership_commitment_months,String(months));
    assert.equal(p.metadata.first_role_prepay_selected,String(role));assert.equal(p.metadata.first_role_prepay_amount_cents,String(offer.first_role_prepay.amount_cents));
    assert.deepEqual(p.subscription_data.metadata,p.metadata);assert.equal('trial_end' in p.subscription_data,false);
    assert.equal('billing_cycle_anchor' in p.subscription_data,false);assert.ok(options.idempotencyKey.startsWith('existing-agreement:'));
    if(role){assert.equal(p.line_items[1].price_data.unit_amount,planKey==='basic'?35900:62900);assert.equal('recurring' in p.line_items[1].price_data,false)}
  }
});
test('new retail checkout rejects mismatched plan/cadence/role, malformed source and unsafe identity before provider effects',async()=>{
  const snapshot=retailSnapshot(),cases=[{planTier:'pro'},{billingInterval:'annual'},{idempotencyKey:''},{idempotencyKey:'ambiguous key'},
    {idempotencyKey:'A'.repeat(256)},
    {firstRolePrepay:{selected:true,credit_type:'first_role_prepay',amount_cents:35900,normal_role_fee_cents:39900,discount_percent:10}},
    {packageSnapshot:{pricing_protocol:'retail_package_terms_v2'}}];
  for(const change of cases){const calls=retailCalls(),{createSubscriptionCheckoutSession:create}=loadCheckout({stripeCalls:calls});
    await assert.rejects(create({clientId:'client-1',planTier:'basic',billingInterval:'prepaid',packageSnapshot:snapshot,
      idempotencyKey:'existing-agreement:synthetic',metadataSource:'agreement_checkout',...change}));
    assert.equal(calls.sessions.length,0);assert.equal(calls.customerCreates.length,0);assert.equal(calls.customerUpdates.length,0);assert.equal(calls.subscriptionLists.length,0)}
});
test('new retail Checkout does not create a second hosted session after an ambiguous embedded result',async()=>{
  const calls=retailCalls(),{createSubscriptionCheckoutSession:create}=loadCheckout({stripeCalls:calls});
  await assert.rejects(create({clientId:'client-1',planTier:'basic',billingInterval:'prepaid',packageSnapshot:retailSnapshot(),
    idempotencyKey:'existing-agreement:embedded',metadataSource:'agreement_checkout',embedded:true}),e=>e.code==='retail_checkout_ack_unknown');
  assert.equal(calls.sessions.length,1);assert.equal(calls.sessions[0].payload.ui_mode,'embedded');
});
test('confirmed new retail embedded checkout retains its primary session without a second payable fallback',async()=>{
  const calls=retailCalls(),{createSubscriptionCheckoutSession:create}=loadCheckout({stripeCalls:calls,
    sessionResponder:()=>({id:'cs_SYNTHETIC_EMBEDDED',url:null,client_secret:'SYNTHETIC_NOT_A_REAL_SECRET'})});
  const result=await create({clientId:'client-1',planTier:'basic',billingInterval:'prepaid',packageSnapshot:retailSnapshot(),
    idempotencyKey:'existing-agreement:embedded-confirmed',metadataSource:'agreement_checkout',embedded:true});
  assert.equal(calls.sessions.length,1);assert.equal(result.session.id,'cs_SYNTHETIC_EMBEDDED');assert.equal(result.fallbackSession,null);
  assert.equal(result.checkoutClientSecret,'SYNTHETIC_NOT_A_REAL_SECRET');
});
test('new retail pricing preserves the existing validated promotion-code behavior',async()=>{
  const calls=retailCalls(),{createSubscriptionCheckoutSession:create}=loadCheckout({stripeCalls:calls});
  await create({clientId:'client-1',planTier:'basic',billingInterval:'prepaid',packageSnapshot:retailSnapshot(),
    idempotencyKey:'existing-agreement:promotion',metadataSource:'agreement_checkout',promotionCodeId:'promo_validated'});
  assert.deepEqual(calls.sessions[0].payload.discounts,[{promotion_code:'promo_validated'}]);
  assert.equal('allow_promotion_codes' in calls.sessions[0].payload,false);
});
test('installed Stripe16 SDK serializes new retail terms through the existing Checkout function on loopback only',async t=>{
  const requests=[],server=http.createServer(async(req,res)=>{
    let body='';for await(const b of req)body+=b;const p=new URLSearchParams(body);
    requests.push({method:req.method,path:req.url,body:p,version:req.headers['stripe-version'],key:req.headers['idempotency-key']});
    let data;if(req.method==='GET'&&req.url==='/v1/customers/cus_existing')data={object:'customer',id:'cus_existing'};
    else if(req.method==='POST'&&req.url==='/v1/customers/cus_existing')data={object:'customer',id:'cus_existing'};
    else if(req.method==='GET'&&req.url.startsWith('/v1/subscriptions?'))data={object:'list',data:[],has_more:false};
    else if(req.method==='POST'&&req.url==='/v1/checkout/sessions')data={object:'checkout.session',id:'cs_SYNTHETIC',url:'https://checkout.stripe.test/SYNTHETIC'};
    else{res.writeHead(400,{'Content-Type':'application/json'});return res.end(JSON.stringify({error:{type:'invalid_request_error',message:'unexpected synthetic request'}}))}
    res.writeHead(200,{'Content-Type':'application/json','Stripe-Version':'2023-10-16'});res.end(JSON.stringify(data));
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>{server.closeAllConnections();server.close(r)}));
  const stripeConstructor=function(_key,opts){assert.equal(opts.apiVersion,'2023-10-16');return new InstalledStripe('sk_test_SYNTHETIC_NOT_A_CREDENTIAL',{
    apiVersion:opts.apiVersion,host:'127.0.0.1',port:server.address().port,protocol:'http',maxNetworkRetries:0})};
  for(const plan of ['basic','pro'])for(const months of [3,6,12])for(const payment of ['prepaid','monthly_installments']){
    const calls=retailCalls(),s=retailSnapshot(plan,months,payment,true),{createSubscriptionCheckoutSession:create}=loadCheckout({stripeCalls:calls,stripeConstructor});
    await create({clientId:'client-1',planTier:plan,billingInterval:s.billing_cadence,packageSnapshot:s,
      metadataSource:'agreement_checkout',idempotencyKey:`existing-agreement:${plan}:${months}:${payment}:sdk`});
    const request=requests.at(-1),p=request.body;assert.equal(request.path,'/v1/checkout/sessions');assert.equal(request.method,'POST');
    assert.equal(request.version,'2023-10-16');assert.equal(request.key,`existing-agreement:${plan}:${months}:${payment}:sdk`);
    assert.equal(p.get('mode'),'subscription');assert.equal(p.get('line_items[0][price_data][unit_amount]'),String(s.platform_fee_cents));
    assert.equal(p.get('line_items[0][price_data][recurring][interval_count]'),String(payment==='prepaid'?months:1));
    assert.equal(p.get('line_items[1][price_data][unit_amount]'),String(plan==='basic'?35900:62900));
    assert.equal(p.has('line_items[1][price_data][recurring][interval]'),false);assert.equal(p.get('metadata[membership_commitment_months]'),String(months));
    assert.equal(p.has('subscription_data[trial_end]'),false);assert.equal(p.has('payment_method_types[0]'),false);
  }
  assert.equal(requests.filter(r=>r.path==='/v1/checkout/sessions').length,12);
});
