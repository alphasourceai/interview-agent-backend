// analyzeResume.js (backend root)
require('dotenv').config();
const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');
const { OpenAI } = require('openai');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/**
 * Analyze a resume from a raw file buffer against a role.
 * Inserts into `reports` (candidate_id, resume_score, resume_breakdown)
 * and returns the parsed result.
 *
 * @param {Buffer} fileBuffer
 * @param {string} mimeType      e.g. "application/pdf" or DOCX mimetype
 * @param {object} role          expects { description, title, interview_type, rubric? }
 * @param {string} candidateId
 * @returns {Promise<{resume_score:number, resume_breakdown:Object, summary:string}>}
 */
async function analyzeResume(fileBuffer, mimeType, role, candidateId) {
  // 1) Extract text
  let resumeText = '';
  try {
    const isPdf = /pdf/i.test(mimeType);
    const isDocx = /wordprocessingml|officedocument|docx/i.test(mimeType);

    if (isPdf) {
      const data = await pdfParse(fileBuffer);
      resumeText = (data.text || '').trim();
    } else if (isDocx) {
      const res = await mammoth.extractRawText({ buffer: fileBuffer });
      resumeText = (res.value || '').trim();
    } else {
      resumeText = Buffer.from(fileBuffer).toString('utf8').trim();
    }
  } catch (e) {
    console.warn('Resume extraction failed (non-fatal):', e?.message || e);
    resumeText = '';
  }

  if (resumeText.length > 15000) {
    resumeText = resumeText.slice(0, 15000) + '\n\n[Truncated for analysis]';
  }

  // 2) Build prompts (keep ADA/EEOC compliance)
  const systemPrompt = `
You are an unbiased, compliance-aware AI assistant helping evaluate candidates.
You must remain fully ADA and EEOC compliant. Do not infer or consider any protected characteristics.`;

  const userPrompt = `
Role Description:
${role?.description || '[none provided]'}

Resume:
${resumeText || '[no extractable text]'}

Provide a JSON response with:
- resume_score (0–100)
- skills_match_percent (0–100)
- experience_match_percent (0–100)
- education_match_percent (0–100)
- overall_resume_match_percent (0–100)
- summary (100–150 words)
`;

  // 3) Call OpenAI
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
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
      response_format: { type: 'json_object' }
    });

    const parsed = JSON.parse(response.choices[0].message.content);
    if (parsed && typeof parsed === 'object') {
      result = {
        resume_score: Number(parsed.resume_score) || 0,
        skills_match_percent: Number(parsed.skills_match_percent) || 0,
        experience_match_percent: Number(parsed.experience_match_percent) || 0,
        education_match_percent: Number(parsed.education_match_percent) || 0,
        overall_resume_match_percent: Number(parsed.overall_resume_match_percent) || 0,
        summary: parsed.summary || result.summary
      };
    }
  } catch (e) {
    console.warn('OpenAI resume analysis failed (non-fatal):', e?.message || e);
  }

  // 4) Insert into reports
  try {
    const { error } = await supabase
      .from('reports')
      .insert([{
        candidate_id: candidateId,
        resume_score: result.resume_score,
        resume_breakdown: result
      }]);

    if (error) {
      console.error('Insert into reports failed:', error);
    }
  } catch (e) {
    console.error('Insert into reports threw:', e?.message || e);
  }

  return result;
}

module.exports = analyzeResume;
