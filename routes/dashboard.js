// routes/dashboard.js
const express = require('express');
const { supabase } = require('../src/lib/supabaseClient');
const { requireAuth, withClientScope } = require('../src/middleware/auth');
const router = express.Router();

/**
 * GET /dashboard/rows
 * One row per candidate for the scoped client.
 * - role title from roles
 * - latest report (scores + analyses + url)
 * - latest interview (video/transcript/analysis_url)
 */
router.get('/rows', requireAuth, withClientScope, async (req, res) => {
  try {
    const clientId =
      req.client?.id ||
      req.clientScope?.defaultClientId ||
      req.query.client_id || null;

    if (!clientId) return res.status(400).json({ error: 'client_id required' });

    // Candidates
    const { data: cands, error: cErr } = await supabase
      .from('candidates')
      .select('id, first_name, last_name, name, email, role_id, client_id, created_at')
      .eq('client_id', clientId)
      .order('created_at', { ascending: false })
      .limit(500);
    if (cErr) { console.error('[rows] candidates', cErr); return res.status(500).json({ error: 'query failed' }); }

    const candIds = (cands || []).map(c => c.id);
    const roleIds = Array.from(new Set((cands || []).map(c => c.role_id).filter(Boolean)));

    // Roles
    let rolesById = {};
    if (roleIds.length) {
      const { data: roles, error } = await supabase
        .from('roles')
        .select('id, title, client_id')
        .in('id', roleIds)
        .eq('client_id', clientId);
      if (!error && roles) {
        rolesById = Object.fromEntries(roles.map(r => [r.id, { id: r.id, title: r.title, client_id: r.client_id }]));
      } else if (error) { console.error('[rows] roles', error); }
    }

    // Latest report per candidate
    let latestReportByCand = {};
    if (candIds.length) {
      const { data: reports, error } = await supabase
        .from('reports')
        .select('id, candidate_id, role_id, resume_score, interview_score, overall_score, resume_analysis, interview_analysis, created_at, pdf_url, latest_report_url, report_generated_at')
        .eq('client_id', clientId)
        .in('candidate_id', candIds);
      if (!error && reports) {
        for (const r of reports) {
          const prev = latestReportByCand[r.candidate_id];
          if (!prev || new Date(r.created_at) > new Date(prev.created_at)) {
            latestReportByCand[r.candidate_id] = r;
          }
        }
      } else if (error) { console.error('[rows] reports', error); }
    }

    // Latest interview per candidate
    let latestInterviewByCand = {};
    if (candIds.length) {
      const { data: ints, error } = await supabase
        .from('interviews')
        .select('id, candidate_id, role_id, video_url, transcript_url, analysis_url, created_at')
        .eq('client_id', clientId)
        .in('candidate_id', candIds);
      if (!error && ints) {
        for (const iv of ints) {
          const prev = latestInterviewByCand[iv.candidate_id];
          if (!prev || new Date(iv.created_at) > new Date(prev.created_at)) {
            latestInterviewByCand[iv.candidate_id] = iv;
          }
        }
      } else if (error) { console.error('[rows] interviews', error); }
    }

    // Normalize
    const items = (cands || []).map(c => {
      const fullName = c.name || [c.first_name, c.last_name].filter(Boolean).join(' ').trim() || '';
      const role = c.role_id ? (rolesById[c.role_id] || null) : null;
      const rep  = latestReportByCand[c.id] || {};
      const iv   = latestInterviewByCand[c.id] || {};

      const resumeScore    = Number.isFinite(rep.resume_score)    ? Number(rep.resume_score)    : null;
      const interviewScore = Number.isFinite(rep.interview_score) ? Number(rep.interview_score) : null;
      const overallScore   = Number.isFinite(rep.overall_score)   ? Number(rep.overall_score)   : null;

      return {
        id: c.id,                             // <- candidate id
        created_at: c.created_at,
        client_id: c.client_id,

        candidate: { id: c.id, name: fullName, email: c.email || '' },
        role,                                  // { id,title,client_id } | null

        // latest interview bits
        latest_interview_id: iv.id || null,
        video_url: iv.video_url || null,
        transcript_url: iv.transcript_url || null,
        analysis_url: iv.analysis_url || null,
        has_video: !!iv.video_url,
        has_transcript: !!iv.transcript_url,
        has_analysis: !!iv.analysis_url,

        // latest report bits
        latest_report_id: rep.id || null,
        resume_score: resumeScore,
        interview_score: interviewScore,
        overall_score: overallScore,
        resume_analysis: rep.resume_analysis || { experience: null, skills: null, education: null, summary: '' },
        interview_analysis: rep.interview_analysis || { clarity: null, confidence: null, body_language: null },
        latest_report_url: rep.pdf_url || rep.latest_report_url || null,
        report_generated_at: rep.report_generated_at || rep.created_at || null,
      };
    });

    res.set('X-IA-Debug', `rows v1 | client=${clientId} | items=${items.length}`);
    return res.json({ items });
  } catch (e) {
    console.error('[rows] unexpected', e);
    return res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
