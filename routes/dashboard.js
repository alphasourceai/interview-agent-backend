// routes/dashboard.js
const express = require('express');
const { createClient } = require('@supabase/supabase-js');

const router = express.Router();

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
  global: { fetch }
});

// Helper: ensure client_id provided and within req.clientIds
function ensureClientScope(req, res) {
  const clientId = req.query.client_id;
  if (!clientId) {
    res.status(400).json({ error: 'client_id required' });
    return null;
  }
  const allowed = (req.clientIds || []).includes(clientId);
  if (!allowed) {
    res.status(403).json({ error: 'No client scope' });
    return null;
  }
  return clientId;
}

// Legacy endpoint some FE code still hits (kept to avoid crashes)
router.get('/interviews', async (req, res) => {
  const clientId = ensureClientScope(req, res);
  if (!clientId) return;
  // If you eventually re-introduce interviews, fetch here.
  return res.json({ items: [] });
});

// The real Candidates endpoint the Candidates tab should call
router.get('/candidates', async (req, res) => {
  const clientId = ensureClientScope(req, res);
  if (!clientId) return;

  // Pull candidates for this client
  const { data: rows, error } = await supabase
    .from('candidates')
    .select('id, first_name, last_name, email, role_id, analysis_summary, resume_url, interview_video_url, created_at, status')
    .eq('client_id', clientId)
    .order('created_at', { ascending: false });

  if (error) {
    console.error('[dashboard/candidates] supabase error', error);
    return res.status(500).json({ error: 'query failed' });
  }

  // Join role titles
  const roleIds = Array.from(new Set(rows.filter(r => r.role_id).map(r => r.role_id)));
  let rolesById = {};
  if (roleIds.length) {
    const { data: roles, error: rErr } = await supabase
      .from('roles')
      .select('id, title')
      .in('id', roleIds);
    if (rErr) {
      console.error('[dashboard/candidates] roles join error', rErr);
    } else {
      rolesById = Object.fromEntries(roles.map(r => [r.id, r.title]));
    }
  }

  // Map analysis_summary JSON into scores (tolerant of missing keys)
  const mapped = rows.map(r => {
    let resumeScore = null, interviewScore = null, overallScore = null;
    try {
      const a = r.analysis_summary || {};
      // Support both snake_case and the older keys we used
      resumeScore    = a.resume_score ?? a.resume ?? a.resume_match_percent ?? null;
      interviewScore = a.interview_score ?? a.interview ?? null;
      overallScore   = a.overall_score ?? a.overall ?? a.overall_resume_match_percent ?? null;
    } catch {}

    return {
      id: r.id,
      name: [r.first_name, r.last_name].filter(Boolean).join(' ') || '—',
      email: r.email || '—',
      role: rolesById[r.role_id] || '—',
      resume_score: isFinite(resumeScore) ? Number(resumeScore) : null,
      interview_score: isFinite(interviewScore) ? Number(interviewScore) : null,
      overall_score: isFinite(overallScore) ? Number(overallScore) : null,
      created_at: r.created_at,
      resume_url: r.resume_url || null,
      interview_video_url: r.interview_video_url || null,
      analysis_summary: r.analysis_summary || {}
    };
  });

  res.json({ items: mapped });
});

module.exports = router;
