'use strict';

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const INSUFFICIENT_SUMMARY = 'Interview ended before any substantive responses were recorded.\nEvidence strength: 0%\nAI-aided interview risk: Low';

function clampScore(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(100, Math.round(n)));
}

function isSubstantiveTranscript(transcriptText) {
  const text = String(transcriptText || '').trim();
  if (!text) return { ok: false, reason: 'empty_transcript', wordCount: 0 };

  const words = text.split(/\s+/).filter(Boolean);
  const wordCount = words.length;
  if (wordCount < 40) {
    return { ok: false, reason: 'low_word_count', wordCount };
  }

  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  let speakerTurns = 0;
  let answerTurns = 0;
  for (const line of lines) {
    if (/^(CANDIDATE|USER)\s*:/i.test(line)) {
      answerTurns += 1;
      speakerTurns += 1;
      continue;
    }
    if (/^(INTERVIEWER|ASSISTANT|AGENT)\s*:/i.test(line)) {
      speakerTurns += 1;
    }
  }

  if (speakerTurns < 2 && answerTurns < 2) {
    return { ok: false, reason: 'insufficient_turns', wordCount };
  }

  return { ok: true, reason: null, wordCount };
}

function normalizePerceptionScores(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  const out = {};
  const clarity = clampScore(input.clarity);
  const confidence = clampScore(input.confidence);
  const engagement = clampScore(input.engagement ?? input.body_language);
  if (clarity !== null) out.clarity = clarity;
  if (confidence !== null) out.confidence = confidence;
  if (engagement !== null) out.engagement = engagement;
  return out;
}

function normalizeAiAidedRisk(value) {
  const v = String(value || '').trim().toLowerCase();
  if (v === 'low' || v === 'medium' || v === 'high') return v;
  return 'low';
}

function ensureEvidenceStrengthLine(summary, evidenceStrength) {
  const trimmed = String(summary || '').trim();
  const withoutLine = trimmed.replace(/\n?Evidence strength:\s*(\d{1,3}%|Unknown)\s*$/i, '').trim();
  const label = Number.isFinite(Number(evidenceStrength)) ? `${clampScore(evidenceStrength)}%` : 'Unknown';
  return `${withoutLine}\nEvidence strength: ${label}`;
}

function ensureAiRiskLine(summary, risk) {
  const trimmed = String(summary || '').trim();
  const withoutLine = trimmed.replace(/\n?AI-aided interview risk:\s*(low|medium|high)\s*$/i, '').trim();
  const label = risk === 'low' ? 'Low' : risk === 'medium' ? 'Medium' : 'High';
  return `${withoutLine}\nAI-aided interview risk: ${label}`;
}

function ensureSummaryFooter(summary, { evidenceStrength, risk } = {}) {
  let out = String(summary || '').trim();
  out = out.replace(/\n?Evidence strength:\s*(\d{1,3}%|Unknown)\s*$/i, '').trim();
  out = out.replace(/\n?AI-aided interview risk:\s*(low|medium|high)\s*$/i, '').trim();
  out = ensureEvidenceStrengthLine(out, evidenceStrength);
  out = ensureAiRiskLine(out, risk);
  return out;
}

function buildInsufficientResult() {
  return {
    summary: INSUFFICIENT_SUMMARY,
    transcript_scores: {
      overall: null,
      role_fit: null,
      technical_strength: null,
      communication_quality: null,
      confidence: 0,
      ai_aided_risk: 'low',
      ai_aided_risk_reason: 'Insufficient transcript to assess.'
    }
  };
}

async function scoreInterview({ transcriptText, jdText, perceptionScores, mode, request_id } = {}) {
  const substantive = isSubstantiveTranscript(transcriptText);
  if (!substantive.ok) {
    return buildInsufficientResult();
  }

  if (!OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY missing');
  }

  const fetchImpl = typeof fetch === 'function' ? fetch : require('node-fetch');

  const transcript = String(transcriptText || '').slice(0, 16000);
  const jdGrounding = typeof jdText === 'string' && jdText.trim()
    ? jdText.trim().slice(0, 6000)
    : '[JD unavailable; evaluate using transcript and rubric alignment only.]';
  const perception = normalizePerceptionScores(perceptionScores);

  const prompt = `You are evaluating a candidate interview for hiring relevance.
Return ONLY valid JSON with exactly these keys:
{
  "summary": "3-6 sentences, no bullets",
  "overall": 0-100,
  "role_fit": 0-100,
  "technical_strength": 0-100,
  "communication_quality": 0-100,
  "evidence_strength": 0-100,
  "ai_aided_risk": "low|medium|high",
  "ai_aided_risk_reason": "one short sentence"
}

Scoring rules:
- Base scoring primarily on transcript answer quality, accuracy, and relevance to role requirements.
- Use perception/non-verbal signals only as secondary supporting evidence.
- Do not infer protected traits.
- Keep scores conservative and evidence-based.
- evidence_strength is how strong the transcript evidence is for the scores you gave (NOT how "confident" you feel).
- ai_aided_risk is a conservative heuristic based ONLY on observable transcript evidence; it is NOT proof.
- Default ai_aided_risk to "low" unless there are multiple clear indicators; keep the reason neutral and non-accusatory.
  
Job description context:
"""${jdGrounding}"""

Perception scores JSON (secondary evidence):
${JSON.stringify(perception)}

Transcript:
"""${transcript}"""`;

  const resp = await fetchImpl('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      messages: [
        {
          role: 'system',
          content: `Return only strict JSON. mode=${String(mode || 'default')} request_id=${String(request_id || '')}`
        },
        { role: 'user', content: prompt }
      ],
      temperature: 0,
      response_format: { type: 'json_object' }
    })
  });

  if (!resp.ok) {
    const txt = await resp.text().catch(() => '');
    throw new Error(`OpenAI ${resp.status}: ${txt}`);
  }

  const data = await resp.json();
  let parsed = {};
  try {
    parsed = JSON.parse(data?.choices?.[0]?.message?.content || '{}');
  } catch {
    parsed = {};
  }

  const overall = clampScore(parsed.overall);
  if (overall === null) {
    throw new Error('invalid_model_output_overall');
  }
  const roleFit = clampScore(parsed.role_fit);
  const technicalStrength = clampScore(parsed.technical_strength);
  const communicationQuality = clampScore(parsed.communication_quality);
  const evidenceStrength = clampScore(parsed.evidence_strength);
  const aiAidedRisk = normalizeAiAidedRisk(parsed.ai_aided_risk);
  const aiAidedRiskReason = typeof parsed.ai_aided_risk_reason === 'string'
    ? parsed.ai_aided_risk_reason.trim().slice(0, 300)
    : '';

  const rawSummary = String(parsed.summary || '').trim();
  if (!rawSummary) {
    throw new Error('invalid_model_output_summary');
  }
  const summary = ensureSummaryFooter(rawSummary, { evidenceStrength, risk: aiAidedRisk });

  return {
    summary,
    transcript_scores: {
      overall,
      role_fit: roleFit ?? overall,
      technical_strength: technicalStrength ?? overall,
      communication_quality: communicationQuality ?? overall,
      confidence: evidenceStrength !== null ? evidenceStrength : null,
      ai_aided_risk: aiAidedRisk,
      ai_aided_risk_reason: aiAidedRiskReason
    }
  };
}

module.exports = {
  INSUFFICIENT_SUMMARY,
  isSubstantiveTranscript,
  scoreInterview,
  normalizeAiAidedRisk,
  ensureSummaryFooter
};
