'use strict';
// Authored SDK/native transport, not payment, database authorization or effect.
const { test } = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const { fixture } = require('./fixtures/existing-retail-funding-fixture');
const { anchoredMonthInstant } = require('../src/services/membershipOffers');
const { verifyExistingRetailFunding } = require('../src/services/existingRetailCheckoutFunding');
const { prepareExistingRetailReplacement: prepare } = require('../src/services/existingRetailReplacementPreflight');
const stamp = ms => new Date(ms).toISOString().replace(/(\.\d{3})Z$/, '$1000Z');
function setup(plan='basic',months=3,payment='prepaid',role=false,source='sales_assisted',replacement=true) {
  const f = fixture(plan,months,payment,role,{admin:source==='admin'});
  // Entire success graph is authored on REAL current clock BEFORE receipt.
  // No historical B replacement, Date.now override or captured-money claim.
  const A=Math.floor(Date.now()/1000)-30,start=A-10;
  const end=Date.parse(anchoredMonthInstant(new Date(start*1000).toISOString(),f.pkg.membership_terms.stripe_recurrence.interval_count))/1000;
  f.cs.created=A-20;f.inv.created=A-10;f.inv.status_transitions.paid_at=A;
  f.s.start_date=start;f.s.current_period_end=end;Object.assign(f.s,{cancel_at_period_end:false,cancel_at:null,pause_collection:null});
  f.il.forEach((v,n)=>{v.period={start,end:n?start:end};});
  f.g.signed_at=new Date((A-3600)*1000).toISOString();f.g.agreement_expires_at=new Date((A+604800)*1000).toISOString();
  f.i.expires_at=f.g.agreement_expires_at;if(source!=='admin')f.g.template_snapshot.source=source;
  f.g.replaces_stripe_subscription_id=replacement?'sub_OLD':null;f.g.replacement_policy=replacement?'immediate_cancel':null;
  f.c.stripe_subscription_id=f.g.replaces_stripe_subscription_id;
  f.g.checkout_attempt_source={version:'retail_existing_checkout_attempt_v1',agreement_id:f.g.id,client_id:f.c.id,
    customer_id:f.c.stripe_customer_id,template_snapshot:structuredClone(f.g.template_snapshot),intent:source==='admin'?null:{id:f.i.id}};
  const money=verifyExistingRetailFunding({offer:require('../src/services/savedMembershipCheckoutTerms').readSavedRetailCheckoutTerms({agreement:f.g,intent:source==='admin'?null:f.i,deadlineMode:'stored'}).offer,
    checkout:f.cs,checkoutLines:{object:'list',data:f.cl,has_more:false},subscription:f.s,subscriptionItems:f.s.items,
    invoice:f.inv,invoiceLines:f.inv.lines,paymentIntent:f.pi,charge:f.ch,expected:{customerId:f.c.stripe_customer_id,
      signedAt:f.g.signed_at,agreementDeadline:f.g.agreement_expires_at,intentDeadline:source==='admin'?null:f.i.expires_at}});
  const map={payment_intent_id:'paymentIntentId',charge_id:'chargeId',checkout_created:'checkoutCreatedEpoch',invoice_created:'invoiceCreatedEpoch',
    platform_gross_cents:'platformGrossCents',platform_discount_cents:'platformDiscountCents',platform_net_cents:'platformNetCents',
    role_gross_cents:'roleGrossCents',role_discount_cents:'roleDiscountCents',role_net_cents:'roleNetCents',tax_cents:'taxCents',cash_cents:'cashCents'};
  f.g.retail_funding_receipt={version:'retail_existing_funding_v1',proof:{provider_account_id:'acct_SYNTHETIC',period:structuredClone(money.initialProviderPeriod),
    ...Object.fromEntries(Object.entries(map).map(([k,v])=>[k,money[v]]))},recorded_at:stamp(Date.now())};
  f.sdk.getApiField=()=> '2023-10-16';f.sdk.accounts={retrieve:async()=>({object:'account',id:'acct_SYNTHETIC'})};
  f.old={object:'subscription',id:'sub_OLD',customer:f.c.stripe_customer_id,currency:'usd',livemode:false,status:'active',canceled_at:null};
  f.sdk.subscriptions.retrieve=async key=>{f.calls.push(['subscription',key]);return structuredClone(key==='sub_OLD'?f.old:f.s);};
  f.sdk.subscriptions.cancel=async()=>{throw Error('NO DELETE PERMITTED');};
  f.rpcs=[];f.readCount=0;f.reserves=0;f.journal=null;f.hooks={};
  f.db.rpc=async(name,args)=>{
    f.rpcs.push({name,args:structuredClone(args)});
    if(name==='read_retail_existing_funding'){
      f.readCount++;const data={version:'retail_existing_funding_read_v1',phase:f.g.checkout_paid_at?'paid':'pending',receipt:structuredClone(f.g.retail_funding_receipt)};
      await f.hooks.read?.(data,f.readCount);return {data,error:null};
    }
    assert.equal(name,'reserve_retail_existing_replacement_cancel');f.reserves++;
    // Model this precise existing native policy gate; real SQL proof/ACL was
    // independently tested in prior560, not authenticated by this mock.
    if(f.g.replacement_policy!==(replacement?'immediate_cancel':null))return{data:null,error:{message:'retail_replacement_source_denied'}};
    assert.equal(args.p_agreement,f.g.id);assert.equal(args.p_intent,source==='admin'?null:f.i.id);assert.equal(args.p_claim,source==='admin'?null:f.opts.claimKey);
    assert.deepEqual(Object.keys(args.p_current).sort(),['id','customer','status','current_period_end','cancel_at_period_end','cancel_at','pause_collection'].sort());
    assert.equal(args.p_current.current_period_end,end);assert.ok(end>Date.now()/1000);
    if(!replacement){const data={status:'no_replacement',request:null,created_at:null};await f.hooks.reserve?.(data,f.reserves);return{data,error:null};}
    const existing=Boolean(f.journal);
    if(!f.journal)f.journal={request:{version:'retail_existing_replacement_cancel_v1',api_version:'2023-10-16',agreement_id:f.g.id,
      client_id:f.c.id,intent_id:source==='admin'?null:f.i.id,source_digest:'a'.repeat(64),funding_receipt_digest:'b'.repeat(64),provider_account_id:'acct_SYNTHETIC',
      livemode:false,customer_id:f.c.stripe_customer_id,old_subscription_id:'sub_OLD',new_subscription_id:f.s.id,
      cancellation:{method:'DELETE',path:'/v1/subscriptions/sub_OLD',parameters:{invoice_now:false,prorate:false},policy:'immediate_cancel'}},created_at:stamp(Date.now())};
    const data={status:existing?'existing':'reserved',...structuredClone(f.journal)};await f.hooks.reserve?.(data,f.reserves);return{data,error:null};
  };
  f.opts={...f.options,claimKey:source==='admin'?null:'SYNTHETIC_SERVER_CLAIM_000000000000000000'};
  f.baseline=structuredClone(f.tables);return f;
}
for(const source of ['sales_assisted','public_purchase_intent','admin'])for(const plan of ['basic','pro'])
for(const months of [3,6,12])for(const payment of source==='public_purchase_intent'?['prepaid']:['prepaid','monthly_installments'])for(const role of [false,true])
test(`replacement preflight GET-only ${source}/${plan}/${months}/${payment}/role${role}`,async()=>{
  const f=setup(plan,months,payment,role,source),r=await prepare(f.opts);
  assert.equal(r.status,'preflight_verified');assert.equal(r.effect_authorized,false);assert.equal(r.native_completion,false);
  assert.ok(Object.isFrozen(r)&&Object.isFrozen(r.request)&&Object.isFrozen(r.old_subscription));assert.equal(Object.keys(r).length,7);
  assert.equal(f.readCount,4);assert.equal(f.reserves,2);assert.deepEqual(f.tables,f.baseline);
  const again=await prepare(f.opts);assert.deepEqual(again,r);assert.equal(f.journal.request.old_subscription_id,'sub_OLD');
});
test('preflight genuine null replacement is explicit closed no-op; old GET absent and no journal',async()=>{
  for(const source of ['sales_assisted','admin']){const f=setup('basic',3,'prepaid',false,source,false),r=await prepare(f.opts);
    assert.equal(r.status,'no_replacement');assert.equal(r.request,null);assert.equal(r.created_at,null);assert.equal(r.old_subscription,null);
    assert.equal(f.journal,null);assert.ok(!f.calls.some(x=>x[1]==='sub_OLD'));assert.deepEqual(f.tables,f.baseline);}
});
test('all known old statuses are observations only; canceled requires finite past Unix seconds',async()=>{
  for(const status of ['incomplete','incomplete_expired','trialing','active','past_due','canceled','unpaid','paused']){
    const f=setup();f.old.status=status;if(status==='canceled')f.old.canceled_at=Math.floor(Date.now()/1000)-1;
    const r=await prepare(f.opts);assert.equal(r.old_subscription.status,status);assert.equal(r.native_completion,false);
  }
  for(const patch of [{status:'unknown'},{status:'canceled',canceled_at:null},{canceled_at:Date.now()},{canceled_at:1.5},
    {canceled_at:'123'},{canceled_at:Math.floor(Date.now()/1000)+1000},{customer:'cus_OTHER'},{id:'sub_OTHER'},{livemode:true},{currency:'eur'}]){
    const f=setup();Object.assign(f.old,patch);await assert.rejects(prepare(f.opts),{code:'retail_replacement_preflight_old_unknown'});
    assert.equal(f.reserves,1);assert.ok(f.journal);assert.deepEqual(f.tables,f.baseline);
  }
});
test('fresh cash/refund/chargeback/credit-note/identity drift holds without rewriting historical receipt',async()=>{
  for(const mutate of [f=>f.ch.refunded=true,f=>f.ch.amount_refunded=1,f=>f.ch.disputed=true,f=>f.ch.paid=false,
    f=>f.ch.captured=false,f=>f.ch.amount_captured--,f=>f.pi.amount_received--,f=>f.pi.status='processing',f=>f.inv.paid_out_of_band=true,
    f=>f.inv.post_payment_credit_notes_amount=1,f=>f.inv.amount_remaining=1,f=>f.inv.charge='ch_OTHER',f=>f.ch.customer='cus_OTHER',
    f=>f.pi.livemode=true,f=>f.il[0].proration=true,f=>f.il[0].period.end++,f=>f.il[0].tax_amounts=[{amount:1,inclusive:false,tax_rate:'txr_OTHER'}],
    f=>f.cs.mode='setup',f=>f.cs.payment_status='unpaid',f=>f.cs.id='cs_OTHER',f=>f.s.current_period_end++,
    f=>f.s.pause_collection={behavior:'keep_as_draft'},f=>delete f.s.cancel_at]){
    const f=setup();mutate(f);const saved=structuredClone(f.g.retail_funding_receipt);
    await assert.rejects(prepare(f.opts));assert.deepEqual(f.g.retail_funding_receipt,saved);assert.equal(f.reserves,0);assert.equal(f.journal,null);
  }
});
test('past original period holds, API/account/source/unfunded cannot become no-op',async()=>{
  for(const mutate of [f=>{f.s.current_period_end=f.il[0].period.end=1;f.g.retail_funding_receipt.proof.period.provider_period_end=1;},
    f=>f.sdk.getApiField=()=> 'other',f=>f.sdk.accounts.retrieve=async()=>({object:'account',id:'acct_OTHER'}),
    f=>delete f.g.retail_funding_receipt,f=>f.g.is_current=false,f=>f.g.template_version='legacy']){
    const f=setup();mutate(f);const receipt=structuredClone(f.g.retail_funding_receipt);
    await assert.rejects(prepare(f.opts));assert.deepEqual(f.g.retail_funding_receipt,receipt);assert.equal(f.reserves,0);
  }
});
test('read and reservation envelopes are distinct; unknown/lost ACK never grants effect authority',async()=>{
  for(const stage of ['read-extra','phase','receipt','res-extra','res-empty','res-body','res-stamp','res-second-reserved','throw']){
    const f=setup();f.hooks.read=(r,n)=>{if(stage==='read-extra')r.status='paid';if(n===4){if(stage==='phase')r.phase='paid';if(stage==='receipt')r.receipt.proof.cash_cents++;}};
    f.hooks.reserve=(r,n)=>{if(stage==='res-extra')r.extra=true;if(stage==='res-empty')r.request=null;
      if(n===2){if(stage==='res-body')r.request.source_digest='c'.repeat(64);if(stage==='res-stamp')r.created_at=stamp(Date.parse(r.created_at)-1);
        if(stage==='res-second-reserved')r.status='reserved';}if(stage==='throw')throw Error('PRIVATE_URL_AND_TOKEN');};
    await assert.rejects(prepare(f.opts),e=>!e.message.includes('PRIVATE_'));assert.deepEqual(f.tables,f.baseline);
  }
  const f=setup();f.hooks.reserve=()=>{throw Error('Authored committed journal then discarded ACK');};
  await assert.rejects(prepare(f.opts));const saved=structuredClone(f.journal);assert.ok(saved);assert.ok(!f.calls.some(x=>x[1]==='sub_OLD'));
  delete f.hooks.reserve;assert.equal((await prepare(f.opts)).status,'preflight_verified');assert.deepEqual(f.journal,saved);
});
test('each fresh scalar/page is safely snapshotted; getters/proxies/hidden graph never evaluated',async()=>{
  let getterCalls=0;
  for(const stage of ['invoice','charge','list','old']){
    const f=setup(),poison=()=>Object.defineProperty({},'object',{enumerable:true,get(){getterCalls++;throw Error('PRIVATE_GETTER');}});
    if(stage==='invoice')f.sdk.invoices.retrieve=async()=>poison();if(stage==='charge')f.sdk.charges.retrieve=async()=>poison();
    if(stage==='list')f.sdk.checkout.sessions.listLineItems=async()=>poison();
    if(stage==='old'){const original=f.sdk.subscriptions.retrieve;f.sdk.subscriptions.retrieve=async k=>k==='sub_OLD'?new Proxy({},{}):original(k);}
    await assert.rejects(prepare(f.opts),e=>!e.message.includes('PRIVATE_'));
  }
  assert.equal(getterCalls,0);
});
test('final B/source/policy change holds; no money or access rollback falsely reported',async()=>{
  for(const stage of ['current','source','policy']){const f=setup();f.hooks.reserve=(r,n)=>{if(n===1){
    if(stage==='current')f.s.current_period_end++;if(stage==='source')f.g.is_current=false;if(stage==='policy')f.g.replacement_policy=null;}};
    await assert.rejects(prepare(f.opts));assert.ok(f.journal);assert.equal(f.journal.request.old_subscription_id,'sub_OLD');}
});
test('preflight preserves guard-lost code but strips raw exceptions; has no default application importer or provider writes',async()=>{
  const f=setup();f.opts.assertFence=async()=>{throw Object.assign(Error('PRIVATE_SECRET'),{code:'public_purchase_activation_guard_lost'});};
  await assert.rejects(prepare(f.opts),e=>e.code==='public_purchase_activation_guard_lost'&&e.message==='public_purchase_activation_guard_lost');
  // The fenced replacement-cancellation executor is the one intentional
  // application importer; the preflight remains private everywhere else.
  const cancellation=fs.readFileSync(path.resolve(__dirname,'../src/services/existingRetailReplacementCancellation.js'),'utf8');
  assert.ok(cancellation.includes("require('./existingRetailReplacementPreflight')"));
  function scan(dir){for(const e of fs.readdirSync(dir,{withFileTypes:true})){const file=path.join(dir,e.name);
    if(e.isDirectory())scan(file);else if(e.name.endsWith('.js')&&!['existingRetailReplacementPreflight.js','existingRetailReplacementCancellation.js'].includes(e.name))
      assert.ok(!fs.readFileSync(file,'utf8').includes('existingRetailReplacementPreflight'),file);}}
  scan(path.resolve(__dirname,'../src'));
  const source=fs.readFileSync(path.resolve(__dirname,'../src/services/existingRetailReplacementPreflight.js'),'utf8');
  for(const forbidden of ['subscriptions.cancel(','.update(','.insert(','.upsert(','.auth','record_retail_existing_funding','apply_public_purchase_billing'])assert.ok(!source.includes(forbidden),forbidden);
});
test('complete pagination reuses original collector; empty continuation or repeated identity is held',async()=>{
  const f=setup('pro',6,'prepaid',true),queries=[];
  f.sdk.checkout.sessions.listLineItems=async(key,args)=>{queries.push(structuredClone(args));return {object:'list',data:[structuredClone(f.cl[args.starting_after?1:0])],has_more:!args.starting_after};};
  assert.equal((await prepare(f.opts)).status,'preflight_verified');assert.deepEqual(queries,[{limit:100},{limit:100,starting_after:f.cl[0].id}]);
  for(const duplicate of [true,false]){const g=setup();g.sdk.checkout.sessions.listLineItems=async(key,args)=>({object:'list',data:duplicate?[structuredClone(g.cl[0])]:[],has_more:true});
    await assert.rejects(prepare(g.opts));assert.equal(g.reserves,0);assert.equal(g.journal,null);}
});
test('installed Stripe and Supabase SDKs use authored loopback GET/RPC transports, not hosted authorization',async()=>{
  const http=require('node:http'),Stripe=require('stripe'),{createClient}=require('@supabase/supabase-js'),f=setup('pro',6,'prepaid',true),requests=[];
  const gateway=http.createServer(async(req,res)=>{
    try {
      const url=new URL(req.url,'http://127.0.0.1');requests.push({method:req.method,path:url.pathname,version:req.headers['stripe-version']||null});
      let data;
      if(url.pathname.startsWith('/rest/v1/rpc/')){
        assert.equal(req.method,'POST');let body='';for await(const c of req)body+=c;
        const r=await f.db.rpc(url.pathname.split('/').at(-1),JSON.parse(body));if(r.error)throw Error('Authored native hold');data=r.data;
      }else if(url.pathname.startsWith('/rest/v1/')){
        assert.equal(req.method,'GET');const table=url.pathname.split('/').at(-1);assert.ok(Object.hasOwn(f.tables,table));
        data=f.tables[table].filter(row=>[...url.searchParams].every(([k,v])=>k==='select'||v.startsWith('eq.')&&String(row[k])===v.slice(3)));
        res.setHeader('content-range',data.length?`0-${data.length-1}/${data.length}`:'*/0');
      }else {
        assert.equal(req.method,'GET');assert.equal(req.headers['stripe-version'],'2023-10-16');
        const routes={'/v1/account':{object:'account',id:'acct_SYNTHETIC'},'/v1/checkout/sessions/cs_SYNTHETIC':f.cs,
          '/v1/checkout/sessions/cs_SYNTHETIC/line_items':{object:'list',data:f.cl,has_more:false},'/v1/subscriptions/sub_SYNTHETIC':f.s,
          '/v1/subscriptions/sub_OLD':f.old,'/v1/invoices/in_INITIAL':f.inv,'/v1/invoices/in_INITIAL/lines':{object:'list',data:f.il,has_more:false},
          '/v1/subscription_items':f.s.items,'/v1/payment_intents/pi_SYNTHETIC':f.pi,'/v1/charges/ch_SYNTHETIC':f.ch};
        assert.ok(Object.hasOwn(routes,url.pathname),url.pathname);data=routes[url.pathname];
      }
      res.setHeader('content-type','application/json');res.end(JSON.stringify(data));
    }catch(_){res.statusCode=500;res.end(JSON.stringify({error:{message:'Authored loopback transport failed'}}));}
  });
  await new Promise((resolve,reject)=>{gateway.once('error',reject);gateway.listen(0,'127.0.0.1',resolve);});
  try {
    const port=gateway.address().port,stripe=new Stripe('sk_test_SYNTHETIC_NO_PROVIDER_KEY',{apiVersion:'2023-10-16',host:'127.0.0.1',port,protocol:'http',maxNetworkRetries:0,timeout:1500});
    const db=createClient(`http://127.0.0.1:${port}`,'SYNTHETIC_NO_AUTH_KEY',{auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false}});
    const result=await prepare({...f.opts,db,stripe});assert.equal(result.status,'preflight_verified');assert.equal(result.effect_authorized,false);
    assert.deepEqual(f.tables,f.baseline);assert.equal(f.readCount,4);assert.equal(f.reserves,2);
    assert.ok(requests.some(r=>r.path.endsWith('/reserve_retail_existing_replacement_cancel')));
    assert.ok(requests.some(r=>r.path==='/v1/charges/ch_SYNTHETIC'));
    assert.ok(requests.every(r=>r.method==='GET'||r.method==='POST'&&r.path.startsWith('/rest/v1/rpc/')));
    // Native/auth behavior remains a MOCK; HTTP client compatibility is real.
  }finally{await new Promise(resolve=>gateway.close(resolve));}
});
