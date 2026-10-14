'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const file=require.resolve('../src/clients/supabase');require.cache[file]={id:file,filename:file,loaded:true,exports:{supabaseAdmin:{}}};
const {usageHistoryFromBatches:project,mergeUsageHistory:merge}=require('../src/services/billingReadModel');
const accepted={billingClientId:'synthetic-owner',agreementId:'synthetic-agreement',unitPriceCents:2500};
function row(){return{id:'synthetic-batch',owner_id:accepted.billingClientId,agreement_id:accepted.agreementId,
 service_month:'2026-10-01',phase:'reserved',unit_price_cents:2500,provider_operation:null,
 groups:[{role_id:'synthetic-role',quantity:2,unit_price_cents:2500,amount_cents:5000,interview_ids:['a','b']}]};}
test('same history displays reserved, full invoiced and recorded paid without exposing leaf requests',()=>{
 const b=row();let r=project([b],accepted)[0];assert.equal(r.billing_status,'reserved');assert.equal(r.stripe_invoice_id,null);
 assert.equal(r.amount_cents,5000);assert.equal(r.interviews,2);assert.equal(r.period_end,'2026-11-01T00:00:00.000Z');
 b.provider_operation={invoice_id:'in_SYNTHETIC',status:'pending',operations:{invoice:{proof:{stage:'shell'}},
  finalize:{proof:{stage:'finalized',total_cents:5000,invoice_id:'in_SYNTHETIC'}}}};
 r=project([b],accepted)[0];assert.equal(r.billing_status,'invoiced_open');assert.equal(r.paid_at,null);
 b.provider_operation.status='paid';b.provider_operation.operations.pay={proof:{invoice_id:'in_SYNTHETIC',amount_cents:5000,
  paid_at:1793491200,payment_intent_id:'pi_SYNTHETIC',charge_id:'ch_SYNTHETIC'}};
 r=project([b],accepted)[0];assert.equal(r.billing_status,'paid');assert.equal(r.paid_at,'2026-11-01T00:00:00.000Z');
 assert.equal(Object.hasOwn(r,'provider_operation'),false);assert.equal(Object.hasOwn(r,'customer_id'),false);
});
test('shell acknowledgement is still reserved, never invoiced or paid',()=>{
 const b=row();b.provider_operation={invoice_id:'in_SYNTHETIC',status:'pending',operations:{invoice:{proof:{stage:'shell'}}}};
 const r=project([b],accepted)[0];assert.equal(r.billing_status,'reserved');assert.equal(r.stripe_invoice_id,null);
});
test('malformed/foreign/duplicate/partial price and unproven paid data hold entire history',()=>{
 for(const change of [b=>{b.owner_id='foreign';},b=>{b.agreement_id='foreign';},b=>{b.groups[0].quantity='2';},
  b=>{b.groups[0].amount_cents=1;},b=>{b.groups[0].interview_ids=['a','a'];},b=>{b.service_month='2026-10-02';},
  b=>{b.provider_operation={status:'paid',invoice_id:'in_SYNTHETIC'};}]){const b=row();change(b);assert.throws(()=>project([b],accepted));}
 const b=row();assert.throws(()=>project([b,b],accepted));
});
test('partial/mismatched finalize, null group and repeated interview across roles hold instead of reserved/counting twice',()=>{
 for(const change of [b=>{b.groups=[null];},b=>{b.groups.push({...b.groups[0],role_id:'other'});},
  b=>{b.provider_operation={invoice_id:'in_SYNTHETIC',operations:{finalize:{proof:{stage:'finalized',total_cents:1,invoice_id:'in_SYNTHETIC'}}}};},
  b=>{b.provider_operation={invoice_id:'in_SYNTHETIC',operations:{finalize:{proof:{stage:'finalized',total_cents:5000,invoice_id:'in_OTHER'}}}};}]){
  const b=row();change(b);assert.throws(()=>project([b],accepted),{code:'enterprise_usage_terms_unavailable'});
 }
 const a=row();a.provider_operation={invoice_id:'in_SAME',operations:{finalize:{proof:{stage:'finalized',total_cents:5000,invoice_id:'in_SAME'}}}};
 assert.throws(()=>project([a,{...a,id:'second'}],accepted),{code:'enterprise_usage_terms_unavailable'});
});
test('complete legacy census precedes period limit and preserves older native invoice stamp',async()=>{
 const {createFakeSupabase}=require('./helpers/fakeSupabase'),{listBilledUsageInvoices}=require('../src/services/usageBilling');
 const rows=[{id:'1',client_id:'owner',stripe_invoice_id:'in_JAN',unit_price_cents:2500,period_start:'2026-01-01',billed_at:'2026-12-01'},
  {id:'2',client_id:'owner',stripe_invoice_id:'in_NOV',unit_price_cents:2500,period_start:'2026-11-01',billed_at:'2026-11-02'},
  {id:'3',client_id:'owner',stripe_invoice_id:'in_DEC_NATIVE',unit_price_cents:2500,period_start:'2026-12-01',billed_at:'2026-10-01'}];
 const db=createFakeSupabase({usage_billing_ledger:rows});
 const all=await listBilledUsageInvoices({db,clientId:'owner',limit:Number.MAX_SAFE_INTEGER,complete:true});
 assert.equal(all.length,3);assert.equal(merge([],all,1)[0].stripe_invoice_id,'in_DEC_NATIVE');
 const native=[{batch_id:'native',stripe_invoice_id:'in_DEC_NATIVE',amount_cents:2500,interviews:1,period_start:'2026-12-01',billed_at:null}];
 const merged=merge(native,all,1);assert.equal(merged[0].stripe_invoice_id,'in_DEC_NATIVE');assert.equal(merged[0].billed_at,'2026-10-01');
 assert.equal(merge([],all.filter(i=>i.stripe_invoice_id!=='in_DEC_NATIVE'),1)[0].stripe_invoice_id,'in_NOV');
 const many=createFakeSupabase({usage_billing_ledger:Array.from({length:1001},(_,n)=>({...rows[0],id:String(n).padStart(6,'0'),stripe_invoice_id:'in_'+n}))});
 assert.equal((await listBilledUsageInvoices({db:many,clientId:'owner',limit:Number.MAX_SAFE_INTEGER,complete:true})).length,1001);
});
