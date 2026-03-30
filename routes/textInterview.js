// routes/textInterview.js
const express = require('express');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const { OpenAI } = require('openai');
const analyzeResume = require('../analyzeResume');
const { supabaseAdmin } = require('../src/lib/supabaseClient');
const { checkDuplicateCandidate } = require('../src/lib/duplicateCandidate');
const { getRoleInterviewAvailability, syncRoleInterviewLimitNotification } = require('../src/lib/roleInterviewAvailability');

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
});

const TOKEN_SECRET = process.env.TEXT_INTERVIEW_JWT_SECRET || process.env.SUPABASE_JWT_SECRET || '';
const TEXT_COMPLETION_NOTE = 'Completed via accommodation pathway (text).';
const openai = process.env.OPENAI_API_KEY ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;

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

const clampScore = (value) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
};

const toScoreOrNull = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : null;
};

async function scoreTextInterview({ role, answers }) {
  if (!openai) {
    const err = new Error('OpenAI not configured');
    err.code = 'openai_missing';
    throw err;
  }

  const roleDesc = String(role?.description || role?.job_description_text || '').trim();
  const qa = (answers || [])
    .map((item, idx) => {
      const q = String(item?.question || '').trim();
      const a = String(item?.answer || '').trim();
      return `${idx + 1}. Q: ${q || '[question missing]'}\nA: ${a || '[no answer provided]'}`;
    })
    .join('\n\n');

  const sysPrompt = 'You are an unbiased hiring evaluator. Score the written interview answers against the role criteria. Do not infer protected attributes.';
  const userPrompt = `
Role Title: ${role?.title || '[unknown]'}
Role Description: ${roleDesc || '[none provided]'}

Interview Q&A:
${qa || '[no answers provided]'}

Return strict JSON:
{"interview_score":0-100,"summary":"2-4 sentences explaining strengths/weaknesses against the role."}
`;

  const resp = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      { role: 'system', content: sysPrompt },
      { role: 'user', content: userPrompt }
    ],
    response_format: { type: 'json_object' },
    temperature: 0.2
  });

  const raw = resp.choices?.[0]?.message?.content || '{}';
  let parsed = {};
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = {};
  }

  const interview_score = clampScore(parsed.interview_score ?? parsed.score ?? parsed.total_score);
  const summary = String(parsed.summary || '').trim();
  return { interview_score, summary };
}

function getAccommodationResumeBucket() {
  const bucket = String(process.env.SUPABASE_ACCOMMODATION_RESUMES_BUCKET || '').trim();
  if (!bucket) {
    const err = new Error('SUPABASE_ACCOMMODATION_RESUMES_BUCKET not configured');
    err.code = 'bucket_missing';
    err.detail = 'SUPABASE_ACCOMMODATION_RESUMES_BUCKET not configured';
    throw err;
  }
  return bucket;
}

function sendError(res, status, { error, code, detail, hint, request_id }) {
  return res.status(status).json({ error, code, detail, hint, request_id });
}

function logSupabaseError(message, request_id, error) {
  console.error(message, {
    request_id,
    error: error?.message || error,
    detail: error?.detail || null,
    hint: error?.hint || null,
  });
}

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
  const request_id = req.request_id || null;
  try {
    const token = String(req.body?.token || '').trim();
    if (!token) {
      return sendError(res, 400, {
        error: 'token_required',
        code: 'token_required',
        detail: null,
        hint: null,
        request_id,
      });
    }
    const decoded = verifyToken(token);

    const reqRow = await loadRequest(decoded.request_id);
    ensureApprovedStatus(reqRow.status);

    const dup = await checkDuplicateCandidate({
      supabase: supabaseAdmin,
      roleId: reqRow.role_id,
      email: reqRow.candidate_email,
      fullName: reqRow.candidate_name,
      phone: reqRow.candidate_phone,
      excludeCandidateId: reqRow.candidate_id || null,
      allowPhoneEnrich: false,
    });
    if (dup.duplicate) {
      console.warn('[text-interview] duplicate candidate blocked', {
        request_id,
        role_id: reqRow.role_id,
        candidate_id: dup.candidateId || null,
        reason: dup.reason || null,
      });
      return sendError(res, 409, {
        error: 'Already interviewed for this role.',
        code: 'duplicate_candidate',
        detail: dup.reason || null,
        hint: null,
        request_id,
      });
    }

    if (decoded.role_id && decoded.role_id !== reqRow.role_id) {
      return sendError(res, 403, {
        error: 'role_mismatch',
        code: 'role_mismatch',
        detail: null,
        hint: null,
        request_id,
      });
    }

    const { data: role, error: roleErr } = await supabaseAdmin
      .from('roles')
      .select('id, title, rubric, client_id')
      .eq('id', reqRow.role_id)
      .maybeSingle();
    if (roleErr || !role) {
      return sendError(res, 404, {
        error: 'role_not_found',
        code: roleErr?.code || 'role_not_found',
        detail: roleErr?.message || null,
        hint: roleErr?.hint || null,
        request_id,
      });
    }

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
    let status = 400;
    if (e?.code === 'request_not_approved') status = 403;
    if (e?.code === 'token_secret_missing') status = 500;
    return sendError(res, status, {
      error: e?.message || 'Invalid request',
      code: e?.code || 'invalid_request',
      detail: e?.detail || null,
      hint: e?.hint || null,
      request_id,
    });
  }
});

router.post('/resume', upload.any(), async (req, res) => {
  const request_id = req.request_id || null;
  try {
    const token = String(req.body?.token || '').trim();
    if (!token) {
      return sendError(res, 400, {
        error: 'token_required',
        code: 'token_required',
        detail: null,
        hint: null,
        request_id,
      });
    }
    const decoded = verifyToken(token);
    const reqRow = await loadRequest(decoded.request_id);
    ensureApprovedStatus(reqRow.status);

    const file = (req.files || []).find(f =>
      ['resume', 'resume_file', 'file', 'resumeFile', 'pdf'].includes(f.fieldname)
    );
    if (!file) {
      return sendError(res, 400, {
        error: 'resume_required',
        code: 'resume_required',
        detail: null,
        hint: null,
        request_id,
      });
    }

    const fileType = file.mimetype || 'application/pdf';
    const ext = /pdf/i.test(fileType) ? 'pdf' : 'docx';
    const path = `accommodations/${reqRow.id}.${ext}`;
    let bucket = null;
    try {
      bucket = getAccommodationResumeBucket();
    } catch (e) {
      console.error('[text-interview] resume bucket missing', {
        request_id,
        error: e?.message || e,
        detail: e?.detail || null,
        hint: e?.hint || null,
      });
      return sendError(res, 500, {
        error: e?.code || 'bucket_missing',
        code: e?.code || 'bucket_missing',
        detail: e?.detail || e?.message || null,
        hint: e?.hint || null,
        request_id,
      });
    }
    const up = await supabaseAdmin.storage.from(bucket).upload(path, file.buffer, {
      contentType: fileType,
      upsert: true,
    });
    if (up.error) {
      logSupabaseError('[text-interview] resume upload failed', request_id, up.error);
      return sendError(res, 500, {
        error: 'resume_upload_failed',
        code: up.error.code || 'resume_upload_failed',
        detail: up.error.message || null,
        hint: up.error.hint || null,
        request_id,
      });
    }

    const resume_url = path;
    const resume_received_at = new Date().toISOString();

    const { error: updateErr } = await supabaseAdmin
      .from('accommodation_requests')
      .update({ resume_url, resume_received_at })
      .eq('id', reqRow.id);
    if (updateErr) {
      logSupabaseError('[text-interview] resume update failed', request_id, updateErr);
      return sendError(res, 500, {
        error: 'resume_update_failed',
        code: updateErr.code || 'resume_update_failed',
        detail: updateErr.message || null,
        hint: updateErr.hint || null,
        request_id,
      });
    }

    if (reqRow.candidate_id) {
      const { data: cand } = await supabaseAdmin
        .from('candidates')
        .select('resume_url')
        .eq('id', reqRow.candidate_id)
        .maybeSingle();
      if (!cand?.resume_url) {
        const { error: candUpdateErr } = await supabaseAdmin
          .from('candidates')
          .update({ resume_url })
          .eq('id', reqRow.candidate_id);
        if (candUpdateErr) {
          logSupabaseError('[text-interview] candidate resume update failed', request_id, candUpdateErr);
        }
      }
    }

    if (reqRow.candidate_id) {
      const { data: role, error: roleErr } = await supabaseAdmin
        .from('roles')
        .select('id, title, client_id, description, job_description_text')
        .eq('id', reqRow.role_id)
        .maybeSingle();
      if (roleErr || !role) {
        return sendError(res, 404, {
          error: 'role_not_found',
          code: roleErr?.code || 'role_not_found',
          detail: roleErr?.message || null,
          hint: roleErr?.hint || null,
          request_id,
        });
      }
      const roleForResume = {
        ...role,
        description: role.description || role.job_description_text || ''
      };
      try {
        const analysis = await analyzeResume(file.buffer, fileType, roleForResume, reqRow.candidate_id);
        await supabaseAdmin
          .from('candidates')
          .update({ analysis_summary: analysis })
          .eq('id', reqRow.candidate_id);
        console.log('resume_scored', { request_id, candidate_id: reqRow.candidate_id, role_id: reqRow.role_id });
      } catch (e) {
        console.warn('[text-interview] resume scoring failed', { request_id, error: e?.message || e });
      }
    }

    return res.json({ ok: true });
  } catch (e) {
    if (e?.code) {
      const status = e.code === 'request_not_approved' ? 403 : (e.code === 'openai_missing' ? 500 : 400);
      return sendError(res, status, {
        error: e?.message || 'Invalid request',
        code: e?.code || 'invalid_request',
        detail: e?.detail || null,
        hint: e?.hint || null,
        request_id,
      });
    }
    console.error('[text-interview] resume upload failed', {
      request_id,
      error: e?.message || e,
      detail: e?.detail || null,
      hint: e?.hint || null,
    });
    return sendError(res, 500, {
      error: 'resume_upload_failed',
      code: 'resume_upload_failed',
      detail: e?.message || null,
      hint: e?.hint || null,
      request_id,
    });
  }
});

router.post('/answers', async (req, res) => {
  const request_id = req.request_id || null;
  try {
    const token = String(req.body?.token || '').trim();
    const answers = Array.isArray(req.body?.answers) ? req.body.answers : null;
    if (!token) {
      return sendError(res, 400, {
        error: 'token_required',
        code: 'token_required',
        detail: null,
        hint: null,
        request_id,
      });
    }
    if (!answers || answers.length === 0) {
      return sendError(res, 400, {
        error: 'answers_required',
        code: 'answers_required',
        detail: null,
        hint: null,
        request_id,
      });
    }
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
    if (!resumePresent) {
      return sendError(res, 400, {
        error: 'resume_required',
        code: 'resume_required',
        detail: null,
        hint: null,
        request_id,
      });
    }

    const { data: role } = await supabaseAdmin
      .from('roles')
      .select('id, title, rubric, client_id, description, job_description_text')
      .eq('id', reqRow.role_id)
      .maybeSingle();
    if (!role) {
      return sendError(res, 404, {
        error: 'role_not_found',
        code: 'role_not_found',
        detail: null,
        hint: null,
        request_id,
      });
    }

    const firstSubmit = !reqRow.text_completed_at;

    await supabaseAdmin
      .from('accommodation_requests')
      .update({ text_answers: answers })
      .eq('id', reqRow.id);

    if (firstSubmit && reqRow.candidate_id) {
      const availability = await getRoleInterviewAvailability({
        db: supabaseAdmin,
        roleId: role.id,
        clientId: role.client_id || null
      });
      await syncRoleInterviewLimitNotification({
        db: supabaseAdmin,
        roleId: role.id,
        clientId: role.client_id || null,
        remainingInterviews: availability.remaining_interviews,
        roleTitle: role.title || ''
      });
      if (availability.remaining_interviews != null && availability.remaining_interviews <= 0) {
        return sendError(res, 403, {
          error: 'interview_limit_reached',
          code: 'interview_limit_reached',
          detail: 'This role has no interviews remaining under the current plan.',
          hint: null,
          request_id,
        });
      }

      const scoring = await scoreTextInterview({ role, answers });
      const summaryNote = scoring.summary
        ? `${TEXT_COMPLETION_NOTE} ${scoring.summary}`.trim()
        : TEXT_COMPLETION_NOTE;

      const { data: latestReport } = await supabaseAdmin
        .from('reports')
        .select('id, resume_score, resume_breakdown, analysis')
        .eq('candidate_id', reqRow.candidate_id)
        .eq('role_id', role.id)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      let resumeScore = toScoreOrNull(latestReport?.resume_score);
      let resumeBreakdown = latestReport?.resume_breakdown || null;

      if (resumeScore == null) {
        const { data: cand } = await supabaseAdmin
          .from('candidates')
          .select('analysis_summary')
          .eq('id', reqRow.candidate_id)
          .maybeSingle();
        const candResume = cand?.analysis_summary || null;
        resumeScore = toScoreOrNull(candResume?.resume_score);
        if (!resumeBreakdown && candResume) resumeBreakdown = candResume;
      }

      const interviewScore = clampScore(scoring.interview_score);
      const overallScore = resumeScore == null
        ? interviewScore
        : clampScore((resumeScore + interviewScore) / 2);

      const interview_breakdown = {
        clarity: null,
        confidence: null,
        body_language: null,
        summary: summaryNote,
      };

      const interviewAnalysis = {
        mode: 'text',
        summary: summaryNote,
        scores: {
          interview_score: interviewScore,
          clarity: null,
          confidence: null,
          body_language: null,
        },
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
      const postInsertAvailability = await getRoleInterviewAvailability({
        db: supabaseAdmin,
        roleId: role.id,
        clientId: role.client_id || null
      });
      await syncRoleInterviewLimitNotification({
        db: supabaseAdmin,
        roleId: role.id,
        clientId: role.client_id || null,
        remainingInterviews: postInsertAvailability.remaining_interviews,
        roleTitle: role.title || ''
      });

      if (latestReport?.id) {
        const reportAnalysis = {
          ...(latestReport.analysis || {}),
          mode: 'text',
          summary: summaryNote,
          interview_score: interviewScore,
        };
        await supabaseAdmin
          .from('reports')
          .update({
            interview_score: interviewScore,
            overall_score: overallScore,
            interview_breakdown,
            analysis: reportAnalysis,
          })
          .eq('id', latestReport.id);
      } else {
        await supabaseAdmin.from('reports').insert({
          candidate_id: reqRow.candidate_id,
          role_id: role.id,
          client_id: role.client_id || null,
          resume_score: resumeScore,
          resume_breakdown: resumeBreakdown,
          interview_score: interviewScore,
          overall_score: overallScore,
          interview_breakdown,
          analysis: { summary: summaryNote, mode: 'text', interview_score: interviewScore },
        });
      }

      await supabaseAdmin
        .from('accommodation_requests')
        .update({ text_completed_at: new Date().toISOString() })
        .eq('id', reqRow.id);

      await supabaseAdmin
        .from('candidates')
        .update({ status: 'Interview Completed (Text)', interview_status: 'Interview Completed (Text)' })
        .eq('id', reqRow.candidate_id);

      console.log('text_interview_scored', {
        request_id,
        candidate_id: reqRow.candidate_id,
        role_id: role.id,
        interview_score: interviewScore,
        overall_score: overallScore,
      });
    }

    return res.json({ ok: true });
  } catch (e) {
    if (e?.code) {
      const status = e.code === 'request_not_approved' ? 403 : 400;
      return sendError(res, status, {
        error: e?.message || 'Invalid request',
        code: e?.code || 'invalid_request',
        detail: e?.detail || null,
        hint: e?.hint || null,
        request_id,
      });
    }
    console.error('[text-interview] answers failed', {
      request_id,
      error: e?.message || e,
      detail: e?.detail || null,
      hint: e?.hint || null,
    });
    return sendError(res, 500, {
      error: 'submission_failed',
      code: 'submission_failed',
      detail: e?.message || null,
      hint: e?.hint || null,
      request_id,
    });
  }
});

module.exports = router;
