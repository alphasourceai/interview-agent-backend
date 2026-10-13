'use strict';
// Synthetic SDK funding plus strict actual receipt verifier, never provider cash.
const fundingFixture=require('./enterprise-existing-funding-fixture');
const {createFakeSupabase}=require('./fakeSupabase');
const {readExistingEnterpriseCheckoutFunding}=require('../../src/services/existingEnterpriseCheckoutFunding');
const {verifyEnterpriseBillingReceipt}=require('../../src/services/existingEnterpriseBillingReceipt');
const keys=require('../../src/services/enterpriseExistingFundingKeys');
module.exports=async function fixture(options={}) {
  const f=fundingFixture(options),v=f.a.template_snapshot.values;
  Object.assign(v,{term_start_basis:'successful_payment',initial_term_start:'',initial_renewal_date:''});
  const {execution,...unsigned}=f.a.template_snapshot;
  f.seal.source_snapshot=structuredClone(unsigned);
  Object.assign(f.a.enterprise_checkout_source.material,{template_snapshot:structuredClone(f.a.template_snapshot),execution_seal:structuredClone(f.seal)});
  Object.assign(f.p.subscription,{current_period_end:Date.parse('2026-11-01T00:00:00Z')/1000,cancel_at_period_end:false});
  f.db.rpc=async name=>{if(name!=='read_enterprise_existing_billing')throw Error('unexpected synthetic write');return{data:null,error:null};};
  const funding=await readExistingEnterpriseCheckoutFunding(f.args);
  const proof=Object.fromEntries(keys.map(k=>[k,funding[k]]));
  const nativeFunding={version:'enterprise_existing_funding_v1',proof,recorded_at:'2026-10-13T12:00:00.123456Z'};
  const initial={stripe_customer_id:proof.customer_id,stripe_subscription_id:proof.subscription_id,
    subscription_status:'active',billing_status:'active',billing_interval:f.a.billing_option,plan_tier:'enterprise',
    current_term_end:'2026-11-01T00:00:00.000000Z',cancel_at_term_end:false,auto_renew:true,cancel_effective_at:null,
    contract_start_at:'2026-10-01T13:00:00.000000Z',contract_end_at:'2027-10-01T13:00:00.000000Z'};
  const plan={client_id:f.client.id,plan_tier:'enterprise',billing_interval:f.a.billing_option,platform_fee:999.99,
    per_role_fee:0,included_interviews_per_role:0,additional_interview_fee:0,max_interview_minutes:20,scored_question_count:5,
    billing_model:'usage',usage_interview_fee_cents:2500};
  const w={version:'enterprise_existing_billing_v1',funding_receipt:nativeFunding,
    subscription:{id:proof.subscription_id,customer:proof.customer_id,status:'active',current_period_end:f.p.subscription.current_period_end,
      cancel_at_period_end:false},client_initial:initial,plan_initial:plan,applied_at:'2026-10-13T12:00:00.123457Z'};
  Object.assign(f.a,{enterprise_funding_receipt:nativeFunding,enterprise_billing_receipt:w,checkout_status:'paid',checkout_paid_at:proof.payment_success_at});
  verifyEnterpriseBillingReceipt(w,{source:f.a.enterprise_checkout_source,prices:f.a.enterprise_checkout_prices,fundingReceipt:nativeFunding});
  Object.assign(f.client,initial);
  const livePlan=structuredClone(plan);
  const db=createFakeSupabase({clients:[f.client],membership_agreements:[f.a],client_plan_settings:[livePlan],usage_billing_ledger:[],
    roles:[],interviews:[],client_interview_pools:[]});
  db.rpc=async(name,p)=>{if(name!=='read_enterprise_existing_billing'||p.p_agreement!==f.a.id)throw Error('unexpected synthetic RPC');
    return {data:structuredClone(f.a.enterprise_billing_receipt),error:null};};
  const role={id:'synthetic_role',client_id:f.client.id,title:'Synthetic Role'},entry={interview_id:'synthetic_iv',role_id:role.id,
    client_id:f.client.id,source:'usage',source_id:null,completed_at:'2026-10-02T12:00:00Z'};
  const allocation={billing_model:'usage',included_per_role:0,allowance_by_role:new Map([[role.id,0]]),
    usage_interview_fee_cents:9999,roles:[role],entries:[entry],entity_label_by_client:new Map()};
  return{db,a:f.a,client:f.client,w,plan:livePlan,allocation,entry,role};
};
