// routes/dashboard.js — provides /dashboard/candidates (& /interviews for legacy)
const express = require('express');
const router = express.Router();
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
}
const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

// ---------- helpers ----------
function normalizeCandidateRow(row) {
  const summary = row.analysis_summary || {};
  const resume_score =
    (typeof summary.resume_score === 'number' ? summary.resume_score : null) ??
    (typeof summary.overall_resume_match_percent === 'number'
      ? summary.overall_resume_match_percent
      : null);

  const interview_score =
    typeof summary.interview_score === 'number' ? summary.interview_score : null;

  const overall_score =
    (typeof summary.overall_score === 'number' ? summary.overall_score : null) ??
    (resume_score != null && interview_score != null
      ? Math.round((resume_score + interview_score) / 2)
      : resume_score ?? interview_score ?? null);

  return {
    id: row.id,
    created_at: row.created_at,
    email: row.email,
    name: [row.first_name, row.last_name].filter(Boolean).join(' ') || summary.name || null,
    role: row.roles?.title || null,
    interview_type: row.roles?.interview_type || null,
    resume_url: row.resume_url || null,
    interview_video_url: row.interview_video_url || null,
    analysis_summary: summary,
    resume_score,
    interview_score,
    overall_score,
  };
}

async function fetchCandidatesByClient(client_id) {
  const { data, error } = await supabaseAdmin
    .from('candidates')
    .select(
      `
      id, created_at, email, first_name, last_name, resume_url, interview_video_url, analysis_summary,
      roles:role_id ( id, title, interview_type, client_id )
    `,
    )
    .eq('roles.client_id', client_id)
    .order('created_at', { ascending: false });

  if (error) throw error;
  return (data || []).map(normalizeCandidateRow);
}

// ---------- routes ----------

// GET /dashboard/candidates?client_id=...
router.get('/candidates', async (req, res) => {
  const client_id = req.query.client_id;
  if (!client_id) return res.status(400).json({ error: 'client_id is required' });

  try {
    const rows = await fetchCandidatesByClient(client_id);
    res.json({ rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Legacy alias kept for older FE: /dashboard/interviews
router.get('/interviews', async (req, res) => {
  const client_id = req.query.client_id;
  if (!client_id) return res.status(400).json({ error: 'client_id is required' });

  try {
    const rows = await fetchCandidatesByClient(client_id);
    res.json({ rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
