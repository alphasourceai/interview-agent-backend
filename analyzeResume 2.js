const fs = require('fs');
const pdfParse = require('pdf-parse');
const OpenAI = require('openai');
const { createClient } = require('@supabase/supabase-js');
const { config } = require('dotenv');

config();

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

async function analyzeResume(candidate, resumePath, role) {
  // Extract text from PDF
  const pdfData = await pdfParse(fs.readFileSync(resumePath));
  const resumeText = pdfData.text;

  const prompt = `
You are an expert recruiter. Analyze this resume against the role description.

Role Description:
${role.description}

Resume:
${resumeText}

Provide a JSON response with:
- resume_score (0-100)
- skills_match_percent (0-100)
- experience_match_percent (0-100)
- education_match_percent (0-100)
- overall_resume_match_percent (0-100)
- summary (100-150 words)
`;

  const response = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: prompt }],
    response_format: { type: "json_object" }
  });

  const result = JSON.parse(response.choices[0].message.content);

  // Insert into reports table
  const { error } = await supabase
    .from('reports')
    .insert([{
      candidate_id: candidate.id,
      resume_score: result.resume_score,
      resume_breakdown: result
    }]);

  if (error) throw new Error(error.message);
  return result;
}

module.exports = analyzeResume;
