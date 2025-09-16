// routes/dashboard.js
// Express router mounted at /dashboard

const express = require('express');
const { supabase } = require('../src/lib/supabaseClient');
const { requireAuth, withClientScope } = require('../src/middleware/auth');

const router = express.Router();

/**
 * GET /dashboard/interviews
 * DB-only, strictly scoped to the client's data.
 * Optional debug mode: add ?debug=1 to include a __meta block and emit server logs.
 */
router.get('/interviews', requireAuth, withClientScope, async (req, res) => {
  const DEBUG = String(req.query.debug || '') === '1';

  try {
    const clientId =
      req.client?.id ||
      req.clientScope?.defaultClientId ||
      req.query.client_id ||
      null;

    if (!clientId) {
      return res.status(400).json({ error: 'client_id required' });
    }

    // 1) Interviews (DB only) for this client.
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

    // 2) Candidates (restrict to SAME client)
    let candidatesById = {};
    if (candIds.length) {
      const { data: cands, error: cErr } = await supabase
        .from('candidates')
        .select('id, first_name, last_name, name, email, client_id')
        .in('id', candIds)
        .eq('client_id', clientId); // ensure same client

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

    // 3) Roles (also restrict to SAME client for consistency)
    let rolesById = {};
    if (roleIds.length) {
      const { data: roles, error: rErr } = await supabase
        .from('roles')
        .select('id, title, client_id')
        .in('id', roleIds)
        .eq('client_id', clientId);

      if (rErr) {
        console.error('[dashboard/interviews] roles join error', rErr);
      } else {
        rolesById = Object.fromEntries(
          (roles || []).map(r => [r.id, { id: r.id, title: r.title, client_id: r.client_id }])
        );
      }
    }

    // 4) Normalize & return — drop rows whose candidate isn't resolvable for this client
    const filtered = (rows || []).filter(r => r.candidate_id && candidatesById[r.candidate_id]);
    const items = filtered.map(r => {
      const candidate = candidatesById[r.candidate_id];
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

    // Stamp a header so we can confirm the live build easily
    res.set('X-IA-Route', 'interviews-strict-2025-09-12d');

    if (DEBUG) {
      // Emit concise server logs to help verify what's happening
      console.log('[dashboard/interviews][debug]', {
        clientId,
        totalInterviews: rows?.length || 0,
        uniqueCandidateIds: candIds.length,
        candidatesLoaded: Object.keys(candidatesById).length,
        rolesLoaded: Object.keys(rolesById).length,
        returnedItems: items.length,
        sampleInterviewIds: (rows || []).slice(0, 3).map(r => r.id),
        sampleReturnedIds: items.slice(0, 3).map(r => r.id),
      });

      return res.json({
        items,
        __meta: {
          clientId,
          totalInterviews: rows?.length || 0,
          uniqueCandidateIds: candIds.length,
          candidatesLoaded: Object.keys(candidatesById).length,
          rolesLoaded: Object.keys(rolesById).length,
          returnedItems: items.length,
        }
      });
    }

    return res.json({ items });
  } catch (e) {
    console.error('[dashboard/interviews] unexpected', e);
    res.set('X-IA-Route', 'interviews-strict-2025-09-12d');
    return res.status(500).json({ error: 'Server error' });
  }
});

/**
 * GET /dashboard/candidates
 * DB-only, scoped to client_id.
 */
router.get('/candidates', requireAuth, withClientScope, async (req, res) => {
  const DEBUG = String(req.query.debug || '') === '1';

  try {
    const clientId =
      req.client?.id ||
      req.clientScope?.defaultClientId ||
      req.query.client_id ||
      null;

    if (!clientId) return res.status(400).json({ error: 'client_id required' });

    // 1) Candidates for this client
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

    // 2) Join role titles (no extra client filter needed if roles are unique, but safe if you prefer)
    const roleIds = Array.from(new Set((rows || []).map(r => r.role_id).filter(Boolean)));
    let rolesById = {};
    if (roleIds.length) {
      const { data: roles, error: rErr } = await supabase
        .from('roles')
        .select('id, title, client_id')
        .in('id', roleIds)
        .eq('client_id', clientId);

      if (rErr) {
        console.error('[dashboard/candidates] roles join error', rErr);
      } else {
        rolesById = Object.fromEntries((roles || []).map(r => [r.id, r.title]));
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

    res.set('X-IA-Route', 'candidates-strict-2025-09-12d');

    if (DEBUG) {
      console.log('[dashboard/candidates][debug]', {
        clientId,
        totalCandidates: rows?.length || 0,
        rolesLoaded: Object.keys(rolesById).length,
        returnedItems: items.length,
        sampleIds: items.slice(0, 3).map(i => i.id),
      });
      return res.json({
        items,
        __meta: {
          clientId,
          totalCandidates: rows?.length || 0,
          rolesLoaded: Object.keys(rolesById).length,
          returnedItems: items.length,
        }
      });
    }

    return res.json({ items });
  } catch (e) {
    console.error('[dashboard/candidates] unexpected', e);
    res.set('X-IA-Route', 'candidates-strict-2025-09-12d');
    return res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
