// routes/reports.js
const express = require('express');
const router = express.Router();
const { supabaseAdmin } = require('../src/lib/supabaseClient');

// --- Helpers ---------------------------------------------------------------

// Parse "<bucket>/<path>" or Supabase object URL => { bucket, path }
function parseBucketPathFromUrl(input) {
  if (!input) return null;
  try {
    if (input.startsWith('http')) {
      const u = new URL(input);
      const m = u.pathname.match(/\/object\/(?:public|sign)\/([^/]+)\/(.+)$/);
      if (m) return { bucket: m[1], path: decodeURIComponent(m[2]) };
    }
  } catch {}
  const i = input.indexOf('/');
  if (i === -1) return null;
  return { bucket: input.slice(0, i), path: input.slice(i + 1) };
}

async function downloadJsonFromStorage(urlOrPath) {
  const bp = parseBucketPathFromUrl(urlOrPath);
  if (!bp) return null;
  const { data, error } = await supabaseAdmin.storage.from(bp.bucket).download(bp.path);
  if (error || !data) return null;
  const text = await data.text();
  try { return JSON.parse(text); } catch { return null; }
}

async function getInterview(interviewId) {
  return supabaseAdmin
    .from('interviews')
    .select('id, client_id, candidate_id, role_id, created_at, video_url, transcript_url, analysis_url')
    .eq('id', interviewId)
    .single();
}

function ensureAccess(req, clientId) {
  // Accept either req.client_memberships (ids) or req.memberships [{client_id}]
  const ids =
    Array.isArray(req.client_memberships) && req.client_memberships.length
      ? req.client_memberships
      : Array.isArray(req.memberships)
      ? req.memberships.map(m => (typeof m === 'string' ? m : m?.client_id)).filter(Boolean)
      : (req.clientIds || []);
  if (!ids.includes(clientId)) {
    const e = new Error('Forbidden');
    e.status = 403;
    throw e;
  }
}

// Build payload for PDFMonkey (tolerates missing transcript/analysis)
async function buildPayload(interview) {
  const transcript = interview.transcript_url ? await downloadJsonFromStorage(interview.transcript_url) : null;
  const analysis   = interview.analysis_url   ? await downloadJsonFromStorage(interview.analysis_url)   : null;

  return {
    interview_id: interview.id,
    created_at: interview.created_at,
    candidate_id: interview.candidate_id || null,
    role_id: interview.role_id || null,

    // High-level scores (fill real values later if you like)
    resume_score: 0,
    interview_score: 0,
    overall_score: 0,

    // Breakdowns (keys aligned with your template)
    resume_breakdown: {
      summary: transcript?.summary || '',
      experience_match_percent: transcript?.experience_match_percent ?? null,
      skills_match_percent:     transcript?.skills_match_percent ?? null,
      education_match_percent:  transcript?.education_match_percent ?? null
    },
    interview_breakdown: {
      clarity:       analysis?.clarity ?? null,
      confidence:    analysis?.confidence ?? null,
      body_language: analysis?.body_language ?? null
    }
  };
}

// Minimal PDFMonkey client (Node 18+ global fetch)
const PDF_API = 'https://api.pdfmonkey.io/api/v1';
async function pdfmonkeyCreateAndWait(payload) {
  const apiKey = process.env.PDFMONKEY_API_KEY;
  const templateId = process.env.PDFMONKEY_TEMPLATE_ID;
  if (!apiKey) { const e = new Error('PDFMonkey: missing PDFMONKEY_API_KEY'); e.status = 500; throw e; }
  if (!templateId) { const e = new Error('PDFMonkey: missing PDFMONKEY_TEMPLATE_ID'); e.status = 500; throw e; }

  // 1) Create document
  const res = await fetch(`${PDF_API}/documents`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      document: {
        template_id: templateId,
        payload,
        status: 'processed' // ask to render immediately
      }
    })
  });

  if (!res.ok) {
    const t = await res.text().catch(() => '');
    const e = new Error(`PDFMonkey create failed (${res.status}) ${t}`);
    e.status = 502;
    throw e;
  }

  const created = await res.json();
  let doc = created.document || created;
  let id = doc?.id;
  let url = doc?.download_url || created?.download_url || created?.url;

  // 2) Poll up to ~10s if URL not ready yet
  for (let i = 0; !url && i < 10; i++) {
    await new Promise(r => setTimeout(r, 1000));
    const s = await fetch(`${PDF_API}/documents/${id}`, {
      headers: { 'Authorization': `Bearer ${apiKey}` }
    });
    if (!s.ok) continue;
    const j = await s.json();
    const d = j.document || j;
    if (d.status === 'processed' && (d.download_url || d.url)) {
      url = d.download_url || d.url;
      break;
    }
    if (d.status === 'failed') {
      const e = new Error('PDFMonkey rendering failed');
      e.status = 502;
      throw e;
    }
  }

  if (!url) {
    const e = new Error('PDFMonkey did not return a download URL');
    e.status = 502;
    throw e;
  }
  return url;
}

async function generateForInterview(interviewId, req) {
  const { data: interview, error } = await getInterview(interviewId);
  if (error || !interview) { const e = new Error('Interview not found'); e.status = 404; throw e; }
  ensureAccess(req, interview.client_id);

  const payload = await buildPayload(interview);
  const url = await pdfmonkeyCreateAndWait(payload);

  // Best-effort: upsert report URL by interview (optional schema)
  try {
    await supabaseAdmin
      .from('reports')
      .upsert(
        { interview_id: interviewId, report_url: url, created_at: new Date().toISOString() },
        { onConflict: 'interview_id' }
      );
  } catch {}

  return { url, interview };
}

// --- Routes ----------------------------------------------------------------

// JSON: returns { ok, url } (hosted PDFMonkey URL)
async function handlerGenerate(req, res) {
  try {
    if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
    const interviewId = req.params.interview_id;
    const { url } = await generateForInterview(interviewId, req);
    return res.json({ ok: true, url });
  } catch (e) {
    return res.status(e.status || 500).json({ error: e.message || 'Server error' });
  }
}

// Download: streams the PDF so the browser saves it directly
async function handlerDownload(req, res) {
  try {
    if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
    const interviewId = req.params.interview_id;
    const { url } = await generateForInterview(interviewId, req);

    const r = await fetch(url);
    if (!r.ok) {
      const t = await r.text().catch(() => '');
      const err = new Error(`Fetch PDF failed (${r.status}) ${t}`);
      err.status = 502;
      throw err;
    }

    const filename = `Candidate_Report_${interviewId}.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

    if (r.body?.pipe) {
      r.body.pipe(res);
    } else {
      const buf = Buffer.from(await r.arrayBuffer());
      res.end(buf);
    }
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message || 'Server error' });
  }
}

router.post('/:interview_id/generate', handlerGenerate);
router.get('/:interview_id/generate', handlerGenerate);
router.get('/:interview_id/download', handlerDownload);

module.exports = router;
