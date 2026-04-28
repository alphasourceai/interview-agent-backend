// analyzeResume.js
require('dotenv').config();
const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');
const { OpenAI } = require('openai');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

function readPath(obj, path) {
  return String(path || '').split('.').reduce((cur, key) => cur?.[key], obj);
}

function parsePercent(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' && !value.trim()) return null;
  const normalized = typeof value === 'string' ? value.trim().replace(/%$/, '') : value;
  const n = Number(normalized);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(100, Math.round(n)));
}

function pickPercent(obj, paths) {
  for (const path of paths) {
    const parsed = parsePercent(readPath(obj, path));
    if (parsed !== null) return parsed;
  }
  return null;
}

async function analyzeResume(fileBuffer, mimeType, role, candidateId) {
  let resumeText = '';
  try {
    if (/pdf/i.test(mimeType)) {
      const data = await pdfParse(fileBuffer);
      resumeText = (data.text || '').trim();
    } else if (/wordprocessingml|officedocument|docx/i.test(mimeType)) {
      const res = await mammoth.extractRawText({ buffer: fileBuffer });
      resumeText = (res.value || '').trim();
    } else {
      resumeText = Buffer.from(fileBuffer).toString('utf8').trim();
    }
  } catch (e) {
    console.warn('Resume extraction failed (non-fatal):', e?.message || e);
  }
  if (resumeText.length > 15000) {
    resumeText = resumeText.slice(0, 15000) + '\n\n[Truncated for analysis]';
  }

  let clientName = '';
  try {
    if (role?.client_id) {
      const { data: clientRow, error: clientErr } = await supabase
        .from('clients')
        .select('name')
        .eq('id', role.client_id)
        .maybeSingle();
      if (!clientErr && clientRow?.name) clientName = String(clientRow.name).trim();
    }
  } catch (_) {}

  const systemPrompt = `You are an unbiased, compliance-aware assistant. Do not infer protected attributes.
Return strict JSON only. Do not include markdown, prose, comments, or extra keys.
Use exactly these required keys: resume_score, skills_match_percent, education_match_percent, experience_match_percent, overall_resume_match_percent, summary.
Score the resume against the provided role title and role/JD description.
Use numeric 0-100 values only for score fields, or null when there is insufficient evidence to score a field.
Do not use 0 to mean missing evidence; 0 only means explicit no match.
Never invent employer/company names, role titles, dates, credentials, tools, or claims not present in the resume text.
If information is missing, write "Not provided in resume."
Do not use company names from the role description/job description.
The only authoritative hiring company name is client_name (if provided).
If client_name is empty, do not name any hiring company; refer to "the hiring company" or "the role".
In the summary, refer to "the candidate"; if you mention the hiring company, use client_name only.`;
  const userPrompt = `
Hiring Company Name (authoritative):
${clientName || '[not provided]'}

Role Title:
${role?.title || '[none provided]'}

Role Description (requirements only; company names in this section are not trustworthy for hiring company naming):
${role?.description || '[none provided]'}

Resume:
${resumeText || '[no extractable text]'}

Score definitions:
- skills_match_percent: match between resume skills, tools, domain knowledge, and role requirements.
- experience_match_percent: match between work history, responsibilities, seniority, and role experience needs.
- education_match_percent: match between education/certifications and role education requirements. If the role has no education requirement, score based on relevant credentials and explain uncertainty in summary.
- resume_score: overall resume fit for the role, primarily weighted toward skills and experience.
- overall_resume_match_percent: aggregate role match score; should generally align with resume_score unless there is a clear reason.

Insufficient evidence rules:
- If resume text is not extractable, return null for scores and explain in summary.
- If role/JD requirements are missing or too thin, return null for unsupported scores and explain in summary.
- Never fabricate scores.

Return strict JSON only in this exact shape:
{
  "resume_score": number_or_null,
  "skills_match_percent": number_or_null,
  "education_match_percent": number_or_null,
  "experience_match_percent": number_or_null,
  "overall_resume_match_percent": number_or_null,
  "summary": "100-150 word evidence-based summary"
}
All score values must be numeric 0-100 values or null, not strings.
`;

  let result = {
    resume_score: null,
    skills_match_percent: null,
    experience_match_percent: null,
    education_match_percent: null,
    overall_resume_match_percent: null,
    summary: 'Automated analysis unavailable; manual review recommended.'
  };

  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }],
      response_format: { type: 'json_object' }
    });
    const parsed = JSON.parse(response.choices[0].message.content || '{}');
    const resumeScore = pickPercent(parsed, ['resume_score', 'overall_resume_match_percent', 'overall', 'scores.overall']);
    const skillsScore = pickPercent(parsed, ['skills_match_percent', 'skills', 'skills_score', 'scores.skills']);
    const experienceScore = pickPercent(parsed, ['experience_match_percent', 'experience', 'experience_score', 'scores.experience']);
    const educationScore = pickPercent(parsed, ['education_match_percent', 'education', 'education_score', 'scores.education']);
    const overallResumeScore = pickPercent(parsed, ['overall_resume_match_percent', 'resume_score', 'overall', 'scores.overall']);
    const parsedTopKeys = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? Object.keys(parsed) : [];
    const parsedScores = {
      resume_score: resumeScore !== null,
      skills_match_percent: skillsScore !== null,
      experience_match_percent: experienceScore !== null,
      education_match_percent: educationScore !== null,
      overall_resume_match_percent: overallResumeScore !== null
    };
    const missingScoreFields = Object.entries(parsedScores)
      .filter(([, ok]) => !ok)
      .map(([key]) => key);
    console.log('[resume-analysis] parsed_openai_output', {
      candidate_id: candidateId || null,
      role_id: role?.id || null,
      parsed_top_keys: parsedTopKeys,
      score_complete: missingScoreFields.length === 0,
      missing_score_fields: missingScoreFields,
      parsed_scores: parsedScores
    });
    result = {
      resume_score: resumeScore,
      skills_match_percent: skillsScore,
      experience_match_percent: experienceScore,
      education_match_percent: educationScore,
      overall_resume_match_percent: overallResumeScore,
      summary: parsed.summary || result.summary
    };
  } catch (e) {
    console.warn('OpenAI resume analysis failed (non-fatal):', e?.message || e);
  }

  if (clientName && typeof result.summary === 'string') {
    result.summary = result.summary.replace(/\bclient_name\b/gi, clientName);
  }
  if (clientName && typeof result.resume_summary === 'string') {
    result.resume_summary = result.resume_summary.replace(/\bclient_name\b/gi, clientName);
  }
  if (clientName && result.resume_analysis && typeof result.resume_analysis.summary === 'string') {
    result.resume_analysis.summary = result.resume_analysis.summary.replace(/\bclient_name\b/gi, clientName);
  }

  try {
    await supabase.from('reports').insert([{
      candidate_id: candidateId,
      role_id: role?.id || null,
      client_id: role?.client_id || null,
      resume_score: result.resume_score,
      resume_breakdown: result
    }]);
  } catch (e) {
    console.error('Insert into reports failed:', e?.message || e);
  }

  return result;
}

module.exports = analyzeResume;
