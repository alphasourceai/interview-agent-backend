'use strict';
// Existing caller/response wiring with authored native ACKs; NOT DB or Stripe acceptance.
const {test}=require('node:test'),assert=require('node:assert/strict');
const clientPath=require.resolve('../src/clients/supabase');
require.cache[clientPath]={id:clientPath,filename:clientPath,loaded:true,exports:{supabaseAdmin:{}}};
const {generationRecurringFixture}=require('./fixtures/generation-retail-recurring-funding-fixture');
const {loadExistingRetailSubscriptionTerms:load,assertExistingRetailSubscription:verify}=require('../src/services/contracts/subscriptionPricingTerms');
const {readClientRetailBillingSummary:summary}=require('../src/services/clientRetailBillingSummary');
const {renderRetailRenewalNotice:render}=require('../src/services/contracts/retailRenewalNotice');
const {anchoredMonthInstant}=require('../src/services/membershipOffers');
for(const plan of ['basic','pro'])for(const months of [3,6,12])for(const payment of ['prepaid','monthly_installments'])
test(`new accepted terms use existing summary/subscription/notice ${plan}/${months}/${payment}`,async()=>{
 const {f,source}=generationRecurringFixture(plan,months,payment);
 Object.assign(f.g,{status:'active',checkout_status:'paid',checkout_paid_at:source.original_period.paid_at});
 Object.assign(f.c,{plan_tier:plan,billing_interval:f.pkg.billing_cadence,auto_renew:true,
  stripe_subscription_id:f.s.id,contract_start_at:f.g.initial_term_start+'T00:00:00.000Z',
  contract_end_at:f.g.initial_renewal_date+'T00:00:00.000Z',billing_status:'active'});
 // Model actual PostgREST selected-column behavior; missing C columns in a
 // query cannot be hidden by an over-generous fake returning the whole row.
 const from=f.db.from.bind(f.db);f.db.from=table=>{const q=from(table),select=q.select.bind(q),one=q.maybeSingle.bind(q);let columns;
  q.select=(value,options)=>{columns=value;select(value,options);return q;};
  q.maybeSingle=async()=>{const r=await one();if(r.data&&columns&&columns!=='*')r.data=Object.fromEntries(columns.split(',').map(k=>[k,r.data[k]]));return r;};return q;
 };
 const cutoff=anchoredMonthInstant(source.original_period.first_collection_at,months-f.offer.stripe_recurrence.interval_count),calls=[];
 f.db.rpc=async name=>{calls.push(name);if(name==='read_retail_existing_recurring_source')return{data:source,error:null};
  assert.equal(name,'change_retail_existing_renewal');return{data:{status:'none',operation:null,billing_cutoff_at:cutoff},error:null};};
 const context=await load({db:f.db,clientId:f.c.id});assert.equal(context.recurringPriceId,f.g.retail_checkout_prices.recurring_platform_price_id);
 verify(context,f.s);
 const bad=structuredClone(f.s);bad.items.data[0].price.id=f.g.retail_checkout_prices.initial_platform_price_id;
 assert.throws(()=>verify(context,bad),{code:'retail_subscription_terms_mismatch'});
 const result=await summary({db:f.db,client:f.c});assert.equal(result.stripe_renewal_billing_cutoff_at,cutoff);
 assert.equal(result.current_term_start_at,f.c.contract_start_at);assert.equal(result.current_term_end_at,f.c.contract_end_at);
 assert.ok(calls.includes('change_retail_existing_renewal'));
 const notice=render({package_snapshot:f.pkg,billing_cutoff_at:cutoff},{escapeHtml:x=>x,buildBrandedEmailShell:x=>x.contentHtml});
 assert.match(notice.text,new RegExp(months+'-month'));assert.ok(notice.text.includes(new Date(cutoff).toUTCString()));
 assert.equal(f.c.billing_status,'active');
});
