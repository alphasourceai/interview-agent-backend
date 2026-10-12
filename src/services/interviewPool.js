'use strict';

// The Enterprise interview pool.
//
// An Enterprise client buys a block of interviews at signup, and every role
// under that client or any of its child entities draws from the same pool. The
// pool belongs to whoever pays, so a child's interview spends the parent's pool
// — the same direction usage billing rolls.
//
// Running out never blocks anyone: once the pool is empty an interview is simply
// metered at the client's usage price instead.
//
// Nothing here spends a pool. What is left of one is worked out at read time by
// interviewAllocation from the interviews that have been run, so this file only
// records that a pool was bought and whether it was paid for.

const PAID_STATUS = 'paid';

function nowIso(now) {
  if (!now) return new Date().toISOString();
  const date = now instanceof Date ? now : new Date(now);
  return Number.isFinite(date.getTime()) ? date.toISOString() : new Date().toISOString();
}

/**
 * Marks a pool paid once its checkout settles, which is what makes it
 * spendable. How much of it is left is not stored: the allocation works that
 * out by replaying the interviews run against it.
 */
async function markPoolPaid({ db, poolId, stripePaymentIntentId, now } = {}) {
  if (!db || !poolId) return { paid: false, reason: 'invalid_request' };

  const { data: pool, error: lookupError } = await db
    .from('client_interview_pools')
    .select('id,client_id,quantity_purchased,status,offer_snapshot,offer_digest')
    .eq('id', poolId)
    .maybeSingle();
  if (lookupError) throw new Error(lookupError.message || 'Interview pool lookup failed');
  if (!pool) return { paid: false, reason: 'not_found' };
  if(pool.offer_snapshot!==null || pool.offer_digest!==null)throw new Error('ENTERPRISE_POOL_V2_PAYMENT_PROOF_REQUIRED');
  if (String(pool.status) === PAID_STATUS) return { paid: false, reason: 'already_paid', pool };

  const paidAt = nowIso(now);
  const { data: updated, error: updateError } = await db
    .from('client_interview_pools')
    .update({
      status: PAID_STATUS,
      stripe_payment_intent_id: stripePaymentIntentId || null,
      paid_at: paidAt
    })
    .eq('id', poolId)
    .eq('status', 'pending')
    .is('offer_snapshot',null)
    .is('offer_digest',null)
    .select('id,client_id,quantity_purchased')
    .maybeSingle();
  if (updateError) throw new Error(updateError.message || 'Interview pool paid update failed');
  if (!updated) return { paid: false, reason: 'not_pending' };

  return { paid: true, pool: updated };
}

/** Marks a pool failed. Only a pending pool can fail. */
async function markPoolFailed({ db, poolId } = {}) {
  if (!db || !poolId) return { failed: false, reason: 'invalid_request' };
  const { data, error } = await db
    .from('client_interview_pools')
    .update({ status: 'failed' })
    .eq('id', poolId)
    .eq('status', 'pending')
    .select('id')
    .maybeSingle();
  if (error) throw new Error(error.message || 'Interview pool failed update failed');
  return { failed: !!data };
}

module.exports = {
  PAID_STATUS,
  markPoolFailed,
  markPoolPaid
};
