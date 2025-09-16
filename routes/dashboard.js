// routes/dashboard.js
// Express router mounted at /dashboard

const express = require('express');
const { supabase } = require('../src/lib/supabaseClient');
const { requireAuth, withClientScope } = require('../src/middleware/auth');

const router = express.Router();

/**
 * GET /dashboard/rows
 * One row per candidate (for the scoped client).
 * - Top-level cells come from candidates (+ role title)
 * - Scores + analyses come from the latest report for that candidate
 * - Video/Transcript/Analysis URLs come from the latest interview for that candidate
 * - FE uses latest_interview_id for Transcript/PDF actions
 */
router.get('/rows', requireAuth, withClientScope, async (req, res) => {
  try {
    const clientId =
      req.client?.id ||
      req.clientScope?.defaultClientId ||
      req.query.client_id ||
      null;

    if (!clientId) return res.status(400).json({ error: 'client_id required' });

    // 1) Candidates for this client
    const { data: cands, error: cErr } = await supabase
      .from('candidates')
      .select('id, first_name, last_name, name, email, role_id, created_at, client_id')
      .eq('client_id', clientId)
      .order('created_at', { ascending: false })
      .limit(1000);

    if (cErr) {
      console.error('[dashboard/rows] candidates error', cErr);
      return res.status(500).json({ error: 'query failed (candidates)' });
    }

    const candIds = Array.from(new Set((cands || []).map(c => c.id)));
    const roleIds = Array.from(new Set((cands || []).map(c => c.role_id).filter(Boolean)));

    // 2) Roles (title)
    let rolesById = {};
    if (roleIds.length) {
      const { data: roles, error: rErr } = await supabase
        .from('roles')
        .select('id, title, client_id')
        .in('id', roleIds)
        .eq('client_id', clientId);
      if (rErr) {
        console.error('[dashboard/rows] roles error', rErr);
      } else {
        rolesById = Object.fromEntries(
          (roles || []).map(r => [r.id, { id: r.id, title: r.title, client_id: r.client_id }])
        );
      }
    }

    // 3) Latest interview per candidate (within same client)
    let latestInterviewByCand = {};
    if (candIds.length) {
      const { data: ivs, error: iErr } = await supabase
        .from('interviews')
        .select('id, candidate_id, client_id, created_at, video_url, transcript_url, analysis_url')
        .eq('client_id', clientId)
        .in('candidate_id', candIds)
        .order('created_at', { ascending: false });

      if (iErr) {
        console.error('[dashboard/rows] interviews error', iErr);
      } else {
        for (const iv of ivs || []) {
          const k = iv.candidate_id;
          if (!latestInterviewByCand[k]) latestInterviewByCand[k] = iv;
          // first seen is latest because list is desc
        }
      }
    }

    // 4) Latest report per candidate (within same client)
    // If your reports table uses different column names, adjust here.
    let latestReportByCand = {};
    if (candIds.length) {
      const { data: reps, error: repErr } = await supabase
        .from('reports')
        .select([
          'id',
          'candidate_id',
          'interview_id',
          'client_id',
          'created_at',
          'resume_score',
          'interview_score',
          'overall_score',
          'resume_analysis',
          'interview_analysis',
          // common names I've seen/used for a public PDF URL:
          'report_url',
          'latest_report_url',
        ].join(', '))
        .eq('client_id', clientId)
        .in('candidate_id', candIds)
        .order('created_at', { ascending: false });

      if (repErr) {
        console.error('[dashboard/rows] reports error', repErr);
      } else {
        for (const r of reps || []) {
          const k = r.candidate_id;
          if (!latestReportByCand[k]) latestReportByCand[k] = r; // first is latest
        }
      }
    }

    // 5) Normalize: one row per candidate
    const items = (cands || []).map(c => {
      const fullName =
        c.name ||
        [c.first_name, c.last_name].filter(Boolean).join(' ').trim() ||
        '';

      const role = c.role_id ? (rolesById[c.role_id] || null) : null;
      const iv = latestInterviewByCand[c.id] || null;
      const rep = latestReportByCand[c.id] || null;

      // Scores + analyses from latest report (if present)
      const resume_score    = isFinite(rep?.resume_score)    ? Number(rep.resume_score)    : null;
      const interview_score = isFinite(rep?.interview_score) ? Number(rep.interview_score) : null;
      const overall_score   = isFinite(rep?.overall_score)   ? Number(rep.overall_score)   : null;

      const resume_analysis = rep?.resume_analysis || { experience: null, skills: null, education: null, summary: '' };
      const interview_analysis = rep?.interview_analysis || { clarity: null, confidence: null, body_language: null };

      // PDF URL preference: explicit latest_report_url, else report_url
      const latest_report_url = rep?.latest_report_url || rep?.report_url || null;

      return {
        // row identity is the candidate (FE now uses latest_interview_id for actions)
        id: c.id,
        created_at: c.created_at,
        client_id: c.client_id,

        candidate: { id: c.id, name: fullName, email: c.email || '' },
        role, // { id, title, client_id } | null

        // latest interview bits for the expanded area + transcript button
        latest_interview_id: iv?.id || null,
        video_url: iv?.video_url || null,
        transcript_url: iv?.transcript_url || null,
        analysis_url: iv?.analysis_url || null,
        has_video: !!iv?.video_url,
        has_transcript: !!iv?.transcript_url,
        has_analysis: !!iv?.analysis_url,

        // report-driven bits
        resume_score,
        interview_score,
        overall_score,
        resume_analysis,
        interview_analysis,
        latest_report_url,
        report_generated_at: rep?.created_at || null,
      };
    });

    return res.json({ items });
  } catch (e) {
    console.error('[dashboard/rows] unexpected', e);
    return res.status(500).json({ error: 'Server error' });
  }
});

/**
 * (Keep these existing endpoints in case other pages still use them)
 */
router.get('/interviews', requireAuth, withClientScope, async (req, res) => {
  try {
    const clientId =
      req.client?.id ||
      req.clientScope?.defaultClientId ||
      req.query.client_id ||
      null;

    if (!clientId) return res.status(400).json({ error: 'client_id required' });

    const { data: rows, error: iErr } = await supabase
      .from('interviews')
      .select('id, created_at, client_id, candidate_id, role_id, video_url, transcript_url, analysis_url, resume_score, interview_score, overall_score, resume_analysis, interview_analysis, latest_report_url, report_generated_at')
      .eq('client_id', clientId)
      .order('created_at', { ascending: false })
      .limit(500);

    if (iErr) {
      console.error('[dashboard/interviews] supabase error', iErr);
      return res.status(500).json({ error: 'query failed' });
    }

    const candIds = Array.from(new Set((rows || []).map(r => r.candidate_id).filter(Boolean)));
    const roleIds = Array.from(new Set((rows || []).map(r => r.role_id).filter(Boolean)));

    let candidatesById = {};
    if (candIds.length) {
      const { data: cands, error: cErr } = await supabase
        .from('candidates')
        .select('id, first_name, last_name, name, email, client_id')
        .in('id', candIds)
        .eq('client_id', clientId);
      if (!cErr) {
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

    let rolesById = {};
    if (roleIds.length) {
      const { data: roles } = await supabase
        .from('roles')
        .select('id, title, client_id')
        .in('id', roleIds)
        .eq('client_id', clientId);
      rolesById = Object.fromEntries(
        (roles || []).map(r => [r.id, { id: r.id, title: r.title, client_id: r.client_id }])
      );
    }

    const items = (rows || [])
      .filter(r => r.candidate_id && candidatesById[r.candidate_id])
      .map(r => ({
        id: r.id,
        created_at: r.created_at,
        client_id: r.client_id,
        candidate: candidatesById[r.candidate_id],
        role: r.role_id ? (rolesById[r.role_id] || null) : null,
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
      }));

    return res.json({ items });
  } catch (e) {
    console.error('[dashboard/interviews] unexpected', e);
    return res.status(500).json({ error: 'Server error' });
  }
});

router.get('/candidates', requireAuth, withClientScope, async (req, res) => {
  try {
    const clientId =
      req.client?.id ||
      req.clientScope?.defaultClientId ||
      req.query.client_id ||
      null;

    if (!clientId) return res.status(400).json({ error: 'client_id required' });

    const { data: rows, error } = await supabase
      .from('candidates')
      .select('id, first_name, last_name, email, role_id, analysis_summary, resume_url, interview_video_url, created_at, status')
      .eq('client_id', clientId)
      .order('created_at', { ascending: false });

    if (error) {
      console.error('[dashboard/candidates] supabase error', error);
      return res.status(500).json({ error: 'query failed' });
    }

    const roleIds = Array.from(new Set((rows || []).map(r => r.role_id).filter(Boolean)));
    let rolesById = {};
    if (roleIds.length) {
      const { data: roles } = await supabase
        .from('roles')
        .select('id, title')
        .in('id', roleIds)
        .eq('client_id', clientId);
      rolesById = Object.fromEntries((roles || []).map(r => [r.id, r.title]));
    }

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
