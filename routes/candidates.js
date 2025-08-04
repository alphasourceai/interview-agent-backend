const express = require('express');
const router = express.Router();
const { supabase } = require('../supabaseClient');

router.get('/', async (req, res) => {
  const { data, error } = await supabase
    .from('candidates')
    .select('*')
    .order('created_at', { ascending: false });

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

router.post('/', async (req, res) => {
  const { candidate_id, name, email } = req.body;

  if (!candidate_id || !name || !email) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  const { data, error } = await supabase
    .from('candidates')
    .insert([{ candidate_id, name, email, interview_status: 'pending' }])
    .select();

  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json(data[0]);
});

router.put('/:id', async (req, res) => {
  const { id } = req.params;
  const updateData = req.body;

  const { data, error } = await supabase
    .from('candidates')
    .update(updateData)
    .eq('id', id)
    .select();

  if (error) return res.status(500).json({ error: error.message });
  res.json(data[0]);
});

router.get('/:id/report', async (req, res) => {
  const { id } = req.params;

  try {
    const { data: candidate, error: candidateError } = await supabase
      .from('candidates')
      .select('id, name, email, resume_url, interview_video_url')
      .eq('id', id)
      .single();

    if (candidateError || !candidate) {
      return res.status(404).json({ error: 'Candidate not found', details: candidateError });
    }

    const { data: report, error: reportError } = await supabase
      .from('reports')
      .select('resume_breakdown, interview_breakdown, analysis, report_url')
      .eq('candidate_id', candidate.id)
      .single();

    if (reportError || !report) {
      return res.status(404).json({ error: 'Analysis report not found', details: reportError });
    }

    return res.json({
      name: candidate.name,
      email: candidate.email,
      resume_url: candidate.resume_url,
      interview_video_url: candidate.interview_video_url,
      report_url: report.report_url,
      ...report.analysis,
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Internal server error', details: err.message });
  }
});

module.exports = router;
