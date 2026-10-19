'use strict';

// Existing receipts remain immutable. This policy controls NEW approvals only.
function fail(code, status = 503) { throw Object.assign(new Error(code), { code, status }); }
function validatePolicy(value) {
  if (!value || typeof value.enabled !== 'boolean' || !Number.isSafeInteger(value.version) || value.version < 0)
    fail('renewal_commission_policy_unavailable');
  return { enabled: value.enabled, version: value.version, changed_at: value.changed_at || null };
}
async function readRenewalCommissionPolicy(db) {
  let result;
  try {
    result = await db.from('sales_renewal_commission_policy_events')
      .select('version,enabled,changed_at').order('version', { ascending: false }).limit(1).maybeSingle();
  } catch (_) { fail('renewal_commission_policy_unavailable'); }
  if (!result || result.error) fail('renewal_commission_policy_unavailable');
  return result.data == null ? { enabled: false, version: 0, changed_at: null } : validatePolicy(result.data);
}
async function setRenewalCommissionPolicy(db, body, actor) {
  if (!body || Object.keys(body).some(key => !['enabled', 'confirmed', 'expected_version'].includes(key))
    || typeof body.enabled !== 'boolean' || body.confirmed !== true
    || !Number.isSafeInteger(body.expected_version) || body.expected_version < 0)
    fail('invalid_renewal_commission_confirmation', 422);
  const result = await db.rpc('set_sales_renewal_commissions', {
    p_enabled: body.enabled, p_expected_version: body.expected_version, p_actor: actor,
  });
  if (result?.error) {
    if (result.error.code === 'P0001' && result.error.message === 'renewal_commission_policy_changed')
      fail('renewal_commission_policy_changed_refresh_before_confirming', 409);
    fail('renewal_commission_policy_unavailable');
  }
  return validatePolicy(result?.data);
}
module.exports = { readRenewalCommissionPolicy, setRenewalCommissionPolicy };
