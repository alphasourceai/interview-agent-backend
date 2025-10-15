const router = require('express').Router();
const { htmlToPdf } = require('../utils/pdfRenderer');
const { buildCandidateReportHtml } = require('../utils/renderCandidateReport');
const { createClient } = require('@supabase/supabase-js');

// Supabase Admin (for loading report data + uploading PDFs)
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const REPORTS_BUCKET = process.env.REPORTS_BUCKET || 'reports';
const supabaseAdmin = (SUPABASE_URL && SUPABASE_SERVICE_KEY)
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, { auth: { persistSession: false } })
  : null;

// Signed URL defaults
const DEFAULT_SIGNED_SECS = 60; // short-lived; FE will open immediately
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
router.get('/reports/preview-health', (req, res) => {
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
router.post('/reports/preview-html', async (req, res) => {
  try {
    const data = extractData(req.body);
    const html = buildCandidateReportHtml(data);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.status(200).send(html);
  } catch (err) {
    console.error('[reports/html-preview] error:', err);
    return res.status(500).json({ error: 'HTML render failed' });
  }
});

router.post('/reports/preview-pdf', async (req, res) => {
  try {
    const data = extractData(req.body);
    const html = buildCandidateReportHtml(data);
    const pdf = await htmlToPdf(html);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline; filename="candidate-report.pdf"');
    return res.send(pdf);
  } catch (err) {
    console.error('[reports/preview-pdf] error:', err);
    res.status(500).json({ error: 'PDF render failed' });
  }
});

/**
 * POST /api/reports/generate
 * Body: { candidate_id } OR { report_id }
 * Loads latest report (or specific), renders PDF, uploads to Supabase Storage.
 * Responds: { ok, report_id, key, url }
 */
router.post('/reports/generate', async (req, res) => {
  try {
    if (!supabaseAdmin) {
      return res.status(500).json({ error: 'Storage not configured (missing SUPABASE_URL/SUPABASE_SERVICE_KEY)' });
    }

    const { candidate_id, report_id } = req.body || {};
    if (!candidate_id && !report_id) {
      return res.status(400).json({ error: 'candidate_id or report_id is required' });
    }

    // 1) Load report row
    let reportRow = null;
    if (report_id) {
      const { data, error } = await supabaseAdmin
        .from('reports')
        .select('id, created_at, candidate_id, role_id, resume_score, interview_score, overall_score, interview_breakdown, resume_analysis')
        .eq('id', report_id)
        .maybeSingle();
      if (error) throw error;
      reportRow = data;
    } else {
      const { data, error } = await supabaseAdmin
        .from('reports')
        .select('id, created_at, candidate_id, role_id, resume_score, interview_score, overall_score, interview_breakdown, resume_analysis')
        .eq('candidate_id', candidate_id)
        .order('created_at', { ascending: false })
        .limit(1);
      if (error) throw error;
      reportRow = (data && data[0]) || null;
    }

    if (!reportRow) {
      return res.status(404).json({ error: 'No report found for given id' });
    }

    // 2) Load candidate + role
    const [{ data: cand, error: candErr }, { data: role, error: roleErr }] = await Promise.all([
      supabaseAdmin.from('candidates').select('id,name,email').eq('id', reportRow.candidate_id).maybeSingle(),
      supabaseAdmin.from('roles').select('id,title').eq('id', reportRow.role_id).maybeSingle(),
    ]);
    if (candErr) throw candErr;
    if (roleErr) throw roleErr;

    // 3) Normalize data to template shape (parity with dashboard)
    const rb = reportRow.interview_breakdown || {};
    const resume = reportRow.resume_analysis || {};

    const templateData = {
      candidate: {
        name: cand?.name || 'Unknown Candidate',
        email: cand?.email || '',
      },
      role: {
        title: role?.title || '—',
      },
      resume_score: typeof reportRow.resume_score === 'number' ? reportRow.resume_score : null,
      interview_score: typeof reportRow.interview_score === 'number' ? reportRow.interview_score : (rb?.scores?.overall ?? null),
      overall_score: typeof reportRow.overall_score === 'number' ? reportRow.overall_score : null,
      resume_analysis: {
        experience: typeof resume.experience === 'number' ? resume.experience : null,
        skills: typeof resume.skills === 'number' ? resume.skills : null,
        education: typeof resume.education === 'number' ? resume.education : null,
        summary: (resume.summary || '').trim(),
      },
      interview_analysis: {
        clarity: rb?.scores?.clarity ?? null,
        confidence: rb?.scores?.confidence ?? null,
        body_language: rb?.scores?.body_language ?? null,
        summary: (rb?.summary || '').trim(),
      },
      created_at: reportRow.created_at,
    };

    // 4) Render and convert to PDF
    const html = buildCandidateReportHtml(templateData);
    const pdfBuffer = await htmlToPdf(html);

    // 5) Upload to Supabase Storage
    const safeCandidate = (cand?.name || reportRow.candidate_id || 'candidate')
      .toLowerCase().replace(/[^a-z0-9\-]+/g, '-');
    const key = `${reportRow.candidate_id}/${reportRow.id}-${Date.now()}-${safeCandidate}.pdf`;

    const { error: uploadErr } = await supabaseAdmin
      .storage
      .from(REPORTS_BUCKET)
      .upload(key, pdfBuffer, { contentType: 'application/pdf', upsert: true });
    if (uploadErr) throw uploadErr;

    // Derive a public-style URL (works if bucket is public; harmless otherwise)
    const { data: pub } = supabaseAdmin.storage.from(REPORTS_BUCKET).getPublicUrl(key);

    // Also create a short-lived signed URL for immediate download/open
    const expiresIn = Math.max(MIN_SIGNED_SECS, Math.min(MAX_SIGNED_SECS, Number(req.query.expires || DEFAULT_SIGNED_SECS)));
    const { data: signed, error: signErr } = await supabaseAdmin
      .storage
      .from(REPORTS_BUCKET)
      .createSignedUrl(key, expiresIn);
    if (signErr) throw signErr;

    // 6) Best-effort: update reports row (keep storing a stable URL for history/back-compat)
    // Note: Avoid storing signed URL (it expires). Use public-style URL if available; otherwise you may store null.
    try {
      await supabaseAdmin
        .from('reports')
        .update({
          report_url: pub?.publicUrl || null,
          report_generated_at: new Date().toISOString()
        })
        .eq('id', reportRow.id);
    } catch (_) { /* non-fatal */ }

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
    return res.status(500).json({ error: err.message || 'Failed to generate report' });
  }
});

// Production endpoint (stubbed until Step 3)
// POST /api/reports/pdf
router.post('/reports/pdf', async (req, res) => {
  try {
    return res.status(501).json({ error: 'not_implemented', detail: 'PDF generation will be enabled after Step 3.' });
  } catch (err) {
    console.error('[reports/pdf] error:', err);
    return res.status(500).json({ error: 'PDF endpoint error' });
  }
});

/**
 * GET /api/reports/:id/url?expires=60
 * Returns a short-lived signed URL for an existing report PDF.
 */
router.get('/reports/:id/url', async (req, res) => {
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
    return res.status(500).json({ error: err.message || 'Failed to mint signed URL' });
  }
});

module.exports = router;