'use strict';
// Actual existing helper/routes with authored native acknowledgments, not SQL,
// settlement or provider acceptance. Separate disposable tests exercise INSERTs.
const {test}=require('node:test'),assert=require('node:assert/strict'),express=require('express'),request=require('supertest');
const {createFakeSupabase}=require('./helpers/fakeSupabase');
const accepted=require('./helpers/accepted-enterprise-usage-fixture');
const {anchoredMonthInstant}=require('../src/services/membershipOffers');
const {createAdminSalesPayrollRouter}=require('../src/routes/admin/salesPayroll');
const {loadExistingEnterpriseCommissionTerms:load}=require('../src/services/existingEnterpriseCommissionTerms');
const {loadSalesPayrollReport}=require('../src/services/salesPayrollReportQuery');
const {buildSalesPayrollReport}=require('../src/services/salesPayrollReport');
const REP='10000000-0000-4000-8000-000000000095',OTHER='10000000-0000-4000-8000-000000000096',OWNER='10000000-0000-4000-8000-000000000097';
const clone=structuredClone,six=x=>new Date(x).toISOString().replace(/Z$/,'000Z');
async function setup(cadence='monthly'){
 const f=await accepted({cadence,clientLegalName:'Cedar Vale Synthetic Payroll'}),n=f.nativeFixture,w=f.w,p=w.funding_receipt.proof;
 Object.assign(n.pool,{status:'paid',paid_at:p.payment_success_at,stripe_payment_intent_id:p.payment_intent_id});
 const tables={...n.db.tables,sales_reps:[{user_id:REP,active:true,email:'rep@example.invalid',display_name:'Original Synthetic Rep',created_at:'2026-01-01Z'}],
  sales_commission_receipts:[],sales_commission_adjustments:[],sales_commission_departures:[],sales_commission_statement_locks:[]};
 const db=createFakeSupabase(tables),calls=[];
 const q={version:'enterprise_existing_commission_qualification_v1',agreement_id:n.a.id,client_id:n.client.id,rep_user_id:REP,
  billing_source_digest:'a'.repeat(32),original_paid_at:six(p.payment_success_at),original_term_end_at:w.client_initial.contract_end_at,
  commission_window_end_at:six(anchoredMonthInstant(p.payment_success_at,12)),qualification_closed_at:six(p.payment_success_at),
  client_legal_name:'Cedar Vale Synthetic Payroll',original_rep_attested:true,payment_kind:cadence==='annual'?'paid_in_full':'monthly',payroll_authorized:false};
 const ack={version:'enterprise_existing_commission_payment_v1',qualification:q,provider_payment_id:p.invoice_id,
  gross_membership_cents:p.platform_line_cents,discount_cents:0,payment_success_at:six(p.payment_success_at),ordinal:0,
  provider_effect_authorized:false,paid_access_authorized:false,payroll_authorized:false,settlement_verified:false};
 const state={db,tables,n,w,p,q,ack,calls};
 db.rpc=async(name,args)=>{
  if(name==='sales_commission_receipt_is_renewal')return{data:false,error:null}; // these fixtures contain only ordinal-zero initial payments
  calls.push({name,args:clone(args)});if(name==='read_enterprise_existing_billing')return{data:clone(w),error:null};
  assert.equal(name,'read_enterprise_existing_commission_payment');assert.equal(args.p_agreement,n.a.id);assert.equal(args.p_client,n.client.id);
  if(!tables.sales_commission_receipts.length&&args.p_attested!==true)return{data:null,error:{code:'P0001',message:'enterprise_commission_original_rep_attestation_required'}};
  if(args.p_rep!==null&&args.p_rep!==REP)return{data:null,error:{code:'P0001',message:'enterprise_commission_original_rep_mismatch'}};
  if(state.error)return{data:null,error:state.error};
  const result=clone(state.ack);if(state.change)state.change(result);return{data:result,error:null};
 };
 return state;
}
const body=f=>({enterprise_agreement_id:f.n.a.id,original_rep_user_id:REP,original_rep_attested:true,provider:'stripe',
 provider_payment_id:f.p.invoice_id,payment_kind:f.q.payment_kind,gross_membership_cents:f.p.platform_line_cents,
 discount_cents:0,provider_fee_cents:101,payment_success_at:f.p.payment_success_at,funds_received_at:'2026-10-03T18:00:00Z',
 evidence_reference:'SYNTHETIC original seller and platform-only bank evidence'});
function app(f){const a=express();a.use(express.json());a.use('/payroll',(req,_res,next)=>{req.user={id:OWNER};next();},createAdminSalesPayrollRouter({db:f.db}));return a;}
const send=(f,patch={})=>request(app(f)).post('/payroll/receipts').send({...body(f),...patch});
for(const cadence of ['monthly','annual'])test(`existing payroll POST ${cadence} Enterprise uses native platform proof and no fabricated intent`,async()=>{
 const f=await setup(cadence),r=await send(f,{membership_terms_protocol:'legacy_receipt_v1',rep_user_id:OTHER,enterprise_commission_source:{forged:true}});
 assert.equal(r.status,201,JSON.stringify(r.body));const row=f.tables.sales_commission_receipts[0];
 assert.equal(row.purchase_intent_id,null);assert.equal(row.enterprise_agreement_id,f.n.a.id);assert.equal(row.rep_user_id,REP);
 assert.deepEqual(clone(row.enterprise_commission_source),f.q);assert.equal(row.membership_terms_protocol,'enterprise_existing_terms_v1');
 assert.equal(row.gross_membership_cents,f.p.platform_line_cents);assert.ok(row.gross_membership_cents<f.p.collected_cents);
 assert.equal(f.tables.public_purchase_intents.length,0);assert.ok(f.calls.every(r=>['read_enterprise_existing_billing','read_enterprise_existing_commission_payment'].includes(r.name)));
 assert.ok(!JSON.stringify(r.body).includes('billing_source_digest'));
});
test('Enterprise manual receipt requires first original rep attestation and cannot override saved attribution',async()=>{
 const f=await setup();assert.equal((await send(f,{original_rep_attested:false})).status,409);assert.equal(f.tables.sales_commission_receipts.length,0);
 assert.equal((await send(f)).status,201);
 assert.equal((await send(f,{original_rep_user_id:OTHER})).status,409);assert.equal(f.tables.sales_commission_receipts.length,1);
});
test('Enterprise manual API retains exact proof, dates, kind, provider and unambiguous source gates',async()=>{
 const f=await setup();for(const patch of [{gross_membership_cents:f.p.collected_cents},{discount_cents:1},{provider:'other_verified'},
  {payment_kind:'financed_checkout'},{purchase_intent_id:OTHER},{payment_success_at:'2026-10-02T13:00:00Z'},
  {provider_payment_id:f.p.payment_intent_id}]){const r=await send(f,patch);assert.equal(r.status,422,JSON.stringify(r.body));assert.equal(f.tables.sales_commission_receipts.length,0);}
});
test('Enterprise native acknowledgment cannot invent settlement, payroll authority, dates, source identity or a retail term',async()=>{
 for(const change of [r=>{r.settlement_verified=true;},r=>{r.payroll_authorized=true;},r=>{r.qualification.rep_user_id=OTHER;},
  r=>{r.qualification.original_paid_at='2026-10-02T13:00:00.000000Z';},r=>{r.qualification.original_paid_at='2026-10-01T13:00:00.000001Z';},
  r=>{r.qualification.commitment_months=12;},r=>{r.qualification.client_legal_name='OTHER';},r=>{r.gross_membership_cents+=1;}]){
  const f=await setup();f.change=change;
  await assert.rejects(load(f.db,{agreementId:f.n.a.id,paymentId:f.p.invoice_id,repUserId:REP,originalRepAttested:true}),/enterprise_commission_unverified/);
 }
});
test('Enterprise overview exposes only redacted candidate fields and saved original rep, no native source/seal',async()=>{
 const f=await setup();assert.equal((await send(f)).status,201);
 const r=await request(app(f)).get('/payroll');assert.equal(r.status,200,JSON.stringify(r.body));
 assert.equal(r.body.enterprise_review_candidates[0].id,f.n.a.id);assert.equal(r.body.enterprise_review_candidates[0].original_rep_user_id,REP);
 for(const key of ['billing_source_digest','signer_token_hash','enterprise_checkout_source','execution_seal','enterprise_commission_source'])assert.ok(!JSON.stringify(r.body).includes(key));
});
test('Enterprise report counts distinct agreements without null-intent joins and retains archived sale refund attribution',async()=>{
 const f=await setup(),r=await send(f);assert.equal(r.status,201);const row=f.tables.sales_commission_receipts[0];
 Object.assign(row,{id:'10000000-0000-4000-8000-000000000098',reviewed_at:'2026-10-03T19:00:00Z',net_membership_cents:row.gross_membership_cents-101,
  commission_cents:Math.round((row.gross_membership_cents-101)/2)});
 const otherAgreement='10000000-0000-4000-8000-000000000099';
 f.tables.sales_commission_receipts.push({...clone(row),id:'10000000-0000-4000-8000-000000000100',enterprise_agreement_id:otherAgreement,
  enterprise_commission_source:{...clone(row.enterprise_commission_source),agreement_id:otherAgreement,client_legal_name:'Other Synthetic Client'}});
 const report=await loadSalesPayrollReport(f.db,{date_from:'2026-10-01',date_to:'2026-10-31'},'2026-10-16T00:00:00Z');
 assert.equal(report.totals.sale_count,2);assert.equal(report.totals.gross_sales_cents,2*row.gross_membership_cents);
 const {buildSalesPayrollWorkbook}=require('../src/services/salesPayrollWorkbook'),zip=await require('jszip').loadAsync(await buildSalesPayrollWorkbook(report));
 const repSheet=await zip.file('xl/worksheets/sheet2.xml').async('string');assert.ok(repSheet.includes(f.q.client_legal_name));
 assert.ok(repSheet.includes('Other Synthetic Client'));assert.ok(repSheet.includes('Enterprise monthly platform payment'));
 const archived=buildSalesPayrollReport({dateFrom:'2026-11-01',dateTo:'2026-11-30',representatives:f.tables.sales_reps,intents:[],receipts:[],linkedReceipts:[row],
  adjustments:[{id:'refund',receipt_id:row.id,effective_at:'2026-11-03T18:00:00Z',adjustment_type:'refund',net_membership_delta_cents:-100,commission_delta_cents:-50}]});
 assert.equal(archived.totals.sale_count,0);assert.equal(archived.totals.commission_cents,-50);assert.equal(archived.representatives[0].events[0].client_name,f.q.client_legal_name);
});
