'use strict';
const { classifyInterviewDisplayState } = require('../src/lib/interviewDisplayState');

function object(value) {
  if (typeof value === 'string') { try { value = JSON.parse(value); } catch { return {}; } }
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}
function score(value) {
  if (value == null || (typeof value === 'string' && !value.trim())) return null;
  if (!['number', 'string'].includes(typeof value)) return null;
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(100, number)) : null;
}
function text(value) { return typeof value === 'string' ? value.trim() : ''; }
function list(value) {
  if (typeof value === 'string') { try { return list(JSON.parse(value)); } catch { return value.trim() ? [value.trim()] : []; } }
  return Array.isArray(value) ? value.map(text).filter(Boolean) : [];
}
// Match the candidate dashboard's evidence guard; do not publish prohibited trait inference.
const FORBIDDEN = /\b(honesty|truthfulness|deception|appearance|gaze|attractiveness|race|ethnicity|gender|age|disability|trustworthiness|likability|personality|motivation)\b/i;
const safeText = value => FORBIDDEN.test(text(value)) ? '' : text(value);
const safeList = value => list(value).filter(item => safeText(item));
function advanced(value) {
  const raw = object(value), scores = object(raw.scores), conditions = object(raw.conditions), risk = object(raw.risk);
  return {
    scores: Object.fromEntries(['response_specificity', 'answer_directness', 'answer_consistency', 'communication_structure'].map(key => [key, score(scores[key])])),
    conditions: Object.fromEntries(['evaluation_conditions', 'signal_confidence', 'audio_quality_issues', 'distraction_risk'].map(key => [key, safeText(conditions[key])])),
    risk: { integrity_risk: safeText(risk.integrity_risk), reason: safeText(risk.reason) },
    evidence_summary: safeText(raw.evidence_summary), evidence: safeList(raw.evidence),
    limitations: safeList(raw.limitations).filter(item => !/^(none|n\/a|na|not applicable|unavailable)$/i.test(item)),
  };
}

function buildCandidateReportPayload({ candidate = {}, interview, role = {}, client = {}, exposeAdvanced = false, syntheticDemo = false }) {
  // Canonical candidate and exact-attempt sources only: cached report scores may be stale.
  const resume = object(candidate.analysis_summary), transcript = object(interview?.transcript_scores), perception = object(interview?.perception_scores);
  const summary = text(interview?.interview_summary);
  const insufficient = interview?.has_substantive_response === false
    || interview?.failure_code === 'NO_SUBSTANTIVE_CANDIDATE_RESPONSE';
  const resumeScore = score(resume.resume_score ?? resume.resume ?? resume.resume_match_percent ?? resume.resumeMatchPercent);
  let interviewScore = insufficient ? null : score(transcript.overall);
  const display = classifyInterviewDisplayState(interview, { hasScore: interviewScore !== null });
  if (display.state === 'no_response') interviewScore = null;
  const suppressed = insufficient || ['no_response', 'tech_issue'].includes(display.state);
  const demoSignals = syntheticDemo && perception.mode === 'demo' && perception.synthetic === true;
  const textInterview = perception.mode === 'text';
  const mediaUnavailable = textInterview || (perception.unavailable === true && !demoSignals);
  const unavailable = suppressed || mediaUnavailable;
  const hasInterview = !!summary || interviewScore !== null || Object.keys(transcript).length > 0 || insufficient || ['no_response', 'tech_issue'].includes(display.state);
  const risk = text(transcript.ai_aided_risk).toLowerCase();
  return {
    candidate_id: candidate.id || '',
    name: text(candidate.name) || 'Unknown Candidate', email: text(candidate.email),
    company_name: text(client.name), role_name: text(role.title), status: display.label,
    interview_id: interview?.id || '', attempt_number: interview?.attempt_number || null,
    created_at: interview?.created_at || null, synthetic_demo: syntheticDemo,
    resume_score: resumeScore, interview_score: interviewScore,
    overall_score: resumeScore !== null && interviewScore !== null ? Math.round((resumeScore + interviewScore) / 2) : null,
    resume_breakdown: {
      experience: score(resume.experience_match_percent ?? resume.experienceMatchPercent),
      skills: score(resume.skills_match_percent ?? resume.skillsMatchPercent),
      education: score(resume.education_match_percent ?? resume.educationMatchPercent),
    },
    resume_summary: text(resume.summary) || text(resume.resume_summary) || text(resume.resumeSummary) || text(object(resume.resume_analysis).summary),
    interview_breakdown: {
      clarity: unavailable ? null : score(perception.clarity), confidence: unavailable ? null : score(perception.confidence),
      engagement: unavailable ? null : score(perception.engagement ?? perception.body_language),
      evidence_strength: hasInterview && !suppressed && !mediaUnavailable ? score(transcript.confidence) : null,
      ai_aided_risk: hasInterview && !suppressed && ['low', 'medium', 'high'].includes(risk) ? risk : '',
      ai_aided_risk_reason: hasInterview && !suppressed ? text(transcript.ai_aided_risk_reason) : '',
    },
    reliability_note: suppressed ? 'Insufficient usable interview evidence.' : textInterview ? 'Not applicable for text interviews.' : mediaUnavailable ? 'Media-based signals are unavailable.' : '',
    interview_summary: hasInterview ? summary || 'No interview summary available yet.' : 'Interview not yet completed.',
    unanswered_candidate_questions: hasInterview ? list(interview?.unanswered_candidate_questions) : [],
    interview_analysis_v2: exposeAdvanced && hasInterview && !suppressed ? advanced(interview?.interview_analysis_v2) : advanced(null),
  };
}
module.exports = { buildCandidateReportPayload, score, advanced };
