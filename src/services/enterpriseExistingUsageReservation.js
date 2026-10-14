'use strict';

// LOCAL/UNMOUNTED. Same allocation kernel, not a new billing engine. Native
// prepare/reserve own census and clocks. This module does not call a provider,
// refresh access, deliver mail, or authorize commissions. Server-calculated
// groups are trusted-server content, not SQL attestation of that calculation.
const { isDeepStrictEqual } = require('node:util');
const { snapshotStripeSdkData: snapshot } = require('./enterprisePoolPaymentProof');
const { verifyEnterpriseBillingReceipt } = require('./existingEnterpriseBillingReceipt');
const { allocateInterviewRows } = require('./interviewAllocation');
const { isUsedInterviewRow } = require('./roleInterviewAvailability');
const UUID = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const ARRAYS = ['clients','agreements','settings','roles','interviews','purchases','credits','pools','ledger','intents','customers','seals','history'];
const MAX_ROWS = 100000;
function hold() { throw Object.assign(new Error('enterprise_usage_reservation_held'), { code: 'enterprise_usage_reservation_held', status: 503 }); }
function check(value) { if (!value) hold(); }
const whole = value => Number.isSafeInteger(value) && value >= 0;
const instant = value => typeof value === 'string' && /(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value));
const sameInstant = (a,b) => instant(a) && instant(b) && Date.parse(a) === Date.parse(b);

function planEnterpriseExistingUsage(raw) {
  let s; try { s = snapshot(raw); } catch (_) { hold(); }
  check(s?.version === 'enterprise_existing_usage_snapshot_v1' && UUID.test(s.owner_id)
    && UUID.test(s.agreement_id) && instant(s.month_start) && instant(s.month_end) && instant(s.observed_at)
    && /^\d{4}-\d{2}-01T00:00:00\.000Z$/.test(s.month_start)
    && /^\d{4}-\d{2}-01T00:00:00\.000Z$/.test(s.month_end));
  const nextMonth = new Date(s.month_start); nextMonth.setUTCMonth(nextMonth.getUTCMonth()+1);
  check(nextMonth.toISOString() === s.month_end && Date.parse(s.month_end) <= Date.parse(s.observed_at));
  let size = 0;
  for (const name of ARRAYS) {
    check(Array.isArray(s[name])); size += s[name].length; check(size <= MAX_ROWS);
    const keys = new Set();
    for (const row of s[name]) {
      const key = name === 'settings' ? row?.client_id : name === 'seals' ? row?.agreement_id : row?.id;
      check(UUID.test(key || '') && !keys.has(key)); keys.add(key);
    }
  }
  const owner = s.clients.find(c => c.id === s.owner_id);
  check(owner && owner.parent_client_id === null && owner.archived_at === null && owner.plan_tier === 'enterprise');
  const family = new Set(s.clients.filter(c => c.id === s.owner_id || c.parent_client_id === s.owner_id).map(c => c.id));
  check(family.size === s.clients.length); // Recursive SQL census, unsupported nesting is a hold.
  const a = s.agreements.find(a => a.id === s.agreement_id);
  const markers = ['enterprise_checkout_source','enterprise_checkout_prices','enterprise_funding_receipt','enterprise_billing_receipt'];
  check(a && a.client_id === s.owner_id && a.status === 'signed' && a.is_current === true
    && a.checkout_status === 'paid' && a.superseded_by_agreement_id === null && a.voided_at === null
    && s.agreements.filter(row => row.client_id === s.owner_id && row.is_current === true).length === 1
    && s.agreements.filter(row => markers.some(key => row[key] != null)).length === 1);
  let receipt;
  try { receipt = verifyEnterpriseBillingReceipt(s.receipt, { source: a.enterprise_checkout_source,
    prices: a.enterprise_checkout_prices, fundingReceipt: a.enterprise_funding_receipt }); } catch (_) { hold(); }
  check(isDeepStrictEqual(snapshot(receipt), a.enterprise_billing_receipt));
  const accepted = receipt.plan_initial, initial = receipt.client_initial, proof = receipt.funding_receipt.proof;
  check(proof.client_id === s.owner_id && owner.stripe_customer_id === initial.stripe_customer_id
    && owner.stripe_subscription_id === initial.stripe_subscription_id
    && accepted.client_id === s.owner_id && accepted.billing_model === 'usage'
    && whole(accepted.included_interviews_per_role) && whole(accepted.usage_interview_fee_cents)
    && accepted.usage_interview_fee_cents > 0 && instant(initial.contract_start_at) && instant(initial.contract_end_at));
  const setting = s.settings.find(row => row.client_id === s.owner_id);
  check(setting && setting.plan_tier === 'enterprise' && setting.billing_model === accepted.billing_model
    && setting.included_interviews_per_role === accepted.included_interviews_per_role
    && setting.billing_interval === accepted.billing_interval);
  // Current fee edits do not reprice accepted service. Other allocation input
  // changes are rejected, not interpreted via a plan-tier/null fallback.
  check(s.pools.length === 1 && s.pools[0].id === proof.pool_id && s.pools[0].client_id === s.owner_id
    && s.pools[0].status === 'paid' && s.pools[0].quantity_purchased === proof.quantity
    && whole(s.pools[0].quantity_purchased) && s.pools[0].quantity_purchased > 0
    && sameInstant(s.pools[0].paid_at, proof.payment_success_at) && instant(s.pools[0].created_at));
  const roles = new Map(s.roles.map(row => [row.id,row]));
  check(s.roles.every(row => family.has(row.client_id) && typeof row.title === 'string' && typeof row.status === 'string'));
  for (const row of s.purchases) check(family.has(row.client_id) && roles.get(row.role_id)?.client_id === row.client_id
    && whole(row.quantity) && row.quantity > 0 && row.quantity <= 2147483647 && typeof row.status === 'string');
  const allowances = new Map(s.roles.map(row => [row.id, accepted.included_interviews_per_role]));
  for (const row of s.purchases.filter(row => row.status === 'paid')) {
    const total = allowances.get(row.role_id)+row.quantity; check(whole(total)); allowances.set(row.role_id,total);
  }
  for (const row of s.credits) check(family.has(row.client_id) && roles.get(row.source_role_id)?.client_id === row.client_id
    && whole(row.quantity) && instant(row.minted_at) && instant(row.expires_at)
    && Date.parse(row.expires_at) >= Date.parse(row.minted_at) && (row.revoked_at === null || instant(row.revoked_at)));
  const byInterview = new Map(s.interviews.map(row => [row.id,row]));
  for (const row of s.interviews) {
    check(family.has(row.client_id) && roles.get(row.role_id)?.client_id === row.client_id
      && typeof row.status === 'string' && (row.completed_at === null || instant(row.completed_at))
      && instant(row.updated_at) && (row.has_substantive_response === null || typeof row.has_substantive_response === 'boolean'));
    if (isUsedInterviewRow(row)) check(instant(row.completed_at)
      && Date.parse(row.completed_at) >= Date.parse(initial.contract_start_at)
      && Date.parse(row.completed_at) < Date.parse(initial.contract_end_at)
      && Date.parse(row.completed_at) <= Date.parse(s.observed_at));
  }
  for (const row of s.ledger) check(row.client_id === s.owner_id && byInterview.has(row.interview_id)
    && byInterview.get(row.interview_id).role_id === row.role_id && whole(row.unit_price_cents));
  const labels = new Map(s.clients.filter(c => c.id !== s.owner_id).map(c => [c.id,c.entity_label || c.name || null]));
  const allocation = allocateInterviewRows({ billingModel: accepted.billing_model,
    includedPerRole: accepted.included_interviews_per_role, usageInterviewFeeCents: accepted.usage_interview_fee_cents,
    asOfIso: new Date(s.observed_at).toISOString(), roleRows: s.roles, interviewRows: s.interviews,
    purchaseRows: s.purchases.filter(row => row.status === 'paid'), creditRows: s.credits,
    poolRows: s.pools, entityLabelById: labels });
  const entries = allocation.entries.filter(row => Date.parse(row.completed_at) < Date.parse(s.month_end));
  const prefix = entries.map(row => ({ interview_id: row.interview_id, role_id: row.role_id, client_id: row.client_id,
    completed_at: row.completed_at, source: row.source, source_id: row.source_id }));
  for (const old of s.history) {
    check(['reserved','no_usage'].includes(old.phase) && Array.isArray(old.prefix)
      && old.owner_id === s.owner_id && old.agreement_id === s.agreement_id);
    check(isDeepStrictEqual(old.prefix, snapshot(prefix.slice(0, old.prefix.length))));
  }
  const already = new Set(s.ledger.map(row => row.interview_id)), groups = new Map();
  for (const row of entries) {
    if (row.source !== 'usage' || Date.parse(row.completed_at) < Date.parse(s.month_start)) continue;
    check(!already.has(row.interview_id));
    const group = groups.get(row.role_id) || { role_id: row.role_id, unit_price_cents: accepted.usage_interview_fee_cents,
      quantity: 0, amount_cents: 0, interview_ids: [] };
    group.quantity++; group.amount_cents += accepted.usage_interview_fee_cents; group.interview_ids.push(row.interview_id);
    check(whole(group.amount_cents) && group.amount_cents <= 2147483647); groups.set(row.role_id, group);
  }
  const lines = [...groups.values()].sort((a,b) => a.role_id.localeCompare(b.role_id));
  const total = lines.reduce((n,line) => n+line.amount_cents,0); check(whole(total) && total <= 2147483647);
  return { groups: lines, prefix, total_cents: total, no_usage: lines.length === 0 };
}

async function prepareAndReserveEnterpriseExistingUsage({ db, billingClientId }) {
  check(UUID.test(billingClientId || ''));
  let prepared;
  try { prepared = snapshot(await db.rpc('prepare_enterprise_existing_usage', { p_owner: billingClientId })); } catch (_) { hold(); }
  check(prepared && !prepared.error && prepared.data?.phase === 'prepared'
    && UUID.test(prepared.data.batch_id) && whole(prepared.data.generation) && prepared.data.generation > 0
    && /^[a-f0-9]{64}$/.test(prepared.data.snapshot_digest || '') && prepared.data.snapshot?.owner_id === billingClientId);
  // No database/provider operation in the validated pure-kernel gap.
  const plan = planEnterpriseExistingUsage(prepared.data.snapshot);
  let reserved;
  try { reserved = snapshot(await db.rpc('reserve_enterprise_existing_usage', {
    p_batch: prepared.data.batch_id, p_generation: prepared.data.generation,
    p_digest: prepared.data.snapshot_digest, p_groups: plan.groups, p_prefix: plan.prefix
  })); } catch (_) { hold(); }
  check(reserved && !reserved.error && ['reserved','no_usage'].includes(reserved.data?.phase)
    && reserved.data.batch_id === prepared.data.batch_id && reserved.data.generation === prepared.data.generation
    && reserved.data.total_cents === plan.total_cents);
  return { phase: reserved.data.phase, batch_id: reserved.data.batch_id, total_cents: plan.total_cents,
    provider_effect_authorized: false, paid_access_authorized: false, payroll_authorized: false };
}
module.exports = { planEnterpriseExistingUsage, prepareAndReserveEnterpriseExistingUsage };
