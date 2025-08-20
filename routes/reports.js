const express = require('express');
const router = express.Router();
const { supabaseAdmin } = require('../src/lib/supabaseClient');

// -------------------- helpers --------------------

function parseBucketPathFromUrl(input) {
  if (!input) return null;
  try {
    if (input.startsWith('http')) {
      const u = new URL(input);
      const m = u.pathname.match(/\/object\/(?:public|sign)\/([^/]+)\/(.+)$/);
      if (m) return { bucket: m[1], path: decodeURIComponent(m[2]) };
    }
  } catch (_) {}
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

async function getCandidate(candidateId) {
  if (!candidateId) return { data: null, error: null };
  return supabaseAdmin.from('candidates')
    .select('id, name, email')
    .eq('id', candidateId)
    .single();
}

async function getReportsForCandidate(candidateId) {
  if (!candidateId) return { data: [], error: null };
  return supabaseAdmin
    .from('reports')
    .select('id,candidate_id,role_id,resume_score,interview_score,overall_score,resume_breakdown,interview_breakdown,report_url,created_at')
    .eq('candidate_id', candidateId)
    .order('created_at', { ascending: false });
}

function ensureAccess(req, clientId) {
  const ids = Array.isArray(req.client_memberships)
    ? req.client_memberships
    : Array.isArray(req.memberships)
      ? req.memberships.map(m => (typeof m === 'string' ? m : m?.client_id)).filter(Boolean)
      : (req.clientIds || []);
  if (!ids.includes(clientId)) {
    const e = new Error('Forbidden'); e.status = 403; throw e;
  }
}

const PDF_API = 'https://api.pdfmonkey.io/api/v1';

async function pdfmonkeyCreateAndWait(payload, filename = 'Candidate_Report.pdf') {
  const apiKey = process.env.PDFMONKEY_API_KEY;
  const templateId = process.env.PDFMONKEY_TEMPLATE_ID;
  if (!apiKey) { const e = new Error('PDFMonkey: missing PDFMONKEY_API_KEY'); e.status = 500; throw e; }
  if (!templateId) { const e = new Error('PDFMonkey: missing PDFMONKEY_TEMPLATE_ID'); e.status = 500; throw e; }

  // correct PDFMonkey fields
  const createRes = await fetch(`${PDF_API}/documents`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      document: {
        document_template_id: templateId,
        status: 'pending',              // enqueue rendering
        payload,
        meta: { _filename: filename }
      }
    })
  });

  if (!createRes.ok) {
    const txt = await createRes.text().catch(() => '');
    const err = new Error(`PDFMonkey create failed (${createRes.status}) ${txt}`);
    err.status = 502;
    throw err;
  }

  const created = await createRes.json();
  let doc = created.document || created;
  let id = doc?.id;
  let url = doc?.download_url || created?.download_url || created?.url;

  // poll until ready (max ~20s)
  for (let i = 0; !url && i < 20; i++) {
    await new Promise(r => setTimeout(r, 1000));
    const showRes = await fetch(`${PDF_API}/documents/${id}`, {
      headers: { 'Authorization': `Bearer ${apiKey}` }
    });
    if (!showRes.ok) continue;
    const j = await showRes.json();
    const d = j.document || j;
    if ((d.status === 'success' || d.status === 'processed') && (d.download_url || d.url)) {
      url = d.download_url || d.url;
      break;
    }
    if (d.status === 'failure' || d.status === 'failed') {
      const err = new Error('PDFMonkey rendering failed');
      err.status = 502;
      throw err;
    }
  }

  if (!url) {
    const err = new Error('PDFMonkey did not return a download URL');
    err.status = 502;
    throw err;
  }
  return url;
}

function pickBestReport(reports, targetRoleId) {
  if (!Array.isArray(reports) || reports.length === 0) return null;
  return reports.find(r => targetRoleId && r.role_id === targetRoleId) || reports[0];
}

function numOrNull(v) { return (typeof v === 'number' && isFinite(v)) ? v : (v === 0 ? 0 : null); }

async function buildPayload(interview) {
  const { data: candidate } = await getCandidate(interview.candidate_id);
  const { data: reports } = await getReportsForCandidate(interview.candidate_id);
  const matchedReport = pickBestReport(reports || [], interview.role_id);

  // scores from report if present; else derive from transcript/analysis
  let resume_score = matchedReport?.resume_score ?? null;
  let interview_score = matchedReport?.interview_score ?? null;
  let overall_score = matchedReport?.overall_score ?? null;

  let rb = matchedReport?.resume_breakdown || {};
  let ib = matchedReport?.interview_breakdown || {};

  if (!matchedReport) {
    const transcript = interview.transcript_url ? await downloadJsonFromStorage(interview.transcript_url) : null;
    const analysis   = interview.analysis_url   ? await downloadJsonFromStorage(interview.analysis_url)   : null;
    rb = {
      summary: transcript?.summary || '',
      experience_match_percent: transcript?.experience_match_percent ?? null,
      skills_match_percent:     transcript?.skills_match_percent ?? null,
      education_match_percent:  transcript?.education_match_percent ?? null
    };
    ib = {
      clarity: analysis?.clarity ?? null,
      confidence: analysis?.confidence ?? null,
      body_language: analysis?.body_language ?? null
    };
    // naive fallback numbers
    resume_score = numOrNull(transcript?.overall_resume_match_percent);
    if (resume_score === null) {
      const parts = [rb.experience_match_percent, rb.skills_match_percent, rb.education_match_percent]
        .filter(v => typeof v === 'number');
      resume_score = parts.length ? Math.round(parts.reduce((a,b)=>a+b,0)/parts.length) : 0;
    }
    const interviewParts = [ib.clarity, ib.confidence, ib.body_language].filter(v => typeof v === 'number');
    interview_score = interviewParts.length ? Math.round(interviewParts.reduce((a,b)=>a+b,0)/interviewParts.length) : 0;
    overall_score = Math.round(((resume_score||0) + (interview_score||0)) / 2);
  }

  return {
    interview_id: interview.id,
    created_at: interview.created_at,
    candidate_id: interview.candidate_id || null,
    role_id: interview.role_id || null,

    name: candidate?.name || '',
    email: candidate?.email || '',

    resume_score: numOrNull(resume_score) ?? 0,
    interview_score: numOrNull(interview_score) ?? 0,
    overall_score: numOrNull(overall_score) ?? 0,

    resume_breakdown: {
      summary: typeof rb.summary === 'string' ? rb.summary : '',
      experience_match_percent: numOrNull(rb.experience_match_percent),
      skills_match_percent:     numOrNull(rb.skills_match_percent),
      education_match_percent:  numOrNull(rb.education_match_percent)
    },
    interview_breakdown: {
      clarity:       numOrNull(ib.clarity),
      confidence:    numOrNull(ib.confidence),
      body_language: numOrNull(ib.body_language)
    }
  };
}

async function generateForInterview(interviewId, req) {
  const { data: interview, error } = await getInterview(interviewId);
  if (error || !interview) { const e = new Error('Interview not found'); e.status = 404; throw e; }
  ensureAccess(req, interview.client_id);

  const payload = await buildPayload(interview);
  const filename = `Candidate_Report_${interviewId}.pdf`;
  const url = await pdfmonkeyCreateAndWait(payload, filename);

  // Optional: persist last URL by interview if your schema has `interview_id`
  try {
    await supabaseAdmin
      .from('reports')
      .upsert({ interview_id: interviewId, report_url: url, created_at: new Date().toISOString() }, { onConflict: 'interview_id' });
  } catch (_) {}

  return { url, interview };
}

// -------------------- routes --------------------

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

router.get('/:interview_id/generate', handlerGenerate);
router.post('/:interview_id/generate', handlerGenerate);
router.get('/:interview_id/download', handlerDownload);

module.exports = router;
