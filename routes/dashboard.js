// routes/dashboard.js
'use strict';

const express = require('express');
const { createClient } = require('@supabase/supabase-js');

const router = express.Router();

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
}
const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

function scopedIds(req) {
  if (Array.isArray(req.clientIds) && req.clientIds.length) return req.clientIds;
  if (Array.isArray(req.client_memberships) && req.client_memberships.length) {
    return req.client_memberships.map(m => m.client_id || m.client_id_uuid).filter(Boolean);
  }
  return [];
}
const numOrNull = v => (Number.isFinite(Number(v)) ? Number(v) : null);

// GET /dashboard/interviews?client_id=...
router.get('/interviews', async (req, res) => {
  try {
    const scope = scopedIds(req);

    // Graceful defaults: if no scope or FE hasn’t chosen a client yet,
    // just return an empty list instead of 400.
    if (!scope.length) return res.json([]);

    const requested = req.query.client_id || scope[0]; // default to first scoped client
    if (!scope.includes(requested)) return res.json([]); // out of scope → empty

    const select = `
      id, created_at, candidate_id, role_id, client_id,
      video_url, transcript_url, analysis_url
    `;

    const { data: interviews, error } = await supabaseAdmin
      .from('interviews')
      .select(select)
      .eq('client_id', requested)
      .order('created_at', { ascending: false });

    if (error) return res.status(400).json({ error: error.message });

    // hydrate candidate and role title in two small queries to avoid complex joins
    const candidateIds = [...new Set((interviews || []).map(r => r.candidate_id).filter(Boolean))];
    const roleIds = [...new Set((interviews || []).map(r => r.role_id).filter(Boolean))];

    let candidatesById = {};
    if (candidateIds.length) {
      const { data: cRows } = await supabaseAdmin
        .from('candidates')
        .select('id, name, email')
        .in('id', candidateIds);
      candidatesById = Object.fromEntries((cRows || []).map(c => [c.id, c]));
    }

    let rolesById = {};
    if (roleIds.length) {
      const { data: rRows } = await supabaseAdmin
        .from('roles')
        .select('id, title')
        .in('id', roleIds);
      rolesById = Object.fromEntries((rRows || []).map(r => [r.id, r]));
    }

    // fetch latest report per interview in one go if possible
    const interviewIds = (interviews || []).map(r => r.id);
    let reportsByInterview = {};
    if (interviewIds.length) {
      const { data: repRows } = await supabaseAdmin
        .from('reports')
        .select('id, interview_id, resume_score, interview_score, overall_score, resume_breakdown, interview_breakdown, created_at')
        .in('interview_id', interviewIds)
        .order('created_at', { ascending: false });

      for (const r of repRows || []) {
        if (!reportsByInterview[r.interview_id]) reportsByInterview[r.interview_id] = r; // first is latest due to order
      }
    }

    const rows = (interviews || []).map(r => {
      const cand = candidatesById[r.candidate_id] || {};
      const role = rolesById[r.role_id] || {};
      const rep = reportsByInterview[r.id] || null;

      const resume_score = numOrNull(rep?.resume_score);
      const interview_score = numOrNull(rep?.interview_score);
      const overall_score =
        numOrNull(rep?.overall_score) ??
        (Number.isFinite(resume_score) && Number.isFinite(interview_score)
          ? Math.round((resume_score + interview_score) / 2)
          : null);

      return {
        id: r.id,
        created_at: r.created_at,
        client_id: r.client_id,
        candidate: { id: r.candidate_id, name: cand.name || '—', email: cand.email || '—' },
        role: { id: r.role_id, title: role.title || '—' },
        has_video: !!r.video_url,
        has_transcript: !!r.transcript_url,
        has_analysis: !!r.analysis_url,
        video_url: r.video_url || null,
        transcript_url: r.transcript_url || null,
        analysis_url: r.analysis_url || null,
        resume_score,
        interview_score,
        overall_score,
        resume_breakdown: rep?.resume_breakdown || {},
        interview_breakdown: rep?.interview_breakdown || {},
      };
    });

    // FE expects an array it can .map()
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
