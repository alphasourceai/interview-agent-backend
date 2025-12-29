// routes/textInterview.js
const express = require('express');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const { supabaseAdmin } = require('../src/lib/supabaseClient');

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
});

const RESUME_BUCKET = process.env.SUPABASE_RESUMES_BUCKET || 'resumes';
const TOKEN_SECRET = process.env.TEXT_INTERVIEW_JWT_SECRET || process.env.SUPABASE_JWT_SECRET || '';
const TEXT_COMPLETION_NOTE = 'Completed via accommodation pathway (text).';

const parseQuestions = (rubric) => {
  if (!rubric) return [];
  let parsed = rubric;
  if (typeof rubric === 'string') {
    try { parsed = JSON.parse(rubric); } catch { return []; }
  }
  const list = Array.isArray(parsed?.questions)
    ? parsed.questions
    : Array.isArray(parsed)
      ? parsed
      : [];
  return list
    .map((q) => {
      if (typeof q === 'string') return q.trim();
      if (q && typeof q === 'object') {
        const raw = q.question || q.prompt || q.text || '';
        return String(raw || '').trim();
      }
      return '';
    })
    .filter(Boolean);
};

function verifyToken(raw) {
  if (!TOKEN_SECRET) {
    const err = new Error('Token secret not configured');
    err.code = 'token_secret_missing';
    throw err;
  }
  const decoded = jwt.verify(raw, TOKEN_SECRET);
  if (!decoded || decoded.mode !== 'text' || !decoded.request_id) {
    const err = new Error('Invalid token');
    err.code = 'token_invalid';
    throw err;
  }
  return decoded;
}

async function loadRequest(requestId) {
  const { data, error } = await supabaseAdmin
    .from('accommodation_requests')
    .select('id, role_id, candidate_id, candidate_name, candidate_email, status, resume_url, resume_received_at, text_completed_at')
    .eq('id', requestId)
    .maybeSingle();
  if (error || !data) {
    const err = new Error('Request not found');
    err.code = 'request_not_found';
    throw err;
  }
  return data;
}

function ensureApprovedStatus(status) {
  const normalized = String(status || '').toLowerCase();
  if (!['approved', 'sent'].includes(normalized)) {
    const err = new Error('Request not approved');
    err.code = 'request_not_approved';
    throw err;
  }
}

router.post('/session', async (req, res) => {
  const request_id = req.request_id || crypto.randomUUID?.() || String(Date.now());
  try {
    const token = String(req.body?.token || '').trim();
    if (!token) return res.status(400).json({ error: 'token_required' });
    const decoded = verifyToken(token);

    const reqRow = await loadRequest(decoded.request_id);
    ensureApprovedStatus(reqRow.status);

    if (decoded.role_id && decoded.role_id !== reqRow.role_id) {
      return res.status(403).json({ error: 'role_mismatch' });
    }

    const { data: role, error: roleErr } = await supabaseAdmin
      .from('roles')
      .select('id, title, rubric, client_id')
      .eq('id', reqRow.role_id)
      .maybeSingle();
    if (roleErr || !role) return res.status(404).json({ error: 'role_not_found' });

    let resumeRequired = !(reqRow.resume_url || reqRow.resume_received_at);
    if (resumeRequired && reqRow.candidate_id) {
      const { data: cand } = await supabaseAdmin
        .from('candidates')
        .select('resume_url')
        .eq('id', reqRow.candidate_id)
        .maybeSingle();
      if (cand?.resume_url) {
        resumeRequired = false;
        await supabaseAdmin
          .from('accommodation_requests')
          .update({ resume_url: cand.resume_url, resume_received_at: new Date().toISOString() })
          .eq('id', reqRow.id);
      }
    }

    const questions = parseQuestions(role.rubric);

    return res.json({
      request_id: reqRow.id,
      candidate_name: reqRow.candidate_name,
      candidate_email: reqRow.candidate_email,
      role_id: role.id,
      role_title: role.title || '',
      questions,
      resume_required: resumeRequired,
      completed: !!reqRow.text_completed_at,
    });
  } catch (e) {
    const status = e?.code === 'request_not_approved' ? 403 : 400;
    return res.status(status).json({ error: e?.message || 'Invalid request' });
  }
});

router.post('/resume', upload.any(), async (req, res) => {
  const request_id = req.request_id || crypto.randomUUID?.() || String(Date.now());
  try {
    const token = String(req.body?.token || '').trim();
    if (!token) return res.status(400).json({ error: 'token_required' });
    const decoded = verifyToken(token);
    const reqRow = await loadRequest(decoded.request_id);
    ensureApprovedStatus(reqRow.status);

    const file = (req.files || []).find(f =>
      ['resume', 'resume_file', 'file', 'resumeFile', 'pdf'].includes(f.fieldname)
    );
    if (!file) return res.status(400).json({ error: 'resume_required' });

    const fileType = file.mimetype || 'application/pdf';
    const ext = /pdf/i.test(fileType) ? 'pdf' : 'docx';
    const path = `accommodations/${reqRow.id}.${ext}`;
    const up = await supabaseAdmin.storage.from(RESUME_BUCKET).upload(path, file.buffer, {
      contentType: fileType,
      upsert: true,
    });
    if (up.error) return res.status(500).json({ error: 'resume_upload_failed' });

    const { data: pub } = supabaseAdmin.storage.from(RESUME_BUCKET).getPublicUrl(path);
    const resume_url = pub?.publicUrl || null;
    const resume_received_at = new Date().toISOString();

    await supabaseAdmin
      .from('accommodation_requests')
      .update({ resume_url, resume_received_at })
      .eq('id', reqRow.id);

    if (reqRow.candidate_id) {
      const { data: cand } = await supabaseAdmin
        .from('candidates')
        .select('resume_url')
        .eq('id', reqRow.candidate_id)
        .maybeSingle();
      if (!cand?.resume_url) {
        await supabaseAdmin.from('candidates').update({ resume_url }).eq('id', reqRow.candidate_id);
      }
    }

    return res.json({ ok: true });
  } catch (e) {
    if (e?.code) {
      const status = e.code === 'request_not_approved' ? 403 : 400;
      return res.status(status).json({ error: e?.message || 'Invalid request' });
    }
    console.error('[text-interview] resume upload failed', { request_id, error: e?.message || e });
    return res.status(500).json({ error: 'resume_upload_failed' });
  }
});

router.post('/answers', async (req, res) => {
  const request_id = req.request_id || crypto.randomUUID?.() || String(Date.now());
  try {
    const token = String(req.body?.token || '').trim();
    const answers = Array.isArray(req.body?.answers) ? req.body.answers : null;
    if (!token) return res.status(400).json({ error: 'token_required' });
    if (!answers || answers.length === 0) return res.status(400).json({ error: 'answers_required' });
    const decoded = verifyToken(token);
    const reqRow = await loadRequest(decoded.request_id);
    ensureApprovedStatus(reqRow.status);

    let resumePresent = !!(reqRow.resume_url || reqRow.resume_received_at);
    let candidateResumeUrl = null;
    if (!resumePresent && reqRow.candidate_id) {
      const { data: cand } = await supabaseAdmin
        .from('candidates')
        .select('resume_url')
        .eq('id', reqRow.candidate_id)
        .maybeSingle();
      candidateResumeUrl = cand?.resume_url || null;
      resumePresent = !!candidateResumeUrl;
    }
    if (resumePresent && candidateResumeUrl && !(reqRow.resume_url || reqRow.resume_received_at)) {
      await supabaseAdmin
        .from('accommodation_requests')
        .update({ resume_url: candidateResumeUrl, resume_received_at: new Date().toISOString() })
        .eq('id', reqRow.id);
    }
    if (!resumePresent) return res.status(400).json({ error: 'resume_required' });

    const { data: role } = await supabaseAdmin
      .from('roles')
      .select('id, title, rubric, client_id')
      .eq('id', reqRow.role_id)
      .maybeSingle();
    if (!role) return res.status(404).json({ error: 'role_not_found' });

    const nowIso = new Date().toISOString();
    const firstSubmit = !reqRow.text_completed_at;

    await supabaseAdmin
      .from('accommodation_requests')
      .update({ text_answers: answers, text_completed_at: nowIso })
      .eq('id', reqRow.id);

    if (firstSubmit && reqRow.candidate_id) {
      const interviewAnalysis = {
        mode: 'text',
        summary: TEXT_COMPLETION_NOTE,
        answers,
      };

      await supabaseAdmin.from('interviews').insert({
        candidate_id: reqRow.candidate_id,
        role_id: role.id,
        client_id: role.client_id || null,
        rubric: role.rubric || null,
        analysis: interviewAnalysis,
        status: 'completed',
      });

      const interview_breakdown = {
        clarity: null,
        confidence: null,
        body_language: null,
        summary: TEXT_COMPLETION_NOTE,
      };

      await supabaseAdmin.from('reports').insert({
        candidate_id: reqRow.candidate_id,
        role_id: role.id,
        client_id: role.client_id || null,
        resume_score: null,
        interview_score: null,
        overall_score: null,
        interview_breakdown,
        analysis: { summary: TEXT_COMPLETION_NOTE, mode: 'text' },
      });

      await supabaseAdmin.from('candidates')
        .update({ status: 'Interview Completed (Text)', interview_status: 'Interview Completed (Text)' })
        .eq('id', reqRow.candidate_id);
    }

    return res.json({ ok: true });
  } catch (e) {
    if (e?.code) {
      const status = e.code === 'request_not_approved' ? 403 : 400;
      return res.status(status).json({ error: e?.message || 'Invalid request' });
    }
    console.error('[text-interview] answers failed', { request_id, error: e?.message || e });
    return res.status(500).json({ error: 'submission_failed' });
  }
});

module.exports = router;
