'use strict';

const { sendRoleInterviewLimitReachedEmail } = require('../../utils/mailer');

const FRONTEND_BASE = String(process.env.FRONTEND_BASE || process.env.FRONTEND_URL || 'https://www.alphasourceai.com').replace(/\/+$/, '');
const EARLY_ENDED_SENTINEL_SUMMARY = 'Interview ended before substantive responses were captured.';
const INSUFFICIENT_TRANSCRIPT_EARLY_END_SUMMARY_PREFIX = 'Interview ended before any substantive responses were recorded.';

function parseWholeNonNegative(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.floor(n));
}

function parseTranscriptScores(value) {
  if (value && typeof value === 'object') return value;
  if (typeof value === 'string' && value.trim()) {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === 'object') return parsed;
    } catch (_) {}
  }
  return null;
}

function isUsedInterviewRow(row) {
  const normalizedStatus = String(row?.status || '').trim().toLowerCase();
  const summary = typeof row?.interview_summary === 'string' ? row.interview_summary.trim() : '';
  const transcriptScores = parseTranscriptScores(row?.transcript_scores);
  const transcriptOverallRaw = transcriptScores && typeof transcriptScores === 'object'
    ? transcriptScores.overall
    : undefined;
  const transcriptOverall = transcriptScores && typeof transcriptScores === 'object'
    ? Number(transcriptOverallRaw)
    : NaN;
  const hasNumericTranscriptOverall = (
    transcriptOverallRaw != null &&
    !(typeof transcriptOverallRaw === 'string' && transcriptOverallRaw.trim() === '') &&
    Number.isFinite(Number(transcriptOverallRaw))
  );
  const isEarlyEndedSentinel =
    normalizedStatus === 'ended' &&
    summary === EARLY_ENDED_SENTINEL_SUMMARY &&
    !hasNumericTranscriptOverall;
  const isInsufficientTranscriptEarlyEndSummary =
    summary.startsWith(INSUFFICIENT_TRANSCRIPT_EARLY_END_SUMMARY_PREFIX) &&
    !hasNumericTranscriptOverall;
  if (isEarlyEndedSentinel || isInsufficientTranscriptEarlyEndSummary) return false;
  return (
    normalizedStatus === 'completed' ||
    normalizedStatus === 'analyzed' ||
    !!summary ||
    Number.isFinite(transcriptOverall)
  );
}

async function getRoleInterviewAvailability({ db, roleId, clientId }) {
  if (!db || !roleId || !clientId) {
    return {
      included_interviews_per_role: null,
      purchased_interviews: null,
      used_interviews: null,
      remaining_interviews: null
    };
  }

  const { data: planSettings, error: planSettingsError } = await db
    .from('client_plan_settings')
    .select('included_interviews_per_role')
    .eq('client_id', clientId)
    .maybeSingle();
  if (planSettingsError) {
    return {
      included_interviews_per_role: null,
      purchased_interviews: null,
      used_interviews: null,
      remaining_interviews: null
    };
  }

  const includedInterviewsPerRole = parseWholeNonNegative(planSettings?.included_interviews_per_role);
  if (includedInterviewsPerRole == null) {
    return {
      included_interviews_per_role: null,
      purchased_interviews: null,
      used_interviews: null,
      remaining_interviews: null
    };
  }

  const { data: purchaseRows, error: purchasesError } = await db
    .from('role_interview_purchases')
    .select('quantity')
    .eq('client_id', clientId)
    .eq('role_id', roleId)
    .eq('status', 'paid');
  if (purchasesError) {
    return {
      included_interviews_per_role: null,
      purchased_interviews: null,
      used_interviews: null,
      remaining_interviews: null
    };
  }

  let purchasedInterviews = 0;
  for (const row of (purchaseRows || [])) {
    const quantity = parseWholeNonNegative(row?.quantity);
    if (quantity != null) purchasedInterviews += quantity;
  }

  const { data: interviewRows, error: interviewsError } = await db
    .from('interviews')
    .select('status,transcript_scores,interview_summary')
    .eq('client_id', clientId)
    .eq('role_id', roleId);
  if (interviewsError) {
    return {
      included_interviews_per_role: null,
      purchased_interviews: null,
      used_interviews: null,
      remaining_interviews: null
    };
  }

  let usedInterviews = 0;
  for (const row of (interviewRows || [])) {
    if (isUsedInterviewRow(row)) usedInterviews += 1;
  }

  const remainingInterviews = Math.max(0, includedInterviewsPerRole + purchasedInterviews - usedInterviews);
  return {
    included_interviews_per_role: includedInterviewsPerRole,
    purchased_interviews: purchasedInterviews,
    used_interviews: usedInterviews,
    remaining_interviews: remainingInterviews
  };
}

function buildRoleBillingUrl(clientId, roleId) {
  const params = new URLSearchParams({
    tab: 'billing',
    intent: 'role_capacity',
    client_id: String(clientId || ''),
    role_id: String(roleId || '')
  });
  return `${FRONTEND_BASE}/dashboard?${params.toString()}`;
}

async function syncRoleInterviewLimitNotification({
  db,
  roleId,
  clientId,
  remainingInterviews,
  roleTitle
}) {
  console.log('[role-limit-notify] entry', {
    role_id: roleId || null,
    client_id: clientId || null,
    remaining_interviews: remainingInterviews
  });
  if (!db || !roleId || !clientId) return;
  if (remainingInterviews == null) return;

  if (remainingInterviews > 0) {
    const { error: resetError } = await db
      .from('roles')
      .update({ interview_limit_notified_at: null })
      .eq('id', roleId)
      .eq('client_id', clientId)
      .not('interview_limit_notified_at', 'is', null);
    if (resetError) {
      console.error('[role-limit-notify] reset_failed', {
        role_id: roleId,
        client_id: clientId,
        error: resetError?.message || resetError,
        details: resetError?.details || null,
        hint: resetError?.hint || null
      });
    } else {
      console.log('[role-limit-notify] reset_marker', {
        role_id: roleId,
        client_id: clientId,
        remaining_interviews: remainingInterviews
      });
    }
    return;
  }

  const notifiedAt = new Date().toISOString();
  const { data: markedRows, error: markError } = await db
    .from('roles')
    .update({ interview_limit_notified_at: notifiedAt })
    .eq('id', roleId)
    .eq('client_id', clientId)
    .is('interview_limit_notified_at', null)
    .select('id,title');
  if (markError) {
    console.error('[role-limit-notify] mark_failed', {
      role_id: roleId,
      client_id: clientId,
      error: markError?.message || markError,
      details: markError?.details || null,
      hint: markError?.hint || null
    });
    return;
  }
  if (!Array.isArray(markedRows) || markedRows.length === 0) {
    console.log('[role-limit-notify] mark_skipped_already_notified', {
      role_id: roleId,
      client_id: clientId
    });
    return;
  }
  console.log('[role-limit-notify] mark_success', {
    role_id: markedRows[0]?.id || roleId,
    client_id: clientId,
    notified_at: notifiedAt
  });

  const effectiveRoleTitle = String(roleTitle || markedRows[0]?.title || 'Role').trim() || 'Role';

  const { data: client, error: clientError } = await db
    .from('clients')
    .select('id,email,name,client_admin_name')
    .eq('id', clientId)
    .maybeSingle();
  if (clientError) {
    console.error('[role-limit-notify] client_lookup_failed', {
      role_id: roleId,
      client_id: clientId,
      error: clientError?.message || clientError,
      details: clientError?.details || null,
      hint: clientError?.hint || null
    });
    return;
  }
  if (!client) {
    console.warn('[role-limit-notify] client_missing', {
      role_id: roleId,
      client_id: clientId
    });
    return;
  }

  const clientEmail = String(client.email || '').trim();
  if (!clientEmail) {
    console.warn('[role-limit-notify] client_email_missing', {
      role_id: roleId,
      client_id: clientId
    });
    return;
  }
  const recipientName = String(client.client_admin_name || client.name || '').trim();
  const billingUrl = buildRoleBillingUrl(clientId, roleId);

  try {
    const emailResult = await sendRoleInterviewLimitReachedEmail(
      clientEmail,
      billingUrl,
      recipientName,
      effectiveRoleTitle
    );
    console.log('[role-limit-notify] email_sent', {
      role_id: roleId,
      client_id: clientId,
      to: clientEmail,
      result: emailResult || null
    });
  } catch (emailErr) {
    console.error('[role-limit-notify] email_send_failed', {
      role_id: roleId,
      client_id: clientId,
      to: clientEmail,
      error: emailErr?.message || emailErr
    });
  }
}

module.exports = {
  getRoleInterviewAvailability,
  syncRoleInterviewLimitNotification
};
