'use strict';

const { formatInTimeZone } = require('date-fns-tz');

const TIMEZONE = 'America/Denver';

function integer(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw new Error(`invalid_report_${label}`);
  return number;
}

function localDate(value) {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new Error('invalid_report_event_date');
  return formatInTimeZone(parsed, TIMEZONE, 'yyyy-MM-dd');
}

function emptyTotals() {
  return { sale_count: 0, gross_sales_cents: 0, adjustment_cents: 0, net_revenue_cents: 0, commission_cents: 0 };
}

function addEvent(representative, event) {
  representative.events.push(event);
  representative.gross_sales_cents += event.gross_sales_cents;
  representative.adjustment_cents += event.adjustment_cents;
  representative.net_revenue_cents += event.net_revenue_cents;
  representative.commission_cents += event.commission_cents;
  if (![representative.gross_sales_cents, representative.adjustment_cents, representative.net_revenue_cents,
    representative.commission_cents].every(Number.isSafeInteger)) throw new Error('report_amount_out_of_range');
}

function buildSalesPayrollReport({ dateFrom, dateTo, representatives, receipts, adjustments, linkedReceipts, intents, qualifications = [], existingQualifications = [], generatedAt = new Date().toISOString() }) {
  const reps = representatives.map((row) => ({
    user_id: row.user_id, display_name: String(row.display_name || '').trim(), email: String(row.email || '').trim(),
    ...emptyTotals(), events: [],
  }));
  const repById = new Map(reps.map((row) => [row.user_id, row]));
  const receiptsById = new Map([...linkedReceipts, ...receipts].map((row) => [row.id, row]));
  const intentById = new Map(intents.map((row) => [row.id, row]));
  const qualificationByContract = new Map();
  for (const row of qualifications) {
    if (!row.contract_id || qualificationByContract.has(row.contract_id)) throw new Error('report_invalid_membership_qualification');
    qualificationByContract.set(row.contract_id,row);
  }
  const salesByRep = new Map(reps.map((row) => [row.user_id, new Set()]));
  const existingByIntent=new Map();
  for(const row of existingQualifications){
    if(!row.purchase_intent_id || existingByIntent.has(row.purchase_intent_id)) throw new Error('report_invalid_membership_qualification');
    existingByIntent.set(row.purchase_intent_id,row);
  }

  function context(receipt) {
    if (!receipt) throw new Error('report_missing_receipt');
    const representative = repById.get(receipt.rep_user_id);
    const intent = intentById.get(receipt.purchase_intent_id);
    const protocol=receipt.membership_terms_protocol;
    if (protocol != null && !['legacy_receipt_v1','retail_terms_v2','retail_existing_terms_v2','enterprise_existing_terms_v1'].includes(protocol)) throw new Error('report_invalid_membership_protocol');
    if (protocol==='enterprise_existing_terms_v1') {
      // Native insertion froze this qualification; never join a current owner
      // or current agreement to re-attribute historical refunds and payouts.
      const q=receipt.enterprise_commission_source;
      if(!representative || receipt.purchase_intent_id!==null || receipt.membership_contract_id!=null || receipt.membership_contract_version!=null
        || receipt.sales_qualification_id!=null || !q || q.version!=='enterprise_existing_commission_qualification_v1'
        || q.agreement_id!==receipt.enterprise_agreement_id || q.rep_user_id!==receipt.rep_user_id
        || q.original_rep_attested!==true || q.payroll_authorized!==false
        || typeof q.client_legal_name!=='string' || !q.client_legal_name.trim()
        || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(q.agreement_id||'')) throw new Error('report_missing_sales_attribution');
      return{representative,client:q.client_legal_name,dealKey:`agreement:${q.agreement_id}`};
    }
    const q=qualificationByContract.get(receipt.membership_contract_id);
    const existing=existingByIntent.get(receipt.sales_qualification_id);
    const attributed=protocol==='retail_terms_v2'
      ? q && Number.isSafeInteger(receipt.membership_contract_version) && receipt.membership_contract_version>0
        && q.contract_version===receipt.membership_contract_version && q.purchase_intent_id===receipt.purchase_intent_id && q.rep_user_id===receipt.rep_user_id
      : protocol==='retail_existing_terms_v2'
        ? existing && existing.purchase_intent_id===receipt.purchase_intent_id && existing.rep_user_id===receipt.rep_user_id
          && receipt.membership_contract_id==null && receipt.membership_contract_version==null
        : intent && intent.created_by_user_id===receipt.rep_user_id && intent.channel==='sales_assisted';
    if (!representative || !intent || !attributed) {
      throw new Error('report_missing_sales_attribution');
    }
    const client = String(intent.company_legal_name || intent.buyer_email || '').trim();
    if (!client) throw new Error('report_missing_client_name');
    return { representative, client, dealKey:receipt.purchase_intent_id };
  }

  for (const receipt of receipts) {
    const { representative, client, dealKey } = context(receipt);
    const gross = integer(receipt.gross_membership_cents, 'gross');
    const discount = integer(receipt.discount_cents, 'discount');
    const fee = integer(receipt.provider_fee_cents, 'provider_fee');
    const net = integer(receipt.net_membership_cents, 'net');
    const commission = integer(receipt.commission_cents, 'commission');
    if (gross <= 0 || discount < 0 || fee < 0 || gross - discount - fee !== net) throw new Error('report_receipt_reconciliation_failed');
    addEvent(representative, {
      id: `receipt:${receipt.id}`, date: localDate(receipt.funds_received_at), client_name: client,
      activity: receipt.membership_terms_protocol==='enterprise_existing_terms_v1'
        ? (receipt.payment_kind==='monthly'?'Enterprise monthly platform payment':'Enterprise annual platform payment')
        : ['retail_terms_v2','retail_existing_terms_v2'].includes(receipt.membership_terms_protocol)
        ? (receipt.payment_kind==='monthly'?'Monthly installment':'Prepaid membership payment')
        : receipt.payment_kind === 'monthly' ? 'Monthly payment' : receipt.payment_kind === 'financed_checkout' ? 'Financed payment' : 'Annual payment',
      gross_sales_cents: gross, adjustment_cents: -discount - fee, net_revenue_cents: net,
      commission_cents: commission, purchase_intent_id: receipt.purchase_intent_id, receipt_id: receipt.id,
      ...(receipt.membership_terms_protocol==='enterprise_existing_terms_v1'?{enterprise_agreement_id:receipt.enterprise_agreement_id}:{}),
    });
    salesByRep.get(representative.user_id).add(dealKey);
  }

  for (const adjustment of adjustments) {
    const receipt = receiptsById.get(adjustment.receipt_id);
    const { representative, client } = context(receipt);
    const delta = integer(adjustment.net_membership_delta_cents, 'adjustment');
    const commission = integer(adjustment.commission_delta_cents, 'commission_adjustment');
    if (delta === 0) throw new Error('report_zero_adjustment');
    addEvent(representative, {
      id: `adjustment:${adjustment.id}`, date: localDate(adjustment.effective_at), client_name: client,
      activity: adjustment.adjustment_type === 'refund' ? 'Refund' : adjustment.adjustment_type === 'chargeback' ? 'Chargeback' : 'Recovery',
      gross_sales_cents: 0, adjustment_cents: delta, net_revenue_cents: delta,
      commission_cents: commission, purchase_intent_id: receipt.purchase_intent_id, receipt_id: receipt.id,
      ...(receipt.membership_terms_protocol==='enterprise_existing_terms_v1'?{enterprise_agreement_id:receipt.enterprise_agreement_id}:{}),
    });
  }

  const totals = emptyTotals();
  for (const representative of reps) {
    representative.sale_count = salesByRep.get(representative.user_id).size;
    representative.events.sort((a, b) => b.date.localeCompare(a.date) || a.client_name.localeCompare(b.client_name) || a.id.localeCompare(b.id));
    for (const field of Object.keys(totals)) totals[field] += representative[field];
  }
  if (!Object.values(totals).every(Number.isSafeInteger) || totals.gross_sales_cents + totals.adjustment_cents !== totals.net_revenue_cents) {
    throw new Error('report_total_reconciliation_failed');
  }
  reps.sort((a, b) => (a.display_name || a.email).localeCompare(b.display_name || b.email));
  return { date_from: dateFrom, date_to: dateTo, timezone: TIMEZONE, generated_at: generatedAt,
    basis: 'reviewed membership payments by funds-received date; linked adjustments by effective date',
    totals, representatives: reps };
}

module.exports = { buildSalesPayrollReport, localDate };
