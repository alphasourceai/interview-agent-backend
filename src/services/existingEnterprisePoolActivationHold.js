'use strict';

// Temporary prospective-cohort hold, NOT payment proof or credit settlement.
// Only the freshly read native agreement is authority. Until the existing-path
// trusted payment/receipt adapter is reviewed, no caller flag can bypass this.
function enterprisePoolProofRequired() {
  const error = new Error('enterprise_pool_payment_proof_required');
  error.code = error.message;
  error.status = 503;
  return error;
}

function assertExistingEnterprisePoolActivationAvailable(agreement) {
  const values = agreement?.template_snapshot?.values;
  if (values?.pool_offer_snapshot != null || values?.pool_offer_digest != null) {
    throw enterprisePoolProofRequired();
  }
}

async function assertExistingEnterprisePoolActivationAvailableFromDb(db, agreementId) {
  let result;
  try {
    result = await db.from('membership_agreements').select('id,template_snapshot')
      .eq('id', agreementId).maybeSingle();
  } catch (_) {
    const error = new Error('enterprise_pool_source_unavailable');
    error.code = error.message; error.status = 503; throw error;
  }
  if (!result || result.error) {
    const error = new Error('enterprise_pool_source_unavailable');
    error.code = error.message; error.status = 503; throw error;
  }
  assertExistingEnterprisePoolActivationAvailable(result.data);
}

module.exports = { enterprisePoolProofRequired, assertExistingEnterprisePoolActivationAvailable,
  assertExistingEnterprisePoolActivationAvailableFromDb };
