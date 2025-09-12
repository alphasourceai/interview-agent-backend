// routes/dashboard.js
// Express router mounted at /dashboard

const express = require('express');
const { supabase } = require('../src/lib/supabaseClient');
const { requireAuth, withClientScope } = require('../src/middleware/auth');

const router = express.Router();

/**
 * GET /dashboard/interviews
 * Returns interviews for the scoped client — DB ONLY (no demo injection)
 * Output shape matches the frontend expectation:
 * {
 *   id, created_at, client_id,
 *   candidate: { id, name, email },
 *   role: { id, title, client_id } | null,
 *   video_url, transcript_url, analysis_url,
 *   has_video, has_transcript, has_analysis,
 *   resume_score, interview_score, overall_score,
 *   resume_analysis, interview_analysis,
 *   latest_report_url, report_generated_at
 * }
 */
router.get('/interviews', requireAuth, withClientScope, async (req, res) => {
  try {
    const clientId =
      req.client?.id ||
      req.clientScope?.defaultClientId ||
      req.query.client_id ||
      null;

    if (!clientId) {
      return res.status(400).json({ error: 'client_id required' });
    }

    // 1) Interviews (DB only)
    const { data: rows, error: iErr } = await supabase
      .from('interviews')
      .select(
        [
          'id',
          'created_at',
          'client_id',
          'candidate_id',
          'role_id',
          'video_url',
          'transcript_url',
          'analysis_url',
          'resume_score',
          'interview_score',
          'overall_score',
          'resume_analysis',
          'interview_analysis',
          'latest_report_url',
          'report_generated_at',
        ].join(', ')
      )
      .eq('client_id', clientId)
      .order('created_at', { ascending: false })
      .limit(500);

    if (iErr) {
      console.error('[dashboard/interviews] supabase error', iErr);
      return res.status(500).json({ error: 'query failed' });
    }

    const candIds = Array.from(new Set((rows || []).map(r => r.candidate_id).filter(Boolean)));
    const roleIds = Array.from(new Set((rows || []).map(r => r.role_id).filter(Boolean)));

    // 2) Candidates
    let candidatesById = {};
    if (candIds.length) {
      const { data: cands, error: cErr } = await supabase
        .from('candidates')
        .select('id, first_name, last_name, name, email')
        .in('id', candIds);
      if (cErr) {
        console.error('[dashboard/interviews] candidates join error', cErr);
      } else {
        candidatesById = Object.fromEntries(
          (cands || []).map(c => {
            const fullName =
              c.name ||
              [c.first_name, c.last_name].filter(Boolean).join(' ').trim() ||
              '';
            return [c.id, { id: c.id, name: fullName, email: c.email || '' }];
          })
        );
      }
    }

    // 3) Roles
    let rolesById = {};
    if (roleIds.length) {
      const { data: roles, error: rErr } = await supabase
        .from('roles')
        .select('id, title, client_id')
        .in('id', roleIds);
      if (rErr) {
        console.error('[dashboard/interviews] roles join error', rErr);
      } else {
        rolesById = Object.fromEntries(
          (roles || []).map(r => [r.id, { id: r.id, title: r.title, client_id: r.client_id }])
        );
      }
    }

    // 4) Normalize & return — NO demo data appended
    const items = (rows || []).map(r => {
      const candidate = candidatesById[r.candidate_id] || { id: r.candidate_id || null, name: '', email: '' };
      const role = r.role_id ? (rolesById[r.role_id] || null) : null;

      return {
        id: r.id,
        created_at: r.created_at,
        client_id: r.client_id,
        candidate,
        role,
        video_url: r.video_url || null,
        transcript_url: r.transcript_url || null,
        analysis_url: r.analysis_url || null,
        has_video: !!r.video_url,
        has_transcript: !!r.transcript_url,
        has_analysis: !!r.analysis_url,
        resume_score: isFinite(r.resume_score) ? Number(r.resume_score) : null,
        interview_score: isFinite(r.interview_score) ? Number(r.interview_score) : null,
        overall_score: isFinite(r.overall_score) ? Number(r.overall_score) : null,
        resume_analysis: r.resume_analysis || { experience: null, skills: null, education: null, summary: '' },
        interview_analysis: r.interview_analysis || { clarity: null, confidence: null, body_language: null },
        latest_report_url: r.latest_report_url || null,
        report_generated_at: r.report_generated_at || null,
      };
    });

    return res.json({ items });
  } catch (e) {
    console.error('[dashboard/interviews] unexpected', e);
    return res.status(500).json({ error: 'Server error' });
  }
});

/**
 * GET /dashboard/candidates
 * (unchanged from your current file)
 */
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
