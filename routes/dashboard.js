// routes/dashboard.js (drop in)
// Express router mounted at /dashboard

const express = require('express');
const { supabase } = require('../src/lib/supabaseClient');
const { requireAuth, withClientScope } = require('../src/middleware/auth');


const router = express.Router();

function getRequestId(req) {
  return (
    (req.headers['x-request-id'] || req.headers['x-correlation-id'] || req.headers['x-amzn-trace-id'] || null) &&
    String(req.headers['x-request-id'] || req.headers['x-correlation-id'] || req.headers['x-amzn-trace-id'])
  ) || null;
}

router.use((req, res, next) => {
  const start = Date.now();
  const request_id = getRequestId(req);

  // Avoid cached dashboard payloads while we debug wiring.
  res.set('Cache-Control', 'no-store, max-age=0');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  res.set('Surrogate-Control', 'no-store');

  console.log('[dashboard] hit', {
    request_id,
    method: req.method,
    path: req.originalUrl,
    client_id: req.query?.client_id || null,
    scope_client_id: req.client?.id || req.clientScope?.defaultClientId || null
  });

  res.on('finish', () => {
    console.log('[dashboard] done', {
      request_id,
      method: req.method,
      path: req.originalUrl,
      status: res.statusCode,
      ms: Date.now() - start
    });
  });

  next();
});

router.get('/ping', (req, res) => {
  return res.json({
    ok: true,
    ts: new Date().toISOString(),
    build_id: process.env.RENDER_GIT_COMMIT || process.env.GIT_COMMIT || null
  });
});

const DAILY_ROOM_RE = /(^https?:\/\/)?([a-z0-9-]+\.)?(tavus\.daily\.co|c\.daily\.co)(\/|\?|$)/i;
function isDailyRoomUrl(url) {
  return !!url && DAILY_ROOM_RE.test(String(url));
}

function parseJsonObject(value) {
  if (!value) return null;
  if (typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
  return null;
}

function toFiniteOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function getTranscriptOverall(interviewRow) {
  const scores = parseJsonObject(interviewRow?.transcript_scores);
  return scores ? toFiniteOrNull(scores.overall) : null;
}

function getPerceptionShape(interviewRow) {
  const scores = parseJsonObject(interviewRow?.perception_scores) || {};
  const clarity = toFiniteOrNull(scores.clarity);
  const confidence = toFiniteOrNull(scores.confidence);
  const engagementCanonical = toFiniteOrNull(scores.engagement);
  const engagementFallback = toFiniteOrNull(scores.body_language);
  const engagement = engagementCanonical !== null ? engagementCanonical : engagementFallback;
  const presentKeys = [];
  if (clarity !== null) presentKeys.push('clarity');
  if (confidence !== null) presentKeys.push('confidence');
  if (engagementCanonical !== null) presentKeys.push('engagement');
  else if (engagementFallback !== null) presentKeys.push('body_language');
  return { clarity, confidence, engagement, presentKeys, raw: scores };
}

function hasCanonicalAnalysis(interviewRow) {
  const transcriptOverall = getTranscriptOverall(interviewRow);
  if (transcriptOverall !== null) return true;
  const summary = typeof interviewRow?.interview_summary === 'string' ? interviewRow.interview_summary.trim() : '';
  if (summary) return true;
  const { clarity, confidence, engagement, raw } = getPerceptionShape(interviewRow);
  if (clarity !== null || confidence !== null || engagement !== null) return true;
  const legacyBody = toFiniteOrNull(raw?.body_language);
  return legacyBody !== null;
}

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
    const request_id = getRequestId(req);
    const debug = String(req.query.debug || '') === '1';
    console.log('[dashboard/rows] hit', {
      method: req.method,
      path: req.originalUrl,
      request_id,
      client_id: req.query.client_id || null
    });

    const clientId =
      req.client?.id ||
      req.clientScope?.defaultClientId ||
      req.query.client_id ||
      null;

    if (!clientId) return res.status(400).json({ error: 'client_id required' });

    // 1) Candidates for this client
    const { data: cands, error: cErr } = await supabase
      .from('candidates')
      .select('id, first_name, last_name, name, email, role_id, created_at, client_id, analysis_summary')
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
        .select([
          'id',
          'candidate_id',
          'client_id',
          'created_at',
          'video_url',
          'transcript_url',
          'transcript',
          'analysis_url',
          'analysis',
          'perception_scores',
          'transcript_scores',
          'interview_summary',
          'unanswered_candidate_questions'
        ].join(', '))
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
          'created_at',
          'client_id',
          'candidate_id',
          'role_id',
          'resume_score',
          'interview_score',
          'overall_score',
          'resume_breakdown',
          'interview_breakdown',
          'analysis',
          'report_url',
          'unanswered_candidate_questions',
          'candidate_external_id',
        ].join(', '))
        .eq('client_id', clientId)
        .in('candidate_id', candIds)
        .order('created_at', { ascending: false });

      if (repErr) {
        console.error('[dashboard/rows] reports error', {
          request_id,
          client_id: clientId,
          code: repErr.code,
          message: repErr.message,
          details: repErr.details,
          hint: repErr.hint
        });
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

      const parsed = parseJsonObject(c?.analysis_summary) || {};
      const rs = parsed.resume_score ?? parsed.resume ?? parsed.resume_match_percent ?? parsed.resumeMatchPercent ?? null;
      const resume_score = Number.isFinite(Number(rs)) ? Number(rs) : null;
      const interview_score = isFinite(rep?.interview_score) ? Number(rep.interview_score) : null;
      const repOverallScore = isFinite(rep?.overall_score) ? Number(rep.overall_score) : null;

      const resume_summary =
        (typeof parsed.summary === 'string' && parsed.summary) ||
        (typeof parsed.resume_summary === 'string' && parsed.resume_summary) ||
        (typeof parsed.resumeSummary === 'string' && parsed.resumeSummary) ||
        (typeof parsed.resume_analysis?.summary === 'string' && parsed.resume_analysis.summary) ||
        '';
      const resume_analysis = {
        experience: Number.isFinite(Number(parsed.experience_match_percent ?? parsed.experienceMatchPercent)) ? Number(parsed.experience_match_percent ?? parsed.experienceMatchPercent) : null,
        skills:     Number.isFinite(Number(parsed.skills_match_percent ?? parsed.skillsMatchPercent)) ? Number(parsed.skills_match_percent ?? parsed.skillsMatchPercent) : null,
        education:  Number.isFinite(Number(parsed.education_match_percent ?? parsed.educationMatchPercent)) ? Number(parsed.education_match_percent ?? parsed.educationMatchPercent) : null,
        summary: resume_summary
      };
      const perception = getPerceptionShape(iv);
      const interviewSummary = typeof iv?.interview_summary === 'string' ? iv.interview_summary : '';
      const interview_analysis = {
        clarity: perception.clarity,
        confidence: perception.confidence,
        engagement: perception.engagement,
        summary: interviewSummary
      };

      // PDF URL preference: explicit latest_report_url, else report_url
      const latest_report_url = rep?.latest_report_url || rep?.report_url || null;
      const safeVideoUrl = iv?.video_url && !isDailyRoomUrl(iv.video_url) ? iv.video_url : null;
      const hasTranscript = !!iv?.transcript;
      const transcriptOverall = getTranscriptOverall(iv);
      const overall_score =
        Number.isFinite(resume_score) && Number.isFinite(transcriptOverall)
          ? Math.max(0, Math.min(100, Math.round((resume_score + transcriptOverall) / 2)))
          : Number.isFinite(transcriptOverall)
            ? Math.max(0, Math.min(100, Math.round(transcriptOverall)))
            : Number.isFinite(resume_score)
              ? Math.max(0, Math.min(100, Math.round(resume_score)))
              : Number.isFinite(repOverallScore)
                ? Math.max(0, Math.min(100, Math.round(repOverallScore)))
                : null;
      const canonicalHasAnalysis = hasCanonicalAnalysis(iv);

      return {
        // row identity is the candidate (FE now uses latest_interview_id for actions)
        id: c.id,
        created_at: c.created_at,
        client_id: c.client_id,

        candidate: { id: c.id, name: fullName, email: c.email || '' },
        role, // { id, title, client_id } | null

        // latest interview bits for the expanded area + transcript button
        latest_interview_id: iv?.id || null,
        video_url: safeVideoUrl,
        transcript_url: iv?.transcript_url || null,
        analysis_url: iv?.analysis_url || null,
        transcript_scores: parseJsonObject(iv?.transcript_scores) || null,
        perception_scores: parseJsonObject(iv?.perception_scores) || null,
        interview_summary: interviewSummary || '',
        unanswered_candidate_questions: Array.isArray(iv?.unanswered_candidate_questions) ? iv.unanswered_candidate_questions : [],
        transcript: typeof iv?.transcript === 'string' ? iv.transcript : '',
        has_video: !!safeVideoUrl,
        has_transcript: hasTranscript,
        has_analysis: canonicalHasAnalysis,

        // report-driven bits
        resume_score,
        interview_score: transcriptOverall ?? null,
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
      .select('id, created_at, client_id, candidate_id, role_id, video_url, transcript_url, transcript, analysis_url, resume_score, interview_score, overall_score, resume_analysis, interview_analysis, latest_report_url, report_generated_at, perception_scores, transcript_scores, interview_summary, unanswered_candidate_questions')
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
      .map(r => {
        const safeVideoUrl = r.video_url && !isDailyRoomUrl(r.video_url) ? r.video_url : null;
        const hasTranscript = !!r.transcript_url || !!r.transcript;
        const transcriptOverall = getTranscriptOverall(r);
        const perception = getPerceptionShape(r);
        const interviewSummary = typeof r?.interview_summary === 'string' ? r.interview_summary : '';
        const canonicalHasAnalysis = hasCanonicalAnalysis(r);
        return {
        id: r.id,
        created_at: r.created_at,
        client_id: r.client_id,
        candidate: candidatesById[r.candidate_id],
        role: r.role_id ? (rolesById[r.role_id] || null) : null,
        video_url: safeVideoUrl,
        transcript_url: r.transcript_url || null,
        transcript_scores: parseJsonObject(r.transcript_scores) || null,
        perception_scores: parseJsonObject(r.perception_scores) || null,
        interview_summary: interviewSummary || '',
        unanswered_candidate_questions: Array.isArray(r.unanswered_candidate_questions) ? r.unanswered_candidate_questions : [],
        analysis_url: r.analysis_url || null,
        has_video: !!safeVideoUrl,
        has_transcript: hasTranscript,
        has_analysis: canonicalHasAnalysis,
        resume_score: isFinite(r.resume_score) ? Number(r.resume_score) : null,
        interview_score: transcriptOverall ?? null,
        overall_score: isFinite(r.overall_score) ? Number(r.overall_score) : null,
        resume_analysis: r.resume_analysis || { experience: null, skills: null, education: null, summary: '' },
        interview_analysis: {
          clarity: perception.clarity,
          confidence: perception.confidence,
          engagement: perception.engagement,
          summary: interviewSummary
        },
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
