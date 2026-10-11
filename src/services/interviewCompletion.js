'use strict';

// When an interview became used.
//
// This is the one fact the interview paths record for billing's benefit. They
// call nothing else: balances, allowances and invoices are all computed from the
// interviews table at the moment someone asks, so there is no counter to keep in
// step and no job to fall behind.
//
// The write is conditional on completed_at still being null, so a redelivered
// webhook or a late transcript cannot move an interview into a later month —
// which would move which invoice it is billed on.

/**
 * Stamps an interview as completed, once.
 *
 * Returns `{ marked: true }` only when this call set it. A row that already had
 * a timestamp returns `{ marked: false, reason: 'already_completed' }`, which is
 * the normal answer for a redelivery, not a failure.
 */
async function markInterviewCompleted({ db, interviewId, completedAt } = {}) {
  if (!db || !interviewId) return { marked: false, reason: 'invalid_request' };

  const stampedAt = (() => {
    if (!completedAt) return new Date().toISOString();
    const date = completedAt instanceof Date ? completedAt : new Date(completedAt);
    return Number.isFinite(date.getTime()) ? date.toISOString() : new Date().toISOString();
  })();

  const { data, error } = await db
    .from('interviews')
    .update({ completed_at: stampedAt })
    .eq('id', interviewId)
    .is('completed_at', null)
    .select('id')
    .maybeSingle();
  if (error) {
    // A fixed message and the code only: the database's message, details and
    // hint can carry row values, and callers log what this throws.
    const stampError = new Error('interview_completion_stamp_failed');
    stampError.code = error.code;
    throw stampError;
  }
  if (!data) return { marked: false, reason: 'already_completed' };
  return { marked: true, completed_at: stampedAt };
}

module.exports = { markInterviewCompleted };
