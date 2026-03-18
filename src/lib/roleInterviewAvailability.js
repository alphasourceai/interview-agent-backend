'use strict';

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

module.exports = {
  getRoleInterviewAvailability
};
