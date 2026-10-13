'use strict';
const assert=require('node:assert/strict');const {test}=require('node:test');const express=require('express');
const {fixture,PAID,I,G,C}=require('./fixtures/existing-retail-funding-fixture');
const {anchoredMonthInstant}=require('../src/services/membershipOffers');
const {loadMembershipCommissionTerms}=require('../src/services/membershipCommissionTerms');
const {createAdminSalesPayrollRouter}=require('../src/routes/admin/salesPayroll');
const {loadSalesPayrollReport}=require('../src/services/salesPayrollReportQuery');
const REP='77777777-7777-4777-8777-777777777777',OTHER='88888888-8888-4888-8888-888888888888';
const OWNER='99999999-9999-4999-8999-999999999999';
function setup(months=3,payment='monthly_installments',plan='basic'){
  const f=fixture(plan,months,payment,true),rpcCalls=[],reads=[];
  Object.assign(f.g,{checkout_status:'paid',checkout_paid_at:PAID});
  Object.assign(f.i,{status:'completed',activated_at:PAID,billing_applied_at:'2026-02-01T00:00:00Z',
    channel:'self_service',created_by_user_id:OTHER,company_legal_name:'Original Synthetic Buyer',buyer_email:'synthetic@example.invalid'});
  Object.assign(f.c,{billing_status:'active',subscription_status:'active'});
  f.tables.retail_existing_sales_qualifications=[{purchase_intent_id:I,agreement_id:G,client_id:C,rep_user_id:REP,terms_digest:'a'.repeat(64),
    platform_cap_cents:f.pkg.membership_terms.platform_payment_cents,payment_kind:payment==='prepaid'?'paid_in_full':'monthly',
    original_start_at:PAID,original_term_end_at:anchoredMonthInstant(PAID,months),commission_window_end_at:anchoredMonthInstant(PAID,12),qualification_closed_at:PAID}];
  f.tables.sales_reps=[{user_id:REP,active:true,display_name:'Original Synthetic Rep',email:'rep@example.invalid',created_at:'2026-01-01T00:00:00Z'}];
  const from=f.db.from;
  f.db.from=table=>{reads.push(table);if(table.startsWith('membership_v2_'))throw Error('retired tables must not be queried');return from(table);};
  f.db.rpc=async(name,values)=>{
    rpcCalls.push({name,values});
    if(name==='retail_existing_commission_source')return {data:'retail_existing_terms_v2',error:null};
    if(name==='retail_existing_sales_terms_digest')return {data:'a'.repeat(64),error:null};
    throw Error('unexpected_rpc');
  };
  return {...f,rpcCalls,reads,q:f.tables.retail_existing_sales_qualifications[0]};
}
function body(f,changes={}){return {purchase_intent_id:I,provider:'stripe',provider_payment_id:'pi_SYNTHETIC_RENEWAL',
  payment_kind:f.q.payment_kind,payment_success_at:'2026-08-01T00:00:00Z',funds_received_at:'2026-08-03T00:00:00Z',
  gross_membership_cents:f.q.platform_cap_cents,discount_cents:1500,provider_fee_cents:101,evidence_reference:'synthetic admin-reviewed platform receipt',...changes};}
async function withServer(f,callback){const app=express();app.use(express.json());
  app.use('/payroll',(req,_res,next)=>{req.user={id:OWNER};next();},createAdminSalesPayrollRouter({db:f.db}));
  const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
  try{await callback(async data=>{const res=await fetch(`http://127.0.0.1:${server.address().port}/payroll/receipts`,{
    method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(data)});return {status:res.status,body:await res.json()};});}
  finally{await new Promise(resolve=>server.close(resolve));}
}
for(const plan of ['basic','pro'])for(const months of [3,6,12])for(const payment of ['prepaid','monthly_installments']){
  test(`existing receipt API ${plan}/${months}/${payment} freezes original rep and actual platform receipt`,async()=>{
    const f=setup(months,payment,plan);
    await withServer(f,async send=>{
      const result=await send(body(f,{rep_user_id:OTHER,membership_terms_protocol:'legacy_receipt_v1',membership_contract_id:OWNER,
        sales_qualification_id:OTHER,policy_version:'forged',qualification_closed_at:'2099-01-01T00:00:00Z'}));
      assert.equal(result.status,201,JSON.stringify(result));const row=f.tables.sales_commission_receipts[0];
      assert.equal(row.rep_user_id,REP);assert.equal(row.membership_terms_protocol,'retail_existing_terms_v2');
      assert.equal(row.sales_qualification_id,I);assert.equal(row.membership_contract_id,null);assert.equal(row.membership_contract_version,null);
      assert.equal(row.policy_version,'retail-existing-terms-v2-commission-v1');assert.equal(row.qualification_closed_at,PAID);
      assert.equal(row.first_term_end_at,anchoredMonthInstant(PAID,months));assert.equal(row.gross_membership_cents,f.q.platform_cap_cents);
      assert.ok(row.gross_membership_cents<f.pkg.membership_terms.initial_payment_cents);
      assert.deepEqual([...new Set(f.rpcCalls.map(r=>r.name))],['retail_existing_commission_source','retail_existing_sales_terms_digest']);
      assert.ok(!f.reads.some(t=>t.startsWith('membership_v2_')));
    });
  });
}
test('new marked receipt missing qualification or partial billing never falls back to legacy',async()=>{
  for(const change of [f=>f.tables.retail_existing_sales_qualifications=[],f=>f.i.billing_applied_at=null,
    f=>f.i.status='checkout_pending',f=>f.g.checkout_status='pending',f=>f.g.status='draft']){
    const f=setup();change(f);await withServer(f,async send=>{
      const result=await send(body(f));assert.equal(result.status,409);assert.ok(!f.tables.sales_commission_receipts?.length);
    });
  }
});
test('original first-year boundary, provider/type, role amount and inactive client remain guarded',async()=>{
  const f=setup();await withServer(f,async send=>{
    for(const changes of [{payment_success_at:anchoredMonthInstant(PAID,12),funds_received_at:'2027-02-01T00:00:00Z'},
      {payment_kind:'paid_in_full'},{provider:'financing_partner'},{gross_membership_cents:f.pkg.membership_terms.initial_payment_cents}]){
      const result=await send(body(f,changes));assert.equal(result.status,422);assert.ok(!f.tables.sales_commission_receipts?.length);
    }
    f.c.billing_status='inactive';assert.equal((await send(body(f))).body.error,'client_not_active');
  });
});
test('source/schema/classification/digest failures are holds, never raw errors or legacy evidence',async()=>{
  for(const rpc of [async()=>{throw Error('private secret failure');},async()=>({data:null,error:{code:'42883'}}),
    async()=>({data:'unknown',error:null}),async name=>name==='retail_existing_commission_source'?{data:'retail_existing_terms_v2',error:null}:{data:null,error:{code:'42883'}}]){
    const f=setup();f.db.rpc=rpc;await withServer(f,async send=>{const result=await send(body(f));
      assert.equal(result.status,503);assert.equal(result.body.error,'sales_payroll_unavailable');assert.ok(!f.tables.sales_commission_receipts?.length);
    });
  }
});
test('changed qualification source tuple, cap, original A, kind or digest rejects without writes',async()=>{
  for(const change of [f=>f.q.client_id=OWNER,f=>f.q.agreement_id=OWNER,f=>f.q.platform_cap_cents++,
    f=>f.q.original_start_at='2026-02-01T00:00:00Z',f=>f.q.qualification_closed_at=f.g.signed_at,
    f=>f.q.payment_kind='paid_in_full',f=>f.q.commission_window_end_at=anchoredMonthInstant(PAID,6),
    f=>f.q.terms_digest='b'.repeat(64),f=>f.i.activated_at='2026-02-01T00:00:00Z',f=>f.q.rep_user_id=null,
    f=>f.g.template_snapshot.package_snapshot={}]){
    const f=setup();change(f);await assert.rejects(loadMembershipCommissionTerms(f.db,f.i),error=>error.name!=='TypeError'&&error.name!=='ReferenceError');
    assert.ok(!f.tables.sales_commission_receipts?.length);
  }
});
test('new report and effective-date adjustment preserve original rep without touching retired tables',async()=>{
  const f=setup(),rid='55555555-5555-4555-8555-555555555555';
  f.tables.sales_commission_receipts=[{id:rid,purchase_intent_id:I,rep_user_id:REP,funds_received_at:'2026-08-03T00:00:00Z',
    payment_kind:'monthly',gross_membership_cents:44900,discount_cents:1500,provider_fee_cents:101,net_membership_cents:43299,
    commission_cents:21650,reviewed_at:'2026-08-03T01:00:00Z',membership_terms_protocol:'retail_existing_terms_v2',sales_qualification_id:I,
    membership_contract_id:null,membership_contract_version:null}];
  f.tables.sales_commission_adjustments=[{id:'synthetic-adjustment',receipt_id:rid,net_membership_delta_cents:-100,commission_delta_cents:-50,
    effective_at:'2026-09-01T12:00:00Z',reviewed_at:'2026-09-01T13:00:00Z'}];
  const report=await loadSalesPayrollReport(f.db,{date_from:'2026-09-01',date_to:'2026-09-02'},'2026-09-03T00:00:00Z');
  assert.equal(report.totals.sale_count,0);assert.equal(report.totals.adjustment_cents,-100);
  assert.equal(report.representatives[0].user_id,REP);assert.equal(report.representatives[0].events[0].date,'2026-09-01');
  assert.ok(!f.reads.some(t=>t.startsWith('membership_v2_')));
  f.tables.retail_existing_sales_qualifications=[];
  await assert.rejects(loadSalesPayrollReport(f.db,{date_from:'2026-09-01',date_to:'2026-09-02'}),/qualification.*join_failed/);
});
