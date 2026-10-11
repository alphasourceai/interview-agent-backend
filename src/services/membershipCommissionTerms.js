'use strict';

// Admin-reviewed receipts only. Resolve policy/linkage from immutable server
// records. Missing migrations or qualification hold, never fall back to legacy.
const { anchoredMonthInstant } = require('./membershipOffers');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function fail(code,status=422) { throw Object.assign(new Error(code),{code,status}); }
function canonical(value) {
  if (typeof value !== 'string' || !/(?:Z|[+-]\d{2}:\d{2})$/i.test(value)) fail('invalid_membership_commission_snapshot');
  const time=new Date(value);
  if (!Number.isFinite(time.getTime())) fail('invalid_membership_commission_snapshot');
  return time.toISOString();
}
async function read(db,table,columns,key,id,version=null) {
  let result;
  try {
    const query=db.from(table).select(columns).eq(key,id);
    result=await (version==null?query:query.eq('contract_version',version)).maybeSingle();
  }
  catch { fail('membership_commission_read_failed',503); }
  if (!result || result.error) fail('membership_commission_read_failed',503);
  if (result.data == null) return null;
  if (typeof result.data !== 'object' || Array.isArray(result.data)) fail('membership_commission_read_failed',503);
  return result.data;
}

async function loadMembershipCommissionTerms(db,intent) {
  if (!UUID.test(intent?.id || '') || !UUID.test(intent?.agreement_id || '') || !UUID.test(intent?.client_id || '')) {
    fail('unverified_qualifying_sale');
  }
  const q=await read(db,'membership_v2_sales_qualifications',
    'contract_id,contract_version,purchase_intent_id,rep_user_id,original_start_at,original_term_end_at,commission_window_end_at,qualification_closed_at',
    'purchase_intent_id',intent.id);
  if (!q) {
    // Check both permitted source types; do not let an unqualified prospective
    // agreement use a legacy first-term window. maybeSingle holds ambiguity.
    const [byIntent,byAgreement]=await Promise.all([
      read(db,'membership_v2_contracts','id','purchase_intent_id',intent.id),
      read(db,'membership_v2_contracts','id','agreement_id',intent.agreement_id),
    ]);
    if (byIntent || byAgreement) fail('membership_sales_qualification_required',409);
    return null;
  }
  if (q.purchase_intent_id !== intent.id || !UUID.test(q.contract_id || '') || !UUID.test(q.rep_user_id || '')
    || !Number.isSafeInteger(q.contract_version) || q.contract_version <= 0) fail('invalid_membership_commission_snapshot');
  const contract=await read(db,'membership_v2_contracts',
    'id,contract_version,client_id,agreement_id,purchase_intent_id,original_salesperson_user_id,offer_snapshot', 'id',q.contract_id,q.contract_version);
  const initial=await read(db,'membership_v2_initial_receipts','contract_id,contract_version,paid_at','contract_id',q.contract_id,q.contract_version);
  const offer=contract?.offer_snapshot;
  if (!contract || !initial || contract.id !== q.contract_id || initial.contract_id !== q.contract_id
    || contract.contract_version !== q.contract_version || initial.contract_version !== q.contract_version
    || contract.client_id !== intent.client_id || contract.original_salesperson_user_id !== q.rep_user_id
    || ((contract.agreement_id != null) === (contract.purchase_intent_id != null))
    || (contract.agreement_id != null && contract.agreement_id !== intent.agreement_id)
    || (contract.purchase_intent_id != null && contract.purchase_intent_id !== intent.id)
    || !offer || offer.schema_version !== 2 || offer.currency !== 'usd'
    || offer.term_start_basis !== 'first_payment_success' || offer.contract_timezone !== 'UTC'
    || ![3,6,12].includes(offer.commitment_months)
    || !['prepaid','monthly_installments'].includes(offer.payment_option)
    || !Number.isSafeInteger(offer.platform_payment_cents) || offer.platform_payment_cents <= 0) {
    fail('invalid_membership_commission_snapshot');
  }
  const original=canonical(q.original_start_at), end=canonical(q.original_term_end_at), close=canonical(q.qualification_closed_at);
  if (original !== canonical(initial.paid_at) || end !== anchoredMonthInstant(original,offer.commitment_months)
    || canonical(q.commission_window_end_at) !== anchoredMonthInstant(original,12)
    || Date.parse(close) < Date.parse(original) || Date.parse(close) >= Date.parse(end)) fail('invalid_membership_commission_snapshot');
  return {
    repUserId:q.rep_user_id,
    paymentKind:offer.payment_option === 'prepaid' ? 'paid_in_full' : 'monthly',
    platformPaymentCents:offer.platform_payment_cents,
    qualificationClosedAt:close,firstTermStartAt:original,firstTermEndAt:end,
    policyInput:{membership_terms_protocol:'retail_terms_v2',original_membership_start_at:original,
      original_commitment_months:offer.commitment_months,original_salesperson_user_id:q.rep_user_id,
      sales_rep_user_id:q.rep_user_id,original_qualification_closed_at:close,original_qualification_verified:true},
    ledgerFields:{membership_terms_protocol:'retail_terms_v2',membership_contract_id:contract.id,
      membership_contract_version:contract.contract_version,policy_version:'retail-terms-v2-commission-v1'},
  };
}
module.exports={loadMembershipCommissionTerms};
