'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const file=require.resolve('../src/clients/supabase');require.cache[file]={id:file,filename:file,loaded:true,exports:{supabaseAdmin:{}}};
const {usageHistoryFromBatches:project}=require('../src/services/billingReadModel');
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
