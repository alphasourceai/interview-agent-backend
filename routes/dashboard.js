// routes/dashboard.js
// Direct-export Express router (no factory)

const express = require('express');
const { supabase } = require('../src/lib/supabaseClient');
const { requireAuth, withClientScope } = require('../src/middleware/auth');

const router = express.Router();

// Legacy stub to satisfy any old calls
router.get('/interviews', requireAuth, withClientScope, (_req, res) => {
  res.json({ items: [] });
});

// Candidates for the scoped client
router.get('/candidates', requireAuth, withClientScope, async (req, res) => {
  try {
    const clientId =
      req.client?.id ||
      req.clientScope?.defaultClientId ||
      req.query.client_id ||
      null;

    if (!clientId) return res.status(400).json({ error: 'client_id required' });

    // 1) Candidates
    const { data: rows, error } = await supabase
      .from('candidates')
      .select(
        'id, first_name, last_name, email, role_id, analysis_summary, resume_url, interview_video_url, created_at, status'
      )
      .eq('client_id', clientId)
      .order('created_at', { ascending: false });

    if (error) {
      console.error('[dashboard/candidates] supabase error', error);
      return res.status(500).json({ error: 'query failed' });
    }

    // 2) Join role titles
    const roleIds = Array.from(new Set((rows || []).map(r => r.role_id).filter(Boolean)));
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

    // 3) Normalize output
    const items = (rows || []).map(r => {
      let resumeScore = null, interviewScore = null, overallScore = null;
      try {
        const a = r.analysis_summary || {};
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
        analysis_summary: r.analysis_summary || {},
      };
    });

    res.json({ items });
  } catch (e) {
    console.error('[dashboard/candidates] unexpected', e);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
