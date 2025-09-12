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

  const systemPrompt = `You are an unbiased, compliance-aware assistant. Do not infer protected attributes.`;
  const userPrompt = `
Role Description:
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
