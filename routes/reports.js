const express = require('express');
const router = express.Router();
const { supabase } = require('../supabaseClient');
const { generateCandidatePDF } = require('../utils/pdfMonkey');

// GET /candidates/:candidate_id/report
router.get('/candidates/:candidate_id/report', async (req, res) => {
  const candidateId = req.params.candidate_id;

  const { data, error } = await supabase
    .from('reports')
    .select('*')
    .eq('candidate_id', candidateId)
    .single();

  if (error || !data) {
    return res.status(404).json({ error: 'Candidate not found', details: error });
  }

  res.json(data);
});

// POST /generate-report/:candidate_id
router.post('/:candidate_id', async (req, res) => {
  const { candidate_id } = req.params;

  try {
    const { data: candidate, error: candidateError } = await supabase
      .from('candidates')
      .select('id, name, email')
      .eq('candidate_id', candidate_id)
      .single();

    if (candidateError || !candidate) {
      return res.status(404).json({ error: 'Candidate not found', details: candidateError });
    }

    const { data: report, error: reportError } = await supabase
      .from('reports')
      .select('*')
      .eq('candidate_id', candidate.id)
      .single();

    if (reportError || !report) {
      return res.status(404).json({ error: 'Report not found', details: reportError });
    }

    const resume = report.resume_breakdown;
    const interview = report.interview_breakdown;

    if (!resume?.total_score || !interview?.total_score) {
      return res.status(400).json({ error: 'Resume or interview scores incomplete.' });
    }

    const payload = {
      name: candidate.name,
      email: candidate.email,
      resume,
      interview,
      overall_score: Math.round((resume.total_score + interview.total_score) / 2),
      status: 'Report Ready',
    };

    const report_url = await generateCandidatePDF(payload);

    await supabase
      .from('reports')
      .update({ report_url })
      .eq('candidate_id', candidate.id);

    return res.status(200).json({ message: 'PDF generated', report_url });
  } catch (err) {
    console.error('Manual PDF Gen Error:', err);
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;
