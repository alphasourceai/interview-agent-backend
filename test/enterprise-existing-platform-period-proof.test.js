'use strict';
// Authored provider objects and existing strict native receipt fixtures only.
const {test}=require('node:test'),assert=require('node:assert/strict');
const dbPath=require.resolve('../src/clients/supabase');
require.cache[dbPath]={id:dbPath,filename:dbPath,loaded:true,exports:{supabaseAdmin:{from(){throw Error('local pure proof DB forbidden');}}}};
const accepted=require('./helpers/accepted-enterprise-usage-fixture');
const {proveExistingEnterprisePlatformPeriod:prove}=require('../src/services/existingEnterprisePlatformPeriodProof');
const clone=v=>structuredClone(v);
async function fixture({tax=0,discount=0,cadence='monthly',offset=0}={}){
 const f=await accepted({cadence}),p=f.w.funding_receipt.proof,originalAnchor=f.w.subscription.current_period_end;
 const {anchoredMonthInstant}=require('../src/services/membershipOffers'),span=cadence==='annual'?12:1;
 const anchor=Date.parse(anchoredMonthInstant(new Date(originalAnchor*1000).toISOString(),offset*span))/1000;
 Object.assign(f.a,{superseded_by_agreement_id:null});
 const price={object:'price',id:p.platform_price_id,livemode:p.livemode,currency:'usd',unit_amount:p.platform_nominal_cents,
  type:'recurring',recurring:{interval:p.platform_interval,interval_count:1,usage_type:'licensed'},billing_scheme:'per_unit',
  transform_quantity:null,tiers_mode:null,custom_unit_amount:null};
 const discounts=discount?[{amount:discount,discount:'di_LOCAL_PLATFORM'}]:[],taxes=tax?[{amount:tax,tax_rate:'txr_LOCAL_PLATFORM',inclusive:false}]:[];
 const gross=p.platform_nominal_cents,total=gross-discount+tax,paid=anchor+60;
 const invoice={object:'invoice',id:'in_LOCAL_PLATFORM_PERIOD',customer:p.customer_id,subscription:p.subscription_id,livemode:p.livemode,
  currency:'usd',billing_reason:'subscription_cycle',collection_method:'charge_automatically',subtotal:gross,total,amount_due:total,
  amount_paid:total,amount_remaining:0,paid:true,status:'paid',paid_out_of_band:false,starting_balance:0,ending_balance:0,
  pre_payment_credit_notes_amount:0,post_payment_credit_notes_amount:0,application_fee_amount:null,transfer_data:null,
  on_behalf_of:null,shipping_cost:null,total_discount_amounts:discounts,total_tax_amounts:taxes,created:anchor,
  status_transitions:{paid_at:paid},payment_intent:'pi_LOCAL_PLATFORM_PERIOD',charge:'ch_LOCAL_PLATFORM_PERIOD'};
 const end=Date.parse(anchoredMonthInstant(new Date(originalAnchor*1000).toISOString(),(offset+1)*span))/1000;
 const line={object:'line_item',id:'il_LOCAL_PLATFORM_PERIOD',type:'subscription',proration:false,quantity:1,currency:'usd',
  subscription:p.subscription_id,subscription_item:p.platform_item_id,price,amount:gross,period:{start:anchor,end},
  discount_amounts:discounts,tax_amounts:taxes};
 const common={customer:p.customer_id,livemode:p.livemode,currency:'usd',amount:total,created:anchor,
  invoice:invoice.id,payment_method:'pm_LOCAL_PLATFORM_PERIOD'};
 const paymentIntent={...common,object:'payment_intent',id:invoice.payment_intent,latest_charge:invoice.charge,
  status:'succeeded',amount_received:total};
 const charge={...common,object:'charge',id:invoice.charge,payment_intent:paymentIntent.id,status:'succeeded',paid:true,captured:true,
  amount_captured:total,amount_refunded:0,refunded:false,disputed:false};
 return{agreement:f.a,invoice,invoiceLines:[line],paymentIntent,charge,refunds:[],providerAccountId:p.provider_account_id,
  observedAt:new Date((paid+1)*1000).toISOString()};
}
test('platform cycle uses original nominal price/native cadence and excludes pool; no authority',async()=>{
 const x=await fixture(),before=clone(x),p=prove(x);
 assert.equal(p.platform_gross_cents,99999);assert.equal(p.cash_cents,99999);assert.equal(p.ordinal,1);
 assert.equal(p.paid_access_authorized,false);assert.equal(p.payroll_authorized,false);assert.equal(p.provider_effect_authorized,false);
 assert.equal(p.original_paid_at,x.agreement.enterprise_funding_receipt.proof.payment_success_at);
 assert.deepEqual(x,before);
});
test('platform discounts and exclusive tax reconcile exactly, not pool/usage or commission gross',async()=>{
 const p=prove(await fixture({tax:700,discount:1000}));
 assert.equal(p.platform_gross_cents,99999);assert.equal(p.platform_net_cents,98999);assert.equal(p.tax_cents,700);assert.equal(p.cash_cents,99699);
});
for(const cadence of ['monthly','annual'])for(const offset of [0,1,11])test(`native ${cadence} cycle ${offset+1} keeps original Stripe calendar, not legal or first-cash date`,async()=>{
 const x=await fixture({cadence,offset}),p=prove(x);
 assert.equal(p.ordinal,offset+1);assert.equal(p.platform_gross_cents,99999);
 assert.equal(p.provider_period_start,x.invoiceLines[0].period.start);assert.equal(p.provider_period_end,x.invoiceLines[0].period.end);
});
for(const [name,change] of [
 ['initial invoice',x=>{x.invoice.id=x.agreement.enterprise_funding_receipt.proof.invoice_id;}],
 ['pool line',x=>{x.invoiceLines[0].price.id=x.agreement.enterprise_checkout_prices.pool_price_id;}],
 ['usage invoice',x=>{x.invoice.subscription=null;}],['extra line',x=>{x.invoiceLines.push(clone(x.invoiceLines[0]));}],
 ['price drift',x=>{x.invoiceLines[0].price.unit_amount++;}],['wrong cadence',x=>{x.invoiceLines[0].price.recurring.interval_count=2;}],
 ['proration',x=>{x.invoiceLines[0].proration=true;}],['foreign subscription item',x=>{x.invoiceLines[0].subscription_item='si_FOREIGN';}],
 ['foreign explicit parent',x=>{x.invoiceLines[0].invoice='in_FOREIGN';}],['foreign account',x=>{x.providerAccountId='acct_FOREIGN';}],
 ['foreign customer',x=>{x.paymentIntent.customer='cus_FOREIGN';}],['mode mismatch',x=>{x.invoice.livemode=!x.invoice.livemode;}],
 ['period drift',x=>{x.invoiceLines[0].period.end++;}],['unpaid',x=>{x.invoice.paid=false;}],
 ['out of band',x=>{x.invoice.paid_out_of_band=true;}],['credit balance',x=>{x.invoice.starting_balance=1;}],
 ['cash mismatch',x=>{x.charge.amount_captured--;}],['returned cash',x=>{x.charge.amount_refunded=1;}],
 ['refund census absent',x=>{delete x.refunds;}],['refund census nonempty',x=>{x.refunds=[{id:'re_LOCAL'}];}],
 ['embedded refunds truncated',x=>{x.charge.refunds={object:'list',data:[],has_more:true};}],
 ['embedded own undefined',x=>{x.charge.refunds=undefined;}],['dispute',x=>{x.charge.disputed=true;}],
 ['future cash',x=>{x.invoice.status_transitions.paid_at+=100;}],
 ['unknown tax',x=>{x.invoiceLines[0].tax_amounts=[{amount:0}];}],
 ['inclusive tax',x=>{x.invoiceLines[0].tax_amounts=[{amount:0,tax_rate:'txr_LOCAL',inclusive:true}];}],
 ['unpaid source',x=>{x.agreement.checkout_status='pending_payment';}],
 ['foreign agreement',x=>{x.agreement.id='00000000-0000-4000-8000-000000000099';}],
 ['foreign source owner',x=>{x.agreement.client_id='00000000-0000-4000-8000-000000000099';}],
 ['unmatched original cash clock',x=>{x.agreement.checkout_paid_at='2026-10-01T13:00:00.000001Z';}],
 ['mutated accepted values',x=>{x.agreement.template_snapshot.values.platform_fee='1';}],
 ['clock without zone',x=>{x.observedAt=x.observedAt.slice(0,-1);}],
 ['mutable receipt',x=>{x.agreement.enterprise_billing_receipt.client_initial.auto_renew=false;}]
])test(`platform period holds ${name}`,async()=>{const x=await fixture();change(x);assert.throws(()=>prove(x),{code:'enterprise_platform_period_unverified'});});
test('native subsecond observation retains original provider second precision',async()=>{
 const x=await fixture();x.observedAt=x.observedAt.replace('.000Z','.987654Z');
 assert.equal(prove(x).cash_cents,99999);
});
