'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {reserveFirstMembershipPayment}=require('../src/services/membershipInitialPaymentStore');
const {buildRetailOffer,OFFER_VERSION}=require('../src/services/membershipOffers');
const {planFirstMembershipActivation}=require('../src/services/membershipPaymentActivation');
const ids={contractId:'20000000-0000-4000-8000-000000000001',clientId:'10000000-0000-4000-8000-000000000001',
  billingOwnerUserId:'30000000-0000-4000-8000-000000000001',contractVersion:1};
function fixture({paymentOption='prepaid',months=3,firstRole=false}={}) {
  const offer=buildRetailOffer({planKey:'basic',commitmentMonths:months,paymentOption,channel:'sales',
    offerVersion:OFFER_VERSION,firstRolePrepaySelected:firstRole});
  const common={created:Date.parse('2026-01-01T00:00:00Z')/1000,livemode:false,customer:'cus_Test'};
  const price={object:'price',id:'price_Platform',currency:'usd',unit_amount:offer.platform_payment_cents,
    type:'recurring',recurring:{...offer.stripe_recurrence,usage_type:'licensed'}};
  const lines={object:'list',has_more:false,data:[{id:'il_Platform',type:'subscription',subscription:'sub_Test',
    subscription_item:'si_Test',quantity:1,proration:false,currency:'usd',amount:offer.platform_payment_cents,
    price,discount_amounts:[],tax_amounts:[]}]};
  if(firstRole) lines.data.push({id:'il_Role',type:'invoiceitem',subscription:null,subscription_item:null,
    quantity:1,proration:false,currency:'usd',amount:offer.first_role_prepay.amount_cents,
    price:{object:'price',id:'price_Role',currency:'usd',unit_amount:offer.first_role_prepay.amount_cents,
      type:'one_time',recurring:null},discount_amounts:[],tax_amounts:[]});
  const objects={
    account:{object:'account',id:'acct_Test'},
    checkout:{...common,object:'checkout.session',id:'cs_Test',mode:'subscription',currency:'usd',status:'complete',
      payment_status:'paid',subscription:'sub_Test',invoice:'in_Test',amount_total:offer.initial_payment_cents},
    subscription:{...common,object:'subscription',id:'sub_Test',currency:'usd',status:'active'},
    items:{object:'list',has_more:false,data:[{id:'si_Test',subscription:'sub_Test',quantity:1,price}]},
    invoice:{...common,object:'invoice',id:'in_Test',currency:'usd',subscription:'sub_Test',payment_intent:'pi_Test',charge:'ch_Test',
      billing_reason:'subscription_create',status:'paid',paid:true,paid_out_of_band:false,collection_method:'charge_automatically',
      amount_due:offer.initial_payment_cents,amount_paid:offer.initial_payment_cents,amount_remaining:0,
      starting_balance:0,ending_balance:0,pre_payment_credit_notes_amount:0,post_payment_credit_notes_amount:0,
      discounts:[],total_discount_amounts:[],total_tax_amounts:[],subtotal:offer.initial_payment_cents,
      total:offer.initial_payment_cents,tax:0,status_transitions:{paid_at:Date.parse('2026-01-31T12:13:14Z')/1000}},
    lines,paymentIntent:{...common,object:'payment_intent',id:'pi_Test',invoice:'in_Test',latest_charge:'ch_Test',currency:'usd',
      status:'succeeded',amount:offer.initial_payment_cents,amount_received:offer.initial_payment_cents},
    charge:{...common,object:'charge',id:'ch_Test',invoice:'in_Test',payment_intent:'pi_Test',currency:'usd',status:'succeeded',
      paid:true,captured:true,amount:offer.initial_payment_cents,amount_captured:offer.initial_payment_cents,
      amount_refunded:0,refunded:false,disputed:false},refunds:{object:'list',has_more:false,data:[]}
  };
  const contract={id:ids.contractId,client_id:ids.clientId,billing_owner_user_id:ids.billingOwnerUserId,
    contract_version:1,offer_snapshot:offer};
  const binding={contract_id:ids.contractId,contract_version:1,provider_account_id:'acct_Test',livemode:false,
    customer_id:'cus_Test',checkout_session_id:'cs_Test',subscription_id:'sub_Test',platform_price_id:'price_Platform',
    platform_item_id:'si_Test',first_role_price_id:firstRole?'price_Role':null};
  const calls=[],queries=[],rpcCalls=[]; let saved=null,authCount=0;
  const control={contract,binding,objects,scope:{...ids},dbError:null,rpcError:null,rpcAction:null,
    unreadableAfterWrite:false,prior:null,postReadMutation:null};
  const read=(key,expectedArgs)=>async(...actual)=>{
    calls.push({key,args:actual});assert.deepEqual(actual,expectedArgs);return structuredClone(objects[key]);};
  const stripe={getApiField:()=> '2023-10-16',accounts:{retrieve:read('account',[])},
    checkout:{sessions:{retrieve:read('checkout',['cs_Test'])}},subscriptions:{retrieve:read('subscription',['sub_Test'])},
    subscriptionItems:{list:read('items',[{subscription:'sub_Test',limit:100,expand:['data.price']}])},
    invoices:{retrieve:read('invoice',['in_Test']),listLineItems:read('lines',['in_Test',{limit:100,expand:['data.price']}])},
    paymentIntents:{retrieve:read('paymentIntent',['pi_Test'])},charges:{retrieve:read('charge',['ch_Test'])},
    refunds:{list:read('refunds',[{charge:'ch_Test',limit:100}])}};
  const db={from(table){const filters=[]; const query={select(){return query;},eq(k,v){filters.push([k,v]);return query;},
    async maybeSingle(){queries.push({table,filters});if(control.dbError)return {error:control.dbError};
      const rows={membership_v2_contracts:control.contract,membership_v2_provider_bindings:control.binding,
        membership_v2_initial_receipts:control.unreadableAfterWrite&&saved?null:saved||control.prior};
      const row=rows[table];return {data:row?structuredClone(row):null,error:null};}};return query;},
    async rpc(name,params){rpcCalls.push({name,params});if(control.rpcError)return {error:control.rpcError};
      const prior=saved||control.prior;
      const proof=params.p_receipt;
      const keys=['contract_id','contract_version','offer_version','checkout_session_id','customer_id','subscription_id',
        'invoice_id','payment_intent_id','charge_id','platform_price_id','platform_item_id','first_role_price_id',
        'livemode','currency','payment_success_at','platform_line_id'];
      const identity=Object.fromEntries(keys.map(key=>[key,proof[key]]));identity.provider_account_id=params.p_provider_account_id;
      saved=prior||{identity}; if(control.postReadMutation)control.postReadMutation(saved.identity);
      return {data:{action:control.rpcAction||(prior?'already_reserved':'initial_payment_reserved')},error:null};}
  };
  const input={db,stripe,contractId:ids.contractId,observedAt:()=>Date.parse('2026-02-01T00:00:00Z')/1000,
    authorizeBillingOwner:async()=>{authCount++;return structuredClone(control.scope);}};
  return {input,control,calls,queries,rpcCalls,get saved(){return saved;},get authCount(){return authCount;},
    pureInput(){return {binding:{contractId:contract.id,contractVersion:1,offer,livemode:false,checkoutSessionId:'cs_Test',
      customerId:'cus_Test',subscriptionId:'sub_Test',platformPriceId:'price_Platform',platformItemId:'si_Test',
      firstRolePriceId:firstRole?'price_Role':null},checkout:objects.checkout,subscription:{...objects.subscription,items:objects.items},
      invoice:{...objects.invoice,lines:objects.lines},paymentIntent:objects.paymentIntent,charge:{...objects.charge,refunds:objects.refunds},
      observedAt:input.observedAt()};}};
}

for(const paymentOption of ['prepaid','monthly_installments'])for(const months of [3,6,12]) {
  test(`adapter reserves scoped authenticated ${paymentOption}/${months} receipt, never grants access`,async()=>{
    const f=fixture({paymentOption,months,firstRole:true});const result=await reserveFirstMembershipPayment(f.input);
    assert.equal(result.action,'initial_payment_reserved');assert.equal(result.providerAlignmentRequired,true);
    assert.equal(f.authCount,2);assert.equal(f.rpcCalls.length,1);assert.equal(f.calls.length,9);
    assert.equal(f.rpcCalls[0].name,'membership_v2_reserve_initial_payment');
    assert.equal(f.rpcCalls[0].params.p_provider_account_id,'acct_Test');
    assert.equal(result.paymentIdentity.platform_line_id,'il_Platform');
    assert.equal(result.paymentIdentity.payment_success_at,'2026-01-31T12:13:14.000Z');
    assert.equal(Object.hasOwn(result,'active'),false);assert.equal(Object.hasOwn(result,'access_end_at'),false);
    assert.deepEqual(f.queries[0].filters,[['id',ids.contractId],['contract_version',1],['client_id',ids.clientId],['billing_owner_user_id',ids.billingOwnerUserId]]);
  });
}
test('authorization is mandatory before any database/provider access',async()=>{
  for(const callback of [undefined,async()=>null,async()=>({...ids,contractId:'foreign'})]) {
    const f=fixture();f.input.authorizeBillingOwner=callback;
    await assert.rejects(reserveFirstMembershipPayment(f.input),{status:403});
    assert.equal(f.queries.length,0);assert.equal(f.calls.length,0);assert.equal(f.rpcCalls.length,0);
  }
});
test('persisted contract scope and pinned API are checked even if DB returns a foreign row',async()=>{
  for(const key of ['client_id','billing_owner_user_id','id','contract_version']) {
    const f=fixture();f.control.contract[key]='foreign';
    await assert.rejects(reserveFirstMembershipPayment(f.input),{code:'membership_scope_denied'});
    assert.equal(f.calls.length,0);
  }
  const f=fixture();f.input.stripe.getApiField=()=> '2026-01-01';
  await assert.rejects(reserveFirstMembershipPayment(f.input),{code:'membership_stripe_version_unverified'});
});
test('account credential and persisted binding, never metadata, own provider scope',async()=>{
  const f=fixture();f.control.objects.account.id='acct_Foreign';
  await assert.rejects(reserveFirstMembershipPayment(f.input),{code:'membership_provider_account_conflict'});
  assert.equal(f.calls.length,1);assert.equal(f.rpcCalls.length,0);
  const g=fixture();g.control.objects.checkout.metadata={contract_id:'foreign',offer_version:'foreign'};
  await reserveFirstMembershipPayment(g.input);assert.equal(g.rpcCalls[0].params.p_contract_id,ids.contractId);
});
test('incomplete native page, wrong ownership or unpaid graph cannot reserve',async()=>{
  for(const mutate of [f=>f.control.objects.lines.has_more=true,f=>f.control.objects.items.has_more=true,
    f=>f.control.objects.refunds.has_more=true,f=>f.control.objects.invoice.amount_paid=0,
    f=>f.control.objects.lines.data[0].subscription='sub_Foreign',f=>f.control.objects.paymentIntent.amount_received=1,
    f=>f.control.objects.checkout.livemode=true,f=>f.control.objects.charge.disputed=true]) {
    const f=fixture();mutate(f);await assert.rejects(reserveFirstMembershipPayment(f.input));assert.equal(f.rpcCalls.length,0);
  }
});
test('scope revoked or changed during provider reads stops the database write',async()=>{
  for(const changed of [null,{...ids,clientId:'10000000-0000-4000-8000-000000000009'}]) {
    const f=fixture();let count=0;f.input.authorizeBillingOwner=async()=>++count===1?ids:changed;
    await assert.rejects(reserveFirstMembershipPayment(f.input),{status:403});assert.equal(f.rpcCalls.length,0);
  }
});
test('same historical payment after refund/cancellation is identity-only replay',async()=>{
  const f=fixture();const activation=planFirstMembershipActivation(f.pureInput()).activation;
  f.control.prior={identity:{...activation,provider_account_id:'acct_Test',platform_line_id:'il_Platform'}};
  f.control.objects.charge.refunded=true;f.control.objects.charge.amount_refunded=10;
  f.control.objects.refunds.data=[{id:'re_Test',charge:'ch_Test',amount:10}];f.control.objects.subscription.status='canceled';
  const result=await reserveFirstMembershipPayment(f.input);assert.equal(result.action,'already_reserved');
  assert.equal(Object.hasOwn(f.rpcCalls[0].params.p_receipt,'collected_cents'),false);
  assert.equal(result.providerAlignmentRequired,true);
});
test('different historical identity is held without a write',async()=>{
  const f=fixture();f.control.prior={identity:{...planFirstMembershipActivation(f.pureInput()).activation,charge_id:'ch_Other'}};
  await assert.rejects(reserveFirstMembershipPayment(f.input),{code:'conflicting_initial_activation'});
  assert.equal(f.rpcCalls.length,0);
});
test('transaction errors are bounded/sanitized and never claimed as activation',async()=>{
  for(const code of ['23505','40001','P0001']) {
    const f=fixture();f.control.rpcError={code,message:'secret raw provider/SQL text'};
    await assert.rejects(reserveFirstMembershipPayment(f.input),error=>error.code.startsWith('membership_')&&!error.message.includes('secret'));
  }
});
test('thrown authorization/provider/database transport errors never expose raw text',async()=>{
  for(const mutate of [f=>f.input.authorizeBillingOwner=async()=>{throw Error('private raw credential');},
    f=>f.input.stripe.accounts.retrieve=async()=>{throw Error('private raw credential');},
    f=>f.input.stripe.refunds.list=async()=>{throw Error('private raw credential');},
    f=>f.input.db.rpc=async()=>{throw Error('private raw credential');},
    f=>f.input.db.from=()=>({select(){return this;},eq(){return this;},async maybeSingle(){throw Error('private raw credential');}})]) {
    const f=fixture();mutate(f);await assert.rejects(reserveFirstMembershipPayment(f.input),
      error=>error.status===503 && !error.message.includes('private'));
  }
});
test('database read error, unknown RPC result and missing/wrong transaction readback hold',async()=>{
  for(const mutate of [f=>f.control.dbError={message:'secret'},f=>f.control.rpcAction='active',
    f=>f.control.unreadableAfterWrite=true,f=>f.control.postReadMutation=identity=>identity.charge_id='ch_Wrong',
    f=>f.control.postReadMutation=identity=>identity.provider_account_id='acct_Wrong']) {
    const f=fixture();mutate(f);await assert.rejects(reserveFirstMembershipPayment(f.input),{status:503});
  }
});
test('no real credentials, network client, existing route or provider write is imported',()=>{
  const source=require('node:fs').readFileSync(require.resolve('../src/services/membershipInitialPaymentStore'),'utf8');
  assert.doesNotMatch(source,/require\(['"](?:stripe|\.\.\/clients\/stripe|\.\.\/clients\/supabase)['"]\)|process\.env|\.update\(|\.create\(/);
});
