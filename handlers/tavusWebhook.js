const { supabase } = require('../supabaseClient');
const { generatePDFReport } = require('../handlers/generateReport');
const { OpenAI } = require('openai');
require('dotenv').config();

const TAVUS_WEBHOOK_SECRET = process.env.TAVUS_WEBHOOK_SECRET;
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

function verifySignature(req, secret) {
  const providedSecret = req.headers['x-webhook-secret'];
  return providedSecret && providedSecret === secret;
}

async function handleTavusWebhook(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).send({ error: 'Method not allowed' });
  }

  const valid = verifySignature(req, TAVUS_WEBHOOK_SECRET);
  if (!valid) {
    return res.status(401).send({ error: 'Invalid webhook secret' });
  }

  const { type, data } = req.body;

  if (type !== 'application.recording_ready') {
    return res.status(200).send({ message: 'Event ignored' });
  }

  const { application_id, video_url, metadata } = data;
  const candidate_id = metadata?.candidate_id;

  if (!application_id || !video_url || !candidate_id) {
    return res.status(400).send({ error: 'Missing required fields in webhook payload.' });
  }

  const { error: interviewError } = await supabase.from('interviews').insert({
    candidate_id,
    video_url,
    tavus_application_id: application_id,
    status: 'Video Ready'
  });

  if (interviewError) {
    console.error('❌ Supabase insert error:', interviewError);
    return res.status(500).send({ error: 'Failed to save interview info' });
  }

  const { data: candidate, error: candidateError } = await supabase
    .from('candidates')
    .select('*, roles (description)')
    .eq('id', candidate_id)
    .single();

  if (candidateError || !candidate) {
    console.error('❌ Candidate not found:', candidateError);
    return res.status(404).send({ error: 'Candidate not found' });
  }

  const jobDescription = candidate.roles?.description || 'Not provided';

  const { data: report, error: reportError } = await supabase
    .from('reports')
    .select('*')
    .eq('candidate_id', candidate_id)
    .single();

  if (reportError || !report) {
    console.error('❌ Report not found:', reportError);
    return res.status(404).send({ error: 'Report not found' });
  }

  // Fallback for resume_breakdown structure
  const resume_breakdown = report.resume_breakdown || {};
  const resume_score = report.resume_score || 0;

  // --- OPENAI INTERVIEW EVALUATION ---
  const systemPrompt = `
You are an objective AI interviewer assistant.

You must remain fully ADA and EEOC compliant — do not infer or consider any protected characteristics such as age, gender, race, disability, or ethnicity.

Evaluate the candidate solely on clarity, confidence, and relevance of their verbal responses in relation to the job description.
`;

  const userPrompt = `
Job Description:
${jobDescription}

Interview Summary:
[Transcript not available — assume verbal delivery context only]

Provide a JSON response with:
- interview_score (0–100)
- clarity (0–100)
- confidence (0–100)
- body_language (0–100) [if not measurable, estimate based on tone]
- overall_interview_match_percent (0–100)
- summary (100–150 words)
`;

  let interviewBreakdown = {
    interview_score: 80,
    clarity: 80,
    confidence: 75,
    body_language: 85,
    overall_interview_match_percent: 80,
    summary: "Placeholder summary until AI response is returned."
  };

  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt }
      ],
      response_format: { type: "json_object" }
    });

    interviewBreakdown = JSON.parse(response.choices[0].message.content);
  } catch (err) {
    console.warn('⚠️ Failed to analyze interview with OpenAI:', err.message);
  }

  const interview_score = interviewBreakdown.interview_score || 0;

  const analysis = {
    resume_score,
    interview_score,
    overall_score: Math.round((resume_score + interview_score) / 2),
    resume_breakdown: {
      experience_match_percent: resume_breakdown.experience || 0,
      skills_match_percent: resume_breakdown.skills || 0,
      education_match_percent: resume_breakdown.education || 0,
      overall_resume_match_percent: resume_score
    },
    interview_breakdown: {
      clarity: interviewBreakdown.clarity || 0,
      confidence: interviewBreakdown.confidence || 0,
      body_language: interviewBreakdown.body_language || 0
    }
  };

  let pdfUrl;
  try {
    pdfUrl = await generatePDFReport(candidate, { video_url }, analysis);
  } catch (err) {
    console.error('❌ Failed to generate PDF report:', err.message);
    return res.status(500).send({ error: 'Failed to generate PDF report' });
  }

  const { error: updateError } = await supabase
    .from('reports')
    .update({
      interview_score: analysis.interview_score,
      overall_score: analysis.overall_score,
      interview_breakdown: analysis.interview_breakdown,
      report_url: pdfUrl
    })
    .eq('candidate_id', candidate_id);

  if (updateError) {
    console.error('❌ Failed to update report with PDF URL:', updateError);
    return res.status(500).send({ error: 'Failed to update report' });
  }

  return res.status(200).send({ message: 'Webhook processed, PDF generated', pdfUrl });
}

module.exports = { handleTavusWebhook };
