const router = require('express').Router();
const { htmlToPdf } = require('../utils/pdfRenderer');
const { buildCandidateReportHtml } = require('../utils/renderCandidateReport');
const { createClient } = require('@supabase/supabase-js');
const Sentry = require('@sentry/node');

// Supabase Admin (for loading report data + uploading PDFs)
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
const REPORTS_BUCKET = process.env.REPORTS_BUCKET || 'reports';
const supabaseAdmin = (SUPABASE_URL && SUPABASE_SERVICE_KEY)
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, { auth: { persistSession: false } })
  : null;

// Signed URL defaults
const DEFAULT_SIGNED_SECS = 90; // short-lived; FE will open immediately
const MIN_SIGNED_SECS = 15;
const MAX_SIGNED_SECS = 600;

// Extract a storage key from a Supabase public/signed URL or return as-is if already a key
function keyFromUrl(url) {
  if (!url) return null;
  try {
    // public: .../storage/v1/object/public/{bucket}/{key...}
    const pubMarker = `/storage/v1/object/public/${REPORTS_BUCKET}/`;
    const signMarker = `/storage/v1/object/sign/${REPORTS_BUCKET}/`;
    const pubIdx = url.indexOf(pubMarker);
    if (pubIdx !== -1) {
      return url.substring(pubIdx + pubMarker.length);
    }
    const signIdx = url.indexOf(signMarker);
    if (signIdx !== -1) {
      // strip any token/query after the key
      const after = url.substring(signIdx + signMarker.length);
      const q = after.indexOf('?');
      return q === -1 ? after : after.substring(0, q);
    }
    // If it looks like a bare key (no scheme and no storage path), just return it
    if (!/^https?:\/\//i.test(url)) return url;
  } catch (_) {}
  return null;
}

// Lightweight health check to verify router is mounted
router.get('/preview-health', (req, res) => {
  res.json({ ok: true, at: new Date().toISOString() });
});

function extractData(body) {
  // Accept either { data: {...} } or raw {...}
  if (body && typeof body === 'object' && body.data && typeof body.data === 'object') {
    return body.data;
  }
  return body || {};
}

// HTML preview for quick layout checks (no PDF)
// POST /api/reports/preview-html
router.post('/preview-html', async (req, res) => {
  try {
    const data = extractData(req.body);
    const html = buildCandidateReportHtml(data);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.status(200).send(html);
  } catch (err) {
    console.error('[reports/html-preview] error:', err);
    if (process.env.SENTRY_ENABLED === '1' && process.env.SENTRY_DSN) {
      Sentry.captureException(err, { tags: { endpoint: '/reports/preview-html' } });
    }
    return res.status(500).json({ error: 'HTML render failed' });
  }
});

router.post('/preview-pdf', async (req, res) => {
  try {
    const data = extractData(req.body);
    const html = buildCandidateReportHtml(data);
    const pdf = await htmlToPdf(html);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline; filename="candidate-report.pdf"');
    return res.send(pdf);
  } catch (err) {
    console.error('[reports/preview-pdf] error:', err);
    if (process.env.SENTRY_ENABLED === '1' && process.env.SENTRY_DSN) {
      Sentry.captureException(err, { tags: { endpoint: '/reports/preview-pdf' } });
    }
    res.status(500).json({ error: 'PDF render failed' });
  }
});

async function handleGenerate(req, res) {
  try {
    if (process.env.SENTRY_ENABLED === '1' && process.env.SENTRY_DSN) {
      Sentry.setTag('endpoint', '/reports/generate');
      Sentry.addBreadcrumb({ category: 'reports', level: 'info', message: 'generate:start' });
    }
    if (!supabaseAdmin) {
      return res.status(500).json({ error: 'Storage not configured (missing SUPABASE_URL/SUPABASE_SERVICE_KEY)' });
    }

    const { candidate_id, report_id, interview_id } = req.body || {};
    if (!candidate_id && !report_id) {
      return res.status(400).json({ error: 'candidate_id or report_id is required' });
    }

    // 1) Load report row
    let reportRow = null;
    if (report_id) {
      const { data, error } = await supabaseAdmin
        .from('reports')
        .select('id, created_at, candidate_id, role_id, resume_score, interview_score, overall_score, interview_breakdown, resume_breakdown, analysis, unanswered_candidate_questions')
        .eq('id', report_id)
        .maybeSingle();
      if (error) throw error;
      reportRow = data;
    } else {
      const { data, error } = await supabaseAdmin
        .from('reports')
        .select('id, created_at, candidate_id, role_id, resume_score, interview_score, overall_score, interview_breakdown, resume_breakdown, analysis, unanswered_candidate_questions')
        .eq('candidate_id', candidate_id)
        .order('created_at', { ascending: false })
        .limit(1);
      if (error) throw error;
      reportRow = (data && data[0]) || null;
    }

    if (!reportRow) {
      return res.status(404).json({ error: 'No report found for given id' });
    }
    if (process.env.SENTRY_ENABLED === '1' && process.env.SENTRY_DSN) {
      Sentry.addBreadcrumb({ category: 'db', level: 'info', message: 'reports:loaded', data: { report_id: reportRow.id, candidate_id: reportRow.candidate_id } });
    }

    // Load interview row used for current dashboard values.
    // Prefer explicit interview_id from FE; otherwise use latest by candidate.
    let latestInterview = null;
    {
      if (interview_id) {
        const { data: ivById, error: ivByIdErr } = await supabaseAdmin
          .from('interviews')
          .select('id, created_at, candidate_id, video_url, transcript_url, analysis_url, analysis, transcript_scores, perception_scores, interview_summary, unanswered_candidate_questions')
          .eq('id', interview_id)
          .maybeSingle();
        if (ivByIdErr) throw ivByIdErr;
        latestInterview = ivById || null;
      }
      if (!latestInterview) {
        const { data: ivs, error: ivErr } = await supabaseAdmin
          .from('interviews')
          .select('id, created_at, candidate_id, video_url, transcript_url, analysis_url, analysis, transcript_scores, perception_scores, interview_summary, unanswered_candidate_questions')
          .eq('candidate_id', reportRow.candidate_id)
          .order('created_at', { ascending: false })
          .limit(1);
        if (ivErr) throw ivErr;
        latestInterview = (ivs && ivs[0]) || null;
      }
    }
    if (process.env.SENTRY_ENABLED === '1' && process.env.SENTRY_DSN) {
      Sentry.addBreadcrumb({ category: 'db', level: 'info', message: 'interviews:loaded', data: { latest_interview_id: latestInterview ? latestInterview.id : null } });
    }

    // 2) Load candidate + role
    const [{ data: cand, error: candErr }, { data: role, error: roleErr }] = await Promise.all([
      supabaseAdmin.from('candidates').select('id,name,email,client_id,analysis_summary').eq('id', reportRow.candidate_id).maybeSingle(),
      supabaseAdmin.from('roles').select('id,title').eq('id', reportRow.role_id).maybeSingle(),
    ]);
    if (candErr) throw candErr;
    if (roleErr) throw roleErr;
    if (process.env.SENTRY_ENABLED === '1' && process.env.SENTRY_DSN) {
      Sentry.addBreadcrumb({ category: 'db', level: 'info', message: 'candidate:loaded', data: { candidate_id: cand ? cand.id : null } });
      Sentry.addBreadcrumb({ category: 'db', level: 'info', message: 'role:loaded', data: { role_id: role ? role.id : null } });
    }

    let client = null;
    if (cand?.client_id) {
      const { data: clientRow, error: clientErr } = await supabaseAdmin
        .from('clients')
        .select('id,name')
        .eq('id', cand.client_id)
        .maybeSingle();
      if (clientErr) throw clientErr;
      client = clientRow || null;
    }

    // Normalize to the template contract (flat keys expected by candidate-report.hbs)
    const analysis = reportRow.analysis || {};
    const rbRaw = analysis.interview || reportRow.interview_breakdown || {};
    const resumeRaw = analysis.resume || reportRow.resume_breakdown || {};

    // If shape is { scores: {...}, summary }, flatten to a single object
    const rb = rbRaw?.scores ? { ...rbRaw.scores, summary: rbRaw.summary } : rbRaw;
    const resume = resumeRaw?.scores ? { ...resumeRaw.scores, summary: resumeRaw.summary } : resumeRaw;

    const ivAnalysis = latestInterview?.analysis || null;
    const ivScores = (ivAnalysis && ivAnalysis.scores) || {};
    const reportLevelSummary = typeof reportRow?.analysis?.summary === 'string'
      ? reportRow.analysis.summary.trim()
      : '';

    const name = (cand?.name && cand.name.trim()) || 'Unknown Candidate';
    const email = (cand?.email && cand.email.trim()) || '';

    function coerceNumber(val) {
      if (val === null || val === undefined) return null;
      if (typeof val === 'number' && Number.isFinite(val)) {
        // Normalize 0–1 to 0–100 if clearly intended as a percent
        if (val > 0 && val <= 1) return Math.round(val * 100);
        return val;
      }
      if (typeof val === 'string') {
        // If it already contains a %, parse the numeric part and return
        if (val.includes('%')) {
          const m = val.match(/-?\d+(?:\.\d+)?/);
          return m ? Number(m[0]) : null;
        }
        // Otherwise parse and normalize 0–1 style strings
        const m = val.match(/-?\d+(?:\.\d+)?/);
        if (!m) return null;
        const n = Number(m[0]);
        if (!Number.isFinite(n)) return null;
        return (n > 0 && n <= 1) ? Math.round(n * 100) : n;
      }
      return null;
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

    function pickScore(obj, keys = []) {
      if (!obj || typeof obj !== 'object') return null;
      for (const k of keys) {
        if (Object.prototype.hasOwnProperty.call(obj, k)) {
          const n = coerceNumber(obj[k]);
          if (n !== null) return n;
        }
      }
      return null;
    }

    function pickScoreFromArray(arr, names = []) {
      if (!Array.isArray(arr)) return null;
      const keys = ['id','key','name','label','type'];
      for (const target of names) {
        for (const item of arr) {
          for (const k of keys) {
            if (item && typeof item === 'object' && typeof item[k] === 'string') {
              if (item[k].toLowerCase() === String(target).toLowerCase()) {
                const n = coerceNumber(item.score ?? item.value ?? item.percent ?? item.percentage);
                if (n !== null) return n;
              }
            }
          }
        }
      }
      return null;
    }

    // Deep search for a named score anywhere in a nested object/array
    function deepFindScore(source, names = []) {
      const seen = new Set();
      const targets = names.map((n) => String(n).toLowerCase());
      const valueAliases = ['score','value','percent','percentage','pct'];
      const idAliases = ['id','key','name','label','type'];
      const queue = [source];
      while (queue.length) {
        const cur = queue.shift();
        if (!cur || typeof cur !== 'object') continue;
        if (seen.has(cur)) continue;
        seen.add(cur);

        // 1) Direct property match: { experience: 0.82 } or { experience: "82%" }
        for (const [k, v] of Object.entries(cur)) {
          if (targets.includes(String(k).toLowerCase())) {
            const n = coerceNumber(v);
            if (n !== null) return n;
          }
        }
        // 2) Array of objects with id/name/label matching and a score/value/percent
        if (Array.isArray(cur)) {
          for (const item of cur) {
            if (!item || typeof item !== 'object') continue;
            for (const idk of idAliases) {
              const idv = item[idk];
              if (typeof idv === 'string' && targets.includes(idv.toLowerCase())) {
                for (const vk of valueAliases) {
                  const n = coerceNumber(item[vk]);
                  if (n !== null) return n;
                }
              }
            }
          }
        }
        // 3) Recurse into nested objects/arrays
        for (const v of Object.values(cur)) {
          if (v && typeof v === 'object') queue.push(v);
        }
      }
      return null;
    }

    // Helper to fetch the dashboard-normalized row
    async function getDashboardRowNormalized(clientId, candidateId) {
      try {
        const port = process.env.PORT || 10000;
        const url = `http://localhost:${port}/dashboard/rows?client_id=${encodeURIComponent(clientId)}&candidate_id=${encodeURIComponent(candidateId)}`;
        const resp = await fetch(url, { method: 'GET' });
        if (!resp || !resp.ok) return null;
        const json = await resp.json().catch(() => null);
        if (!json) return null;
        const item = Array.isArray(json?.items) ? json.items[0] : (Array.isArray(json) ? json[0] : json);
        return item || null;
      } catch (_) {
        return null;
      }
    }

    // Summaries (prefer report analysis → report-level → interview analysis)
    const resume_summary = (typeof resume.summary === 'string' && resume.summary.trim())
      ? resume.summary.trim()
      : 'Summary not available';

    const interview_summary =
      (typeof rb.summary === 'string' && rb.summary.trim())
        ? rb.summary.trim()
        : (reportLevelSummary ||
           (typeof ivAnalysis?.summary === 'string' && ivAnalysis.summary.trim()) ||
           'Summary not available');

    // Breakdowns with numeric coercion AND embedded summaries (template expects nested .summary)
    const resumeScores = (resume && (resume.scores || resume)) || {};

    const experienceScore =
      pickScore(resumeScores, ['experience','exp','experience_score','experienceScore','experiencePercent','experience_percentage','experience_pct','exp_pct','experience_match_percent']) ??
      pickScore(resume,      ['experience','exp','experience_score','experienceScore','experiencePercent','experience_percentage','experience_pct','exp_pct','experience_match_percent']) ??
      pickScoreFromArray(resumeRaw.categories || resumeRaw.items || resumeRaw.metrics || [], ['experience','exp']) ??
      deepFindScore(analysis.resume || resumeRaw, ['experience','exp']) ??
      0;

    const skillsScore =
      pickScore(resumeScores, ['skills','skill','skills_score','skillsScore','skillsPercent','skills_percentage','skills_pct','skill_pct','skills_match_percent']) ??
      pickScore(resume,       ['skills','skill','skills_score','skillsScore','skillsPercent','skills_percentage','skills_pct','skill_pct','skills_match_percent']) ??
      pickScoreFromArray(resumeRaw.categories || resumeRaw.items || resumeRaw.metrics || [], ['skills','skill']) ??
      deepFindScore(analysis.resume || resumeRaw, ['skills','skill']) ??
      0;

    const educationScore =
      pickScore(resumeScores, ['education','edu','education_score','educationScore','educationPercent','education_percentage','education_pct','edu_pct','education_match_percent']) ??
      pickScore(resume,       ['education','edu','education_score','educationScore','educationPercent','education_percentage','education_pct','edu_pct','education_match_percent']) ??
      pickScoreFromArray(resumeRaw.categories || resumeRaw.items || resumeRaw.metrics || [], ['education','edu']) ??
      deepFindScore(analysis.resume || resumeRaw, ['education','edu']) ??
      0;

    const resume_breakdown = {
      experience: experienceScore,
      skills: skillsScore,
      education: educationScore,
      summary: resume_summary
    };
    const transcriptScores = parseJsonObject(latestInterview?.transcript_scores) || {};
    const evidenceStrengthFromTranscript = coerceNumber(transcriptScores.confidence);
    const aiAidedRiskFromTranscript = typeof transcriptScores.ai_aided_risk === 'string' ? transcriptScores.ai_aided_risk.trim().toLowerCase() : '';
    const aiAidedRiskReasonFromTranscript = typeof transcriptScores.ai_aided_risk_reason === 'string' ? transcriptScores.ai_aided_risk_reason.trim() : '';

    const interview_breakdown = {
      clarity: Number.isFinite(Number(rb.clarity)) ? Number(rb.clarity)
              : (Number.isFinite(Number(ivScores.clarity)) ? Number(ivScores.clarity) : 0),
      confidence: Number.isFinite(Number(rb.confidence)) ? Number(rb.confidence)
                 : (Number.isFinite(Number(ivScores.confidence)) ? Number(ivScores.confidence) : 0),
      evidence_strength: evidenceStrengthFromTranscript !== null ? evidenceStrengthFromTranscript : 0,
      ai_aided_risk: aiAidedRiskFromTranscript,
      ai_aided_risk_reason: aiAidedRiskReasonFromTranscript,
      summary: interview_summary
    };

    // Optional targeted debug to inspect resume score sources
    if (process.env.DEBUG_REPORTS === '1') {
      const redact = (obj) => {
        try {
          return JSON.stringify(obj, (k, v) => {
            if (typeof v === 'string') {
              if (v.length > 400) return v.slice(0, 400) + '…';
              if (v.includes('@')) return v.replace(/[^@]+@/g, '***@');
            }
            return v;
          }, 2);
        } catch {
          return '[unserializable]';
        }
      };
      console.log('[pdf.debug] candidate_id=', reportRow.candidate_id, 'report_id=', reportRow.id);
      console.log('[pdf.debug] analysis.resume =', redact(reportRow?.analysis?.resume));
      console.log('[pdf.debug] resumeRaw      =', redact(resumeRaw));
      console.log('[pdf.debug] resume_breakdown (final) =', redact(resume_breakdown));
      console.log('[pdf.debug] interview_breakdown (final) =', redact(interview_breakdown));
    }

    let unansweredCandidateQuestions = Array.isArray(reportRow.unanswered_candidate_questions)
      ? reportRow.unanswered_candidate_questions.filter(q => typeof q === 'string' && q.trim())
      : [];

    // Use the same source-of-truth fields as /dashboard/rows.
    const candidateSummary = parseJsonObject(cand?.analysis_summary) || {};
    const resumeFromCandidate =
      coerceNumber(
        candidateSummary.resume_score ??
        candidateSummary.resume ??
        candidateSummary.resume_match_percent ??
        candidateSummary.resumeMatchPercent
      );
    const interviewFromTranscript = coerceNumber(transcriptScores.overall);
    const overallFromReport = coerceNumber(reportRow.overall_score);
    const overallFromCurrent =
      (resumeFromCandidate !== null && interviewFromTranscript !== null)
        ? Math.round((resumeFromCandidate + interviewFromTranscript) / 2)
        : null;

    if (resumeFromCandidate !== null) reportRow.resume_score = resumeFromCandidate;
    if (interviewFromTranscript !== null) reportRow.interview_score = interviewFromTranscript;
    if (overallFromReport !== null) {
      reportRow.overall_score = overallFromReport;
    } else if (overallFromCurrent !== null) {
      reportRow.overall_score = overallFromCurrent;
    }

    const resumeSummaryFromCandidate =
      (typeof candidateSummary.summary === 'string' && candidateSummary.summary.trim()) ||
      (typeof candidateSummary.resume_summary === 'string' && candidateSummary.resume_summary.trim()) ||
      (typeof candidateSummary.resumeSummary === 'string' && candidateSummary.resumeSummary.trim()) ||
      (typeof candidateSummary.resume_analysis?.summary === 'string' && candidateSummary.resume_analysis.summary.trim()) ||
      '';
    if (resumeSummaryFromCandidate) {
      resume_breakdown.summary = resumeSummaryFromCandidate;
    }

    const experienceFromCandidate = coerceNumber(
      candidateSummary.experience_match_percent ?? candidateSummary.experienceMatchPercent
    );
    const skillsFromCandidate = coerceNumber(
      candidateSummary.skills_match_percent ?? candidateSummary.skillsMatchPercent
    );
    const educationFromCandidate = coerceNumber(
      candidateSummary.education_match_percent ?? candidateSummary.educationMatchPercent
    );
    if (experienceFromCandidate !== null) resume_breakdown.experience = experienceFromCandidate;
    if (skillsFromCandidate !== null) resume_breakdown.skills = skillsFromCandidate;
    if (educationFromCandidate !== null) resume_breakdown.education = educationFromCandidate;

    const perceptionScores = parseJsonObject(latestInterview?.perception_scores) || {};
    const clarityFromInterview = coerceNumber(perceptionScores.clarity);
    const confidenceFromInterview = coerceNumber(perceptionScores.confidence);
    const engagementFromInterview = coerceNumber(perceptionScores.engagement);
    if (clarityFromInterview !== null) interview_breakdown.clarity = clarityFromInterview;
    if (confidenceFromInterview !== null) interview_breakdown.confidence = confidenceFromInterview;
    if (engagementFromInterview !== null) {
      interview_breakdown.engagement = engagementFromInterview;
    }

    const interviewSummaryFromInterview = typeof latestInterview?.interview_summary === 'string'
      ? latestInterview.interview_summary.trim()
      : '';
    if (interviewSummaryFromInterview) {
      interview_breakdown.summary = interviewSummaryFromInterview;
    }

    if (Array.isArray(latestInterview?.unanswered_candidate_questions)) {
      const cleaned = latestInterview.unanswered_candidate_questions
        .map((q) => (q == null ? '' : String(q).trim()))
        .filter(Boolean);
      unansweredCandidateQuestions = cleaned;
    }

    const status = latestInterview?.video_url ? 'Interview Completed' : 'Pending';

    if (process.env.SENTRY_ENABLED === '1' && process.env.SENTRY_DSN) {
      Sentry.addBreadcrumb({ category: 'reports', level: 'info', message: 'payload:build' });
    }
    const payload = {
      name,
      email,
      company_name: typeof client?.name === 'string' ? client.name.trim() : '',
      role_name: typeof role?.title === 'string' ? role.title.trim() : '',
      status,
      resume_score: coerceNumber(reportRow.resume_score) ?? 0,
      interview_score: coerceNumber(reportRow.interview_score) ?? 0,
      overall_score: coerceNumber(reportRow.overall_score) ?? 0,
      resume_breakdown,
      resume_summary: resume_breakdown.summary || resume_summary,
      interview_breakdown,
      interview_summary: interview_breakdown.summary || interview_summary,
      created_at: reportRow.created_at,
      unanswered_candidate_questions: unansweredCandidateQuestions
    };

    // 4) Render and convert to PDF
    const html = buildCandidateReportHtml(payload);
    if (process.env.SENTRY_ENABLED === '1' && process.env.SENTRY_DSN) {
      Sentry.addBreadcrumb({ category: 'render', level: 'info', message: 'html:built' });
    }
    const pdfBuffer = await htmlToPdf(html);
    if (process.env.SENTRY_ENABLED === '1' && process.env.SENTRY_DSN) {
      Sentry.addBreadcrumb({ category: 'render', level: 'info', message: 'pdf:generated', data: { bytes: Buffer.isBuffer(pdfBuffer) ? pdfBuffer.length : undefined } });
    }

    // 5) Upload to Supabase Storage
    const safeCandidate = (cand?.name || reportRow.candidate_id || 'candidate')
      .toLowerCase().replace(/[^a-z0-9\-]+/g, '-');
    const key = `${reportRow.candidate_id}/${reportRow.id}-${Date.now()}-${safeCandidate}.pdf`;

    const { error: uploadErr } = await supabaseAdmin
      .storage
      .from(REPORTS_BUCKET)
      .upload(key, pdfBuffer, { contentType: 'application/pdf', upsert: true });
    if (uploadErr) throw uploadErr;
    if (process.env.SENTRY_ENABLED === '1' && process.env.SENTRY_DSN) {
      Sentry.addBreadcrumb({ category: 'storage', level: 'info', message: 'storage:uploaded', data: { key } });
    }

    // Derive a public-style URL (works if bucket is public; harmless otherwise)
    const { data: pub } = supabaseAdmin.storage.from(REPORTS_BUCKET).getPublicUrl(key);

    // Also create a short-lived signed URL for immediate download/open
    const expiresIn = Math.max(MIN_SIGNED_SECS, Math.min(MAX_SIGNED_SECS, Number(req.query.expires || DEFAULT_SIGNED_SECS)));
    const { data: signed, error: signErr } = await supabaseAdmin
      .storage
      .from(REPORTS_BUCKET)
      .createSignedUrl(key, expiresIn);
    if (signErr) throw signErr;
    if (process.env.SENTRY_ENABLED === '1' && process.env.SENTRY_DSN) {
      Sentry.addBreadcrumb({ category: 'storage', level: 'info', message: 'storage:signedurl', data: { expiresIn } });
    }

    // 6) Best-effort: update reports row
    try {
      await supabaseAdmin
        .from('reports')
        .update({
          report_url: pub?.publicUrl || null,
          report_generated_at: new Date().toISOString()
        })
        .eq('id', reportRow.id);
    } catch (e) {
      if (process.env.SENTRY_ENABLED === '1' && process.env.SENTRY_DSN) {
        Sentry.addBreadcrumb({ category: 'db', level: 'warning', message: 'reports:update_failed', data: { report_id: reportRow.id, error: String(e && e.message || e) } });
      }
    }

    return res.json({
      ok: true,
      report_id: reportRow.id,
      key,
      url: pub?.publicUrl || null,
      signed_url: signed?.signedUrl || null,
      expires_in: expiresIn
    });
  } catch (err) {
    console.error('[reports/generate] error', err);
    if (process.env.SENTRY_ENABLED === '1' && process.env.SENTRY_DSN) {
      Sentry.captureException(err, {
        tags: { endpoint: '/reports/generate' },
        extra: {
          candidate_id: (req.body && req.body.candidate_id) || null,
          report_id: (req.body && req.body.report_id) || null
        }
      });
    }
    return res.status(500).json({ error: err.message || 'Failed to generate report' });
  }
}

// Register both endpoints to the same handler
router.post('/generate', handleGenerate);
router.post('/generate-and-store', handleGenerate);

// Production endpoint (stubbed until Step 3)
// POST /api/reports/pdf
router.post('/pdf', async (req, res) => {
  try {
    return res.status(501).json({ error: 'not_implemented', detail: 'PDF generation will be enabled after Step 3.' });
  } catch (err) {
    console.error('[reports/pdf] error:', err);
    if (process.env.SENTRY_ENABLED === '1' && process.env.SENTRY_DSN) {
      Sentry.captureException(err, { tags: { endpoint: '/reports/pdf' } });
    }
    return res.status(500).json({ error: 'PDF endpoint error' });
  }
});

/**
 * GET /api/reports/:id/url?expires=60
 * Returns a short-lived signed URL for an existing report PDF.
 */
router.get('/:id/url', async (req, res) => {
  try {
    if (!supabaseAdmin) {
      return res.status(500).json({ error: 'Storage not configured (missing SUPABASE_URL/SUPABASE_SERVICE_KEY)' });
    }
    const id = req.params.id;
    const expiresParam = Number(req.query.expires || DEFAULT_SIGNED_SECS);
    const expiresIn = Math.max(MIN_SIGNED_SECS, Math.min(MAX_SIGNED_SECS, expiresParam));

    // Load report row to find where the PDF lives
    const { data: report, error } = await supabaseAdmin
      .from('reports')
      .select('id, report_url, candidate_id')
      .eq('id', id)
      .maybeSingle();
    if (error) throw error;
    if (!report) return res.status(404).json({ error: 'Report not found' });

    const key = keyFromUrl(report.report_url);
    if (!key) return res.status(404).json({ error: 'Report file not available' });

    const { data: signed, error: signErr } = await supabaseAdmin
      .storage
      .from(REPORTS_BUCKET)
      .createSignedUrl(key, expiresIn);
    if (signErr) throw signErr;

    return res.json({
      ok: true,
      report_id: report.id,
      signed_url: signed?.signedUrl || null,
      expires_in: expiresIn
    });
  } catch (err) {
    console.error('[reports/:id/url] error', err);
    if (process.env.SENTRY_ENABLED === '1' && process.env.SENTRY_DSN) {
      Sentry.captureException(err, { tags: { endpoint: '/reports/:id/url' } });
    }
    return res.status(500).json({ error: err.message || 'Failed to mint signed URL' });
  }
});

router._handleGenerate = handleGenerate;
module.exports = router;
