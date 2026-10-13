'use strict';
const assert=require('node:assert/strict');
const test=require('node:test');
const express=require('express');
const {buildRetailOffer,OFFER_VERSION,anchoredMonthInstant}=require('../src/services/membershipOffers');
const {loadMembershipCommissionTerms}=require('../src/services/membershipCommissionTerms');
const {createAdminSalesPayrollRouter}=require('../src/routes/admin/salesPayroll');
const ids={owner:'10000000-0000-4000-8000-000000000001',rep:'10000000-0000-4000-8000-000000000002',
  client:'10000000-0000-4000-8000-000000000003',agreement:'10000000-0000-4000-8000-000000000004',
  intent:'10000000-0000-4000-8000-000000000005',contract:'10000000-0000-4000-8000-000000000006',
  otherRep:'10000000-0000-4000-8000-000000000007'};
const start='2025-01-31T14:20:30.000Z',close='2025-01-31T14:20:40.000Z';
function fixture(months=3,payment='monthly_installments') {
  const offer=buildRetailOffer({planKey:'basic',commitmentMonths:months,paymentOption:payment,channel:'sales',offerVersion:OFFER_VERSION});
  return {
    public_purchase_intents:{id:ids.intent,status:'completed',channel:'sales_assisted',created_by_user_id:ids.rep,
      agreement_id:ids.agreement,client_id:ids.client,activated_at:close,selected_billing_cadence:'annual',platform_fee_cents:1},
    membership_v2_sales_qualifications:{contract_id:ids.contract,contract_version:1,purchase_intent_id:ids.intent,rep_user_id:ids.rep,
      original_start_at:start,original_term_end_at:anchoredMonthInstant(start,months),commission_window_end_at:anchoredMonthInstant(start,12),
      qualification_closed_at:close},
    membership_v2_contracts:{id:ids.contract,contract_version:1,client_id:ids.client,agreement_id:ids.agreement,purchase_intent_id:null,
      original_salesperson_user_id:ids.rep,offer_snapshot:offer},
    membership_v2_initial_receipts:{contract_id:ids.contract,contract_version:1,paid_at:start},
    clients:{id:ids.client,billing_status:'active',subscription_status:'active'},
    sales_reps:{user_id:ids.rep,active:true},sales_commission_departures:null,sales_commission_statement_locks:null,
  };
}
function database(records,errors={}) {
  const reads=[],writes=[];
  return {reads,writes,async rpc(name) {
    assert.equal(name,'retail_existing_commission_source');
    reads.push({rpc:name});return {data:records.membership_v2_contracts?'retail_terms_v2':'legacy_receipt_v1',error:null};
  },from(table) {
    return {
      select(columns) {
        const filters=[];const query={eq(key,value){filters.push([key,value]);return query;},async maybeSingle(){
          reads.push({table,columns,filters});
          if (errors[table] === 'throw') throw Error('private transport details must not escape');
          if (errors[table]) return {data:null,error:{message:'private DB details must not escape'}};
          const raw=records[table];const rows=(raw==null?[]:Array.isArray(raw)?raw:[raw]).filter(row=>filters.every(([key,value])=>row[key]===value));
          return rows.length>1?{data:null,error:{code:'PGRST116'}}:{data:rows[0]||null,error:null};
        }};return query;
      },
      insert(row) {
        writes.push({table,row});
        return {select(){return {async single(){return {data:{id:'synthetic-receipt'},error:null};}};}};
      },
    };
  }};
}
function input(records,changes={}) {
  const offer=records.membership_v2_contracts?.offer_snapshot;
  return {purchase_intent_id:ids.intent,provider:'stripe',provider_payment_id:'pi_SyntheticRenewal',
    payment_kind:offer?.payment_option==='prepaid'?'paid_in_full':'monthly',
    payment_success_at:'2025-08-01T00:00:00Z',funds_received_at:'2025-08-03T00:00:00Z',
    gross_membership_cents:offer?.platform_payment_cents||29900,discount_cents:0,provider_fee_cents:101,
    evidence_reference:'synthetic manually reviewed provider receipt',...changes};
}
async function withServer(db,callback) {
  const app=express();app.use(express.json());
  // Only synthetic harness bypasses auth. Real admin/index.js mount retains both
  // requireAuth+requireAdmin, separately covered by the existing route test.
  app.use('/payroll',(req,_res,next)=>{req.user={id:ids.owner};next();},createAdminSalesPayrollRouter({db}));
  const server=await new Promise(resolve=>{const handle=app.listen(0,'127.0.0.1',()=>resolve(handle));});
  try { await callback(async body=>{
    const response=await fetch(`http://127.0.0.1:${server.address().port}/payroll/receipts`,{
      method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
    return {status:response.status,body:await response.json()};
  }); } finally {await new Promise(resolve=>server.close(resolve));}
}

test('terms loader uses trusted native legacy classification without querying retired contract tables',async()=>{
  const rows=fixture();rows.membership_v2_sales_qualifications=null;rows.membership_v2_contracts=null;
  const db=database(rows);assert.equal(await loadMembershipCommissionTerms(db,rows.public_purchase_intents),null);
  assert.deepEqual(db.reads,[{rpc:'retail_existing_commission_source'}]);assert.equal(db.writes.length,0);
});
test('terms loader uses accepted price and immutable original qualification, not mutable cadence/owner',async()=>{
  const rows=fixture(6,'prepaid');rows.public_purchase_intents.created_by_user_id=ids.otherRep;
  rows.public_purchase_intents.channel='self_service';rows.public_purchase_intents.activated_at='2025-10-01T00:00:00Z';
  rows.membership_v2_contracts.offer_snapshot={...rows.membership_v2_contracts.offer_snapshot,platform_payment_cents:196000,offer_version:'accepted-old-price'};
  const result=await loadMembershipCommissionTerms(database(rows),rows.public_purchase_intents);
  assert.equal(result.repUserId,ids.rep);assert.equal(result.qualificationClosedAt,close);
  assert.equal(result.platformPaymentCents,196000);assert.equal(result.paymentKind,'paid_in_full');
  assert.equal(result.policyInput.original_commitment_months,6);assert.equal(result.firstTermEndAt,'2025-07-31T14:20:30.000Z');
});
test('terms loader supports immutable purchase-intent source as well as agreement source',async()=>{
  const rows=fixture();rows.membership_v2_contracts.agreement_id=null;rows.membership_v2_contracts.purchase_intent_id=ids.intent;
  assert.equal((await loadMembershipCommissionTerms(database(rows),rows.public_purchase_intents)).ledgerFields.membership_contract_id,ids.contract);
});
test('missing qualification, migrations, ambiguity and raw read failures hold without writes',async()=>{
  const rows=fixture();rows.membership_v2_sales_qualifications=null;
  await assert.rejects(loadMembershipCommissionTerms(database(rows),rows.public_purchase_intents),{code:'membership_sales_qualification_required',status:409});
  rows.membership_v2_contracts=[rows.membership_v2_contracts,{...rows.membership_v2_contracts,id:ids.owner}];
  await assert.rejects(loadMembershipCommissionTerms(database(rows),rows.public_purchase_intents),{code:'membership_commission_read_failed',status:503});
  for (const state of [true,'throw']) {
    const db=database(fixture(),{membership_v2_sales_qualifications:state});
    await assert.rejects(loadMembershipCommissionTerms(db,fixture().public_purchase_intents),error=>error.code==='membership_commission_read_failed'
      && error.status===503 && !error.message.includes('private'));assert.equal(db.writes.length,0);
  }
});
test('bad immutable links, versions, original dates, currency and malformed amounts fail closed',async()=>{
  const mutations=[r=>r.membership_v2_sales_qualifications.purchase_intent_id=ids.owner,
    r=>r.membership_v2_sales_qualifications.rep_user_id=ids.otherRep,
    r=>r.membership_v2_sales_qualifications.contract_version=2,
    r=>r.membership_v2_contracts.client_id=ids.owner,
    r=>r.membership_v2_contracts.agreement_id=ids.owner,
    r=>r.membership_v2_contracts.purchase_intent_id=ids.intent,
    r=>r.membership_v2_contracts.offer_snapshot={...r.membership_v2_contracts.offer_snapshot,currency:'eur'},
    r=>r.membership_v2_contracts.offer_snapshot={...r.membership_v2_contracts.offer_snapshot,platform_payment_cents:'44900'},
    r=>r.membership_v2_initial_receipts.paid_at='2025-02-01T00:00:00Z',
    r=>r.membership_v2_initial_receipts.contract_version=2,
    r=>r.membership_v2_sales_qualifications.original_term_end_at='2026-01-31T14:20:30Z',
    r=>r.membership_v2_sales_qualifications.commission_window_end_at='2027-01-31T14:20:30Z',
    r=>r.membership_v2_sales_qualifications.qualification_closed_at='2025-05-01T00:00:00Z',
    r=>r.membership_v2_sales_qualifications.original_start_at='not-a-date',
  ];
  for (const change of mutations) {const rows=fixture();change(rows);
    await assert.rejects(loadMembershipCommissionTerms(database(rows),rows.public_purchase_intents));}
});
test('receipt API records all six commitment/payment variants with ORIGINAL trusted linkage',async()=>{
  for (const months of [3,6,12]) for (const payment of ['prepaid','monthly_installments']) {
    const rows=fixture(months,payment),db=database(rows);
    await withServer(db,async send=>{
      const result=await send(input(rows));assert.equal(result.status,201,JSON.stringify(result));
      assert.equal(db.writes.length,1);const saved=db.writes[0].row;
      assert.equal(saved.membership_terms_protocol,'retail_terms_v2');assert.equal(saved.membership_contract_id,ids.contract);
      assert.equal(saved.policy_version,'retail-terms-v2-commission-v1');assert.equal(saved.first_term_start_at,start);
      assert.equal(saved.first_term_end_at,anchoredMonthInstant(start,months));assert.equal(saved.qualification_closed_at,close);
      assert.equal(saved.rep_user_id,ids.rep);assert.equal(saved.gross_membership_cents,rows.membership_v2_contracts.offer_snapshot.platform_payment_cents);
    });
  }
});
test('browser attempts to override protocol, contract, window and original rep are ignored',async()=>{
  const rows=fixture(),db=database(rows);
  await withServer(db,async send=>{
    const result=await send(input(rows,{membership_terms_protocol:'legacy_receipt_v1',membership_contract_id:ids.owner,
      membership_contract_version:99,first_term_end_at:'2099-01-01T00:00:00Z',rep_user_id:ids.otherRep,
      original_membership_start_at:'2025-08-01T00:00:00Z',qualification_closed_at:'2025-08-01T00:00:00Z',
      original_commitment_months:12,policy_version:'forged-policy'}));
    assert.equal(result.status,201);const saved=db.writes[0].row;
    assert.equal(saved.membership_contract_id,ids.contract);assert.equal(saved.membership_contract_version,1);
    assert.equal(saved.first_term_end_at,'2025-04-30T14:20:30.000Z');assert.equal(saved.rep_user_id,ids.rep);
    assert.equal(saved.policy_version,'retail-terms-v2-commission-v1');assert.equal(saved.qualification_closed_at,close);
  });
});
test('receipt API excludes original anniversary, wrong kind/provider, first-role gross and unpaid client',async()=>{
  const rows=fixture(),db=database(rows);
  await withServer(db,async send=>{
    for (const [changes,error] of [
      [{payment_success_at:'2026-01-31T14:20:30Z',funds_received_at:'2026-02-01T00:00:00Z'},'outside_original_first_year'],
      [{payment_kind:'paid_in_full'},'payment_kind_billing_cadence_mismatch'],
      [{provider:'other_verified'},'payment_kind_billing_cadence_mismatch'],
      [{gross_membership_cents:44901},'gross_exceeds_contract_platform_fee'],
    ]) {const result=await send(input(rows,changes));assert.equal(result.status,422);assert.equal(result.body.error,error);}
    rows.clients.billing_status='past_due';const result=await send(input(rows));assert.equal(result.status,422);
    assert.equal(result.body.error,'client_not_active');assert.equal(db.writes.length,0);
  });
});
test('receipt API freezes original rep and close after reassignment instead of re-closing a renewal',async()=>{
  const rows=fixture(),db=database(rows);rows.public_purchase_intents.created_by_user_id=ids.otherRep;
  rows.public_purchase_intents.channel='self_service';rows.public_purchase_intents.activated_at='2025-08-01T00:00:00Z';
  await withServer(db,async send=>{
    assert.equal((await send(input(rows))).status,201);
    assert.equal(db.writes[0].row.rep_user_id,ids.rep);assert.equal(db.writes[0].row.qualification_closed_at,close);
    assert.deepEqual(db.reads.find(r=>r.table==='sales_reps').filters,[['user_id',ids.rep]]);
  });
});
test('unqualified v2 and missing migration cannot produce a legacy receipt through the API',async()=>{
  const rows=fixture();rows.membership_v2_sales_qualifications=null;const db=database(rows);
  await withServer(db,async send=>{
    const result=await send(input(rows));assert.equal(result.status,409);
    assert.equal(result.body.error,'membership_sales_qualification_required');assert.equal(db.writes.length,0);
  });
  const failing=database(fixture(),{membership_v2_sales_qualifications:true});
  await withServer(failing,async send=>{
    const result=await send(input(fixture()));assert.equal(result.status,503);
    assert.equal(result.body.error,'sales_payroll_unavailable');assert.equal(failing.writes.length,0);
  });
});
test('original rep departure and locked statements still block v2 receipt recording',async()=>{
  const rows=fixture(),db=database(rows);rows.sales_reps.active=false;
  rows.sales_commission_departures={rep_user_id:ids.rep,final_day:'2025-03-31'};
  await withServer(db,async send=>{
    let result=await send(input(rows));assert.equal(result.status,422);assert.equal(result.body.error,'after_departure_window');
    rows.sales_reps.active=true;rows.sales_commission_departures=null;
    // Return a lock for any looked-up week, as the immutable SQL guard also does.
    const from=db.from.bind(db);db.from=table=>table==='sales_commission_statement_locks'?{select(){const q={eq(){return q;},async maybeSingle(){return {data:{week_start:'synthetic'},error:null};}};return q;}}:from(table);
    result=await send(input(rows));assert.equal(result.status,409);assert.equal(result.body.error,'statement_week_locked');
    assert.equal(db.writes.length,0);
  });
});
