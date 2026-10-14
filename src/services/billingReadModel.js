'use strict';

// What a dashboard is told about a client's billing.
//
// Everything here is derived at read time from the allocation — the same
// function the invoice is built from — so a client's screen and their bill can
// never disagree. Nothing in this file writes, and nothing reads a stored
// counter: a balance is what is left after replaying the interviews that have
// been run.
//
// The one thing that does not come from the allocation is billed history. That
// comes from the usage ledger, because it is the record of what was actually
// charged, at the price it was charged at, and it must not move afterwards.
//
// COST: one allocation per call, which walks the payer's used interviews. See
// the note at the top of interviewAllocation.js.

const { allocateInterviews } = require('./interviewAllocation');
const { resolveBillingOwnerForScope } = require('./clientBillingScope');
const {loadAcceptedEnterpriseUsageTerms,hold}=require('./acceptedEnterpriseUsageTerms');
const {readAllPages}=require('./enterpriseUsageOwnerCensus');
const {snapshotEnterpriseUsageCensusData:snapshot}=require('./enterprisePoolPaymentProof');
const {
  ALL_UNBILLED_WINDOW,
  USAGE_BILLING_MODEL,
  computeUnbilledUsage,
  listBilledUsageInvoices
} = require('./usageBilling');

function toIso(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

/**
 * The credits this client can still spend, soonest to expire first.
 *
 * A credit's remaining count is its quantity less the interviews the allocation
 * charged to it. Revoked credits and credits that have expired by `asOf` are
 * left out: they are not spendable, which is what this list is for.
 */
function creditsFromAllocation(allocation, { asOf } = {}) {
  const asOfIso = toIso(asOf) || new Date().toISOString();
  const items = [];
  for (const credit of (allocation?.credits || [])) {
    if (toIso(credit.revoked_at)) continue;
    const expiresAt = toIso(credit.expires_at);
    if (expiresAt && asOfIso >= expiresAt) continue;
    const remaining = Math.max(0, Number(credit.quantity || 0) - Number(credit.allocated || 0));
    if (remaining <= 0) continue;
    items.push({
      id: credit.id,
      client_id: credit.client_id,
      source_role_id: credit.source_role_id,
      quantity: Number(credit.quantity || 0),
      remaining,
      minted_at: credit.minted_at || null,
      expires_at: credit.expires_at || null
    });
  }
  items.sort((left, right) => {
    const leftAt = toIso(left.expires_at) || '';
    const rightAt = toIso(right.expires_at) || '';
    if (leftAt !== rightAt) return leftAt < rightAt ? -1 : 1;
    return String(left.id) < String(right.id) ? -1 : 1;
  });
  return { items, total_remaining: items.reduce((sum, item) => sum + item.remaining, 0) };
}

/**
 * The Enterprise interview pool: what was bought, what has been run against it,
 * and what is left. Pools belong to the payer and are shared with its child
 * entities, so this is a family-wide figure.
 */
function poolFromAllocation(allocation) {
  const items = (allocation?.pools || []).map((pool) => ({
    id: pool.id,
    quantity_purchased: Number(pool.quantity_purchased || 0),
    used: Number(pool.allocated || 0),
    remaining: Math.max(0, Number(pool.quantity_purchased || 0) - Number(pool.allocated || 0)),
    paid_at: pool.paid_at || null,
    created_at: pool.created_at || null
  }));
  return {
    items,
    purchased: items.reduce((sum, item) => sum + item.quantity_purchased, 0),
    used: items.reduce((sum, item) => sum + item.used, 0),
    remaining: items.reduce((sum, item) => sum + item.remaining, 0)
  };
}

/** Per-role counts, in the shape the dashboards already use. */
function rolesFromAllocation(allocation) {
  return (allocation?.roles || []).map((role) => {
    const counters = allocation.by_role.get(String(role.id)) || {};
    const allowance = allocation.allowance_by_role.get(String(role.id)) ?? allocation.included_per_role;
    return {
      role_id: String(role.id),
      client_id: role.client_id || null,
      title: role.title || null,
      status: role.status || null,
      allowance,
      used: Number(counters.used || 0),
      own: Number(counters.own || 0),
      credit: Number(counters.credit || 0),
      pool: Number(counters.pool || 0),
      usage: Number(counters.usage || 0),
      own_remaining: Number(counters.own_remaining || 0)
    };
  });
}

function usageHistoryFromBatches(raw,accepted) {
  let batches;try{batches=snapshot(raw);}catch(_){hold();}
  if(!Array.isArray(batches))hold();
  const result=[],seen=new Set();
  const whole=n=>Number.isSafeInteger(n)&&n>=0&&n<=2147483647;
  for(const b of batches){
    if(!b||typeof b.id!=='string'||!b.id||seen.has(b.id)||b.owner_id!==accepted.billingClientId||b.agreement_id!==accepted.agreementId
      ||b.phase!=='reserved'||b.unit_price_cents!==accepted.unitPriceCents||!Array.isArray(b.groups)
      ||!b.groups.length||typeof b.service_month!=='string'||!/^\d{4}-\d{2}-01$/.test(b.service_month))hold();
    seen.add(b.id);let interviews=0,amount=0;const roles=new Set();
    for(const g of b.groups){
      if(typeof g.role_id!=='string'||roles.has(g.role_id)||!whole(g.quantity)||g.quantity<1
       ||g.unit_price_cents!==b.unit_price_cents||!whole(g.amount_cents)
       ||g.amount_cents!==g.quantity*g.unit_price_cents||!Array.isArray(g.interview_ids)
       ||new Set(g.interview_ids).size!==g.quantity||g.interview_ids.length!==g.quantity)hold();
      roles.add(g.role_id);interviews+=g.quantity;amount+=g.amount_cents;
    }
    if(!whole(interviews)||!whole(amount))hold();
    const leaf=b.provider_operation,final=leaf?.operations?.finalize?.proof,paid=leaf?.operations?.pay?.proof;
    const finalized=final?.stage==='finalized'&&final.total_cents===amount&&final.invoice_id===leaf.invoice_id;
    const collected=leaf?.status==='paid'&&finalized&&paid?.invoice_id===leaf.invoice_id&&paid.amount_cents===amount
      &&typeof paid.payment_intent_id==='string'&&/^pi_[A-Za-z0-9_]+$/.test(paid.payment_intent_id)
      &&typeof paid.charge_id==='string'&&/^ch_[A-Za-z0-9_]+$/.test(paid.charge_id)
      &&Number.isSafeInteger(paid.paid_at)&&paid.paid_at>0&&paid.paid_at<=253402300799;
    if(leaf?.status==='paid'&&!collected)hold();
    if(finalized&&(typeof leaf.invoice_id!=='string'||!/^in_[A-Za-z0-9_]+$/.test(leaf.invoice_id)))hold();
    const start=new Date(b.service_month+'T00:00:00.000Z'),end=new Date(start);end.setUTCMonth(end.getUTCMonth()+1);
    if(!Number.isFinite(start.getTime())||start.toISOString().slice(0,10)!==b.service_month)hold();
    result.push({batch_id:b.id,stripe_invoice_id:finalized?leaf.invoice_id:null,interviews,amount_cents:amount,
      period_start:start.toISOString(),period_end:end.toISOString(),billed_at:null,
      billing_status:collected?'paid':finalized?'invoiced_open':'reserved',
      paid_at:collected?new Date(paid.paid_at*1000).toISOString():null});
  }
  return result;
}

/**
 * Everything the billing read surfaces answer with, for one client.
 *
 * `clientId` may be a child entity: billing rolls up to the payer, so the
 * allocation, the pool and the usage are the payer's. Credits are the exception
 * and stay with the client that earned them, which is why they are filtered to
 * the client asked about.
 */
async function readBillingForClient({ db, clientId, asOf, invoiceLimit = 12 } = {}) {
  if (!db || !clientId) return { ok: false, reason: 'invalid_request' };

  const scope = await resolveBillingOwnerForScope(db, clientId);
  if (!scope.ok) return { ok: false, reason: scope.reason || 'billing_owner_lookup_failed', scope };
  const billingClientId = scope.billingClientId || String(clientId);

  const allocation = await allocateInterviews({ db, billingClientId, asOf });

  const allCredits = creditsFromAllocation(allocation, { asOf });
  const mine = allCredits.items.filter((item) => String(item.client_id) === String(clientId));

  const isUsage = allocation.billing_model === USAGE_BILLING_MODEL;
  // Marker detection cannot be bypassed by a later billing-model edit.
  const usage = await computeUnbilledUsage({ db, clientId: billingClientId, asOf, allocation, window: ALL_UNBILLED_WINDOW });
  let billedInvoices = isUsage
    ? await listBilledUsageInvoices({ db, clientId: billingClientId, limit: invoiceLimit })
    : [];
  const accepted=isUsage?await loadAcceptedEnterpriseUsageTerms({db,clientId:billingClientId}):null;
  if(accepted){
    const read=await readAllPages(()=>db.from('enterprise_existing_usage_batches')
      .select('id,owner_id,agreement_id,service_month,phase,unit_price_cents,groups,provider_operation',{count:'exact'})
      .eq('owner_id',billingClientId).eq('phase','reserved').order('id',{ascending:true}));
    if(read.error)hold();
    const nativeHistory=usageHistoryFromBatches(read.rows,accepted);
    const byInvoice=new Map(billedInvoices.map(i=>[i.stripe_invoice_id,i]));
    for(const i of nativeHistory){
      const old=i.stripe_invoice_id?byInvoice.get(i.stripe_invoice_id):null;
      if(old){if(old.amount_cents!==i.amount_cents||old.interviews!==i.interviews)hold();i.billed_at=old.billed_at;
        byInvoice.delete(i.stripe_invoice_id);}
    }
    billedInvoices=[...nativeHistory,...byInvoice.values()]
      .sort((a,b)=>String(b.period_start||b.billed_at||'').localeCompare(String(a.period_start||a.billed_at||'')))
      .slice(0,invoiceLimit);
  }

  return {
    ok: true,
    client_id: String(clientId),
    billing_client_id: billingClientId,
    billing_model: allocation.billing_model,
    allocation,
    credits: { items: mine, total_remaining: mine.reduce((sum, item) => sum + item.remaining, 0) },
    pool: poolFromAllocation(allocation),
    roles: rolesFromAllocation(allocation),
    unbilled_usage: {
      lines: usage.lines,
      total_cents: usage.total_cents,
      billable: usage.lines.length > 0
    },
    billed_usage: { invoices: billedInvoices }
  };
}

module.exports = {
  creditsFromAllocation,
  poolFromAllocation,
  readBillingForClient,
  rolesFromAllocation,
  usageHistoryFromBatches
};
