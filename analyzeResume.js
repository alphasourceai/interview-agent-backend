// analyzeResume.js
require('dotenv').config();
const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');
const { OpenAI } = require('openai');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

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

Return JSON with:
resume_score, skills_match_percent, experience_match_percent, education_match_percent, overall_resume_match_percent, summary (100–150 words)
`;

  let result = {
    resume_score: 0,
    skills_match_percent: 0,
    experience_match_percent: 0,
    education_match_percent: 0,
    overall_resume_match_percent: 0,
    summary: 'Automated analysis unavailable; manual review recommended.'
  };

  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }],
      response_format: { type: 'json_object' }
    });
    const parsed = JSON.parse(response.choices[0].message.content || '{}');
    result = {
      resume_score: Number(parsed.resume_score) || 0,
      skills_match_percent: Number(parsed.skills_match_percent) || 0,
      experience_match_percent: Number(parsed.experience_match_percent) || 0,
      education_match_percent: Number(parsed.education_match_percent) || 0,
      overall_resume_match_percent: Number(parsed.overall_resume_match_percent) || 0,
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
