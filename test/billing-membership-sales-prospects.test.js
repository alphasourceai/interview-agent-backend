'use strict';
const assert=require('node:assert/strict'),{test}=require('node:test');
const {createMembershipSalesProspectService}=require('../src/services/membershipSalesProspects');
const scope='10000000-0000-4000-8000-000000000001',rep='10000000-0000-4000-8000-000000000002';
const quote='10000000-0000-4000-8000-000000000003';
const valid={company_legal_name:'Synthetic Company',buyer_first_name:'Test',buyer_last_name:'Buyer',buyer_email:'buyer@example.invalid'};
function fixture(context={scope_id:scope,audience:'sales',issuer_user_id:rep,original_salesperson_user_id:rep,client_id:null,billing_owner_user_id:null}){
  let reads=0,rpcs=0,handoffs=0;
  const service=createMembershipSalesProspectService({db:{from(){reads++;throw new Error('unexpected read');},rpc(){rpcs++;throw new Error('unexpected RPC');}},
    authorizeScope:async()=>context,handoffVerification:async()=>handoffs++});
  return {service,counters:()=>({reads,rpcs,handoffs})};
}
test('explicit injected trusted authorization and handoff required; no default external adapters',()=>{
  assert.throws(()=>createMembershipSalesProspectService(),e=>e.code==='sales_prospect_not_configured');
  assert.throws(()=>createMembershipSalesProspectService({db:{from(){},rpc(){}},authorizeScope:async()=>({})}),e=>e.code==='sales_prospect_not_configured');
});
test('browser source/issuer/amount/capability fields and missing CAS are rejected before reads',async()=>{
  for(const input of [{quoteId:quote,buyer:valid},{quoteId:quote,expectedSourceId:null,buyer:valid,issuer_user_id:rep},
    {quoteId:quote,expectedSourceId:null,buyer:valid,price:1},{quoteId:quote,expectedSourceId:null,buyer:valid,token:'forged'},
    {quoteId:quote,expectedSourceId:'00000000-0000-0000-0000-000000000000',buyer:valid}]){
    const f=fixture();await assert.rejects(()=>f.service.createProspect({},input),e=>e.code==='invalid_sales_prospect');
    assert.deepEqual(f.counters(),{reads:0,rpcs:0,handoffs:0});
  }
});
test('buyer mailbox injection, control/markup/surrogate, missing identity and arbitrary fields fail before writes',async()=>{
  for(const changed of [{buyer_email:'victim@example.invalid\nBcc:other@example.invalid'},
    {buyer_email:'two@example.invalid,other@example.invalid'},{buyer_email:'a..b@example.invalid'},
    {buyer_email:'a.@example.invalid'},{buyer_email:'unicode@exämple.invalid'},
    {buyer_first_name:'<script>'},{buyer_last_name:'\ud800'},{company_legal_name:'\u0000'},
    {buyer_title:'\u0085'},{buyer_phone:'7205551234'},{buyer_phone:'+012345678'},
    {buyer_first_name:''},{company_legal_name:'x'.repeat(161)},{verified:true},{client_id:rep}]){
    const f=fixture();await assert.rejects(()=>f.service.createProspect({}, {quoteId:quote,expectedSourceId:null,buyer:{...valid,...changed}}),e=>e.code==='invalid_sales_buyer');
    assert.equal(f.counters().rpcs,0);assert.equal(f.counters().handoffs,0);
  }
});
test('public/admin/existing-client contexts are held, not silently interpreted as manual rep',async()=>{
  for(const context of [{scope_id:scope,audience:'admin',issuer_user_id:rep,original_salesperson_user_id:rep,client_id:null,billing_owner_user_id:null},
    {scope_id:scope,audience:'sales',issuer_user_id:rep,original_salesperson_user_id:quote,client_id:null,billing_owner_user_id:null},
    {scope_id:scope,audience:'sales',issuer_user_id:rep,original_salesperson_user_id:rep,client_id:quote,billing_owner_user_id:quote}]){
    const f=fixture(context);await assert.rejects(()=>f.service.createProspect({}, {quoteId:quote,expectedSourceId:null,buyer:valid}),e=>e.code==='sales_prospect_denied');
    assert.deepEqual(f.counters(),{reads:0,rpcs:0,handoffs:0});
  }
});
test('scope/quote/source IDs or idempotency keys cannot substitute for high-entropy email token',async()=>{
  for(const token of [scope,quote,'short','',null,'x'.repeat(44),'x'.repeat(42),'x'.repeat(42)+'!']){
    const f=fixture();await assert.rejects(()=>f.service.verifyEmail({sourceId:scope,token}),e=>e.code==='sales_email_denied');
    assert.deepEqual(f.counters(),{reads:0,rpcs:0,handoffs:0});
  }
  const f=fixture();await assert.rejects(()=>f.service.verifyEmail({sourceId:scope,token:'x'.repeat(43),email_verified:true}),e=>e.code==='sales_email_denied');
});
