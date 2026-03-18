'use strict';

const { sendRoleInterviewLimitReachedEmail } = require('../../utils/mailer');

const FRONTEND_BASE = (process.env.FRONTEND_BASE || process.env.FRONTEND_URL || 'https://www.alphasourceai.com').replace(/\/+$/, '');

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
  const transcriptOverall = transcriptScores && typeof transcriptScores === 'object'
    ? Number(transcriptScores.overall)
    : NaN;
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
      used_interviews: null,
      remaining_interviews: null
    };
  }

  const includedInterviewsPerRole = parseWholeNonNegative(planSettings?.included_interviews_per_role);
  if (includedInterviewsPerRole == null) {
    return {
      included_interviews_per_role: null,
      used_interviews: null,
      remaining_interviews: null
    };
  }

  const { data: interviewRows, error: interviewsError } = await db
    .from('interviews')
    .select('status,transcript_scores,interview_summary')
    .eq('client_id', clientId)
    .eq('role_id', roleId);
  if (interviewsError) {
    return {
      included_interviews_per_role: null,
      used_interviews: null,
      remaining_interviews: null
    };
  }

  let usedInterviews = 0;
  for (const row of (interviewRows || [])) {
    if (isUsedInterviewRow(row)) usedInterviews += 1;
  }

  const remainingInterviews = Math.max(0, includedInterviewsPerRole - usedInterviews);
  return {
    included_interviews_per_role: includedInterviewsPerRole,
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
  return `${FRONTEND_BASE}/account?${params.toString()}`;
}

async function syncRoleInterviewLimitNotification({
  db,
  roleId,
  clientId,
  remainingInterviews,
  roleTitle
}) {
  if (!db || !roleId || !clientId) return;
  if (remainingInterviews == null) return;

  if (remainingInterviews > 0) {
    await db
      .from('roles')
      .update({ interview_limit_notified_at: null })
      .eq('id', roleId)
      .eq('client_id', clientId)
      .not('interview_limit_notified_at', 'is', null);
    return;
  }

  const notifiedAt = new Date().toISOString();
  const { data: markedRows, error: markError } = await db
    .from('roles')
    .update({ interview_limit_notified_at: notifiedAt })
    .eq('id', roleId)
    .eq('client_id', clientId)
    .is('interview_limit_notified_at', null)
    .select('id,title')
    .limit(1);
  if (markError) return;
  if (!Array.isArray(markedRows) || markedRows.length === 0) return;

  const effectiveRoleTitle = String(roleTitle || markedRows[0]?.title || 'Role').trim() || 'Role';

  const { data: client, error: clientError } = await db
    .from('clients')
    .select('id,email,name,client_admin_name')
    .eq('id', clientId)
    .maybeSingle();
  if (clientError || !client) return;

  const clientEmail = String(client.email || '').trim();
  if (!clientEmail) return;
  const recipientName = String(client.client_admin_name || client.name || '').trim();
  const billingUrl = buildRoleBillingUrl(clientId, roleId);

  try {
    await sendRoleInterviewLimitReachedEmail(
      clientEmail,
      billingUrl,
      recipientName,
      effectiveRoleTitle
    );
  } catch (_) {}
}

module.exports = {
  getRoleInterviewAvailability,
  syncRoleInterviewLimitNotification
};
