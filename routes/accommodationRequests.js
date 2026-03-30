// routes/accommodationRequests.js
const express = require('express');
const crypto = require('crypto');
const multer = require('multer');
const sg = require('@sendgrid/mail');
const analyzeResume = require('../analyzeResume');
const { supabaseAdmin } = require('../src/lib/supabaseClient');
const { requireAuth } = require('../src/middleware/auth');
const { redactEmail } = require('../src/lib/recoveryHelper');
const { checkDuplicateCandidate, normalizeEmail, normalizePhone } = require('../src/lib/duplicateCandidate');

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
});

const SENDGRID_KEY = process.env.SENDGRID_API_KEY;
const FROM_EMAIL = process.env.SENDGRID_FROM;
const APP_NAME = process.env.APP_NAME || 'Interview Agent';
const NOTIFY_EMAIL = process.env.ACCOMMODATION_NOTIFY_EMAIL || 'info@alphasourceai.com';

if (SENDGRID_KEY) sg.setApiKey(SENDGRID_KEY);

const isValidEmail = (value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || '').trim());
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const isUuid = (value) => UUID_RE.test(String(value || '').trim());
const ACCOMMODATION_REQUEST_RATE_WINDOW_MS = 60 * 60 * 1000;
const ACCOMMODATION_REQUEST_RATE_MAX = 10;
const accommodationRequestRateBuckets = new Map();
function safeText(v) {
  return String(v || '').trim();
}

function accommodationRequestRateLimit(req, res, next) {
  const now = Date.now();
  const ip = String((req.headers['x-forwarded-for'] || req.ip || 'unknown')).split(',')[0].trim() || 'unknown';
  const current = accommodationRequestRateBuckets.get(ip);
  const bucket = (!current || current.resetAt <= now)
    ? { count: 0, resetAt: now + ACCOMMODATION_REQUEST_RATE_WINDOW_MS }
    : current;
  bucket.count += 1;
  accommodationRequestRateBuckets.set(ip, bucket);
  if (bucket.count > ACCOMMODATION_REQUEST_RATE_MAX) {
    return res.status(429).json({
      error: 'rate_limited',
      code: 'RATE_LIMIT_EXCEEDED',
      detail: 'Too many requests. Please try again later.',
      request_id: req.request_id || null
    });
  }
  return next();
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

function requireAdmin(req, res, next) {
  if (req.isGlobalAdmin === true || req.isAdmin === true) return next();
  return res.status(403).json({ error: 'not_admin' });
}

async function findOrCreateCandidate({ role, name, email, phone }) {
  let existing = null;
  try {
    const { data, error } = await supabaseAdmin
      .from('candidates')
      .select('id, resume_url')
      .eq('role_id', role.id)
      .eq('email', email)
      .limit(1)
      .maybeSingle();
    if (!error && data) existing = data;
  } catch (_) {}

  if (existing) {
    return { id: existing.id, resume_url: existing.resume_url || null, created: false };
  }

  const { data: inserted, error: cErr } = await supabaseAdmin
    .from('candidates')
    .insert({
      role_id: role.id,
      client_id: role.client_id || null,
      name,
      email,
      phone,
      status: 'Accommodation Requested',
      interview_status: 'Accommodation Requested',
    })
    .select('id')
    .single();
  if (cErr) throw new Error(cErr.message);

  const candidateId = inserted.id;
  await supabaseAdmin.from('candidates').update({ candidate_id: candidateId }).eq('id', candidateId);

  return { id: candidateId, resume_url: null, created: true };
}

/**
 * GET /admin/accommodation-requests
 * Admin list endpoint for accommodation requests.
 */
router.get('/', requireAuth, requireAdmin, async (req, res) => {
  const request_id = req.request_id || crypto.randomUUID?.() || String(Date.now());
  try {
    const status = String(req.query.status || '').trim();
    const clientId = String(req.query.client_id || '').trim();
    let q = supabaseAdmin
      .from('accommodation_requests')
      .select('id, created_at, role_id, candidate_id, candidate_name, candidate_email, candidate_phone, request_text, status, resume_url, resume_received_at, admin_notes')
      .order('created_at', { ascending: false });
    if (status) {
      q = q.eq('status', status);
    }
    if (clientId) {
      const { data: roles, error: rErr } = await supabaseAdmin.from('roles').select('id').eq('client_id', clientId);
      if (rErr) {
        return sendError(res, 500, {
          error: 'Failed to fetch roles for client.',
          code: 'roles_lookup_failed',
          detail: rErr.message || null,
          hint: rErr.hint || null,
          request_id,
        });
      }
      if (!roles || roles.length === 0) {
        return res.json({ ok: true, items: [] });
      }
      q = q.in('role_id', roles.map(r => r.id));
    }
    const { data, error } = await q;
    if (error) {
      return sendError(res, 500, {
        error: 'Failed to fetch accommodation requests.',
        code: 'accommodation_requests_fetch_failed',
        detail: error.message || null,
        hint: error.hint || null,
        request_id,
      });
    }
    return res.json({ ok: true, items: data || [] });
  } catch (error) {
    return sendError(res, 500, {
      error: 'Server error.',
      code: 'accommodation_requests_fetch_failed',
      detail: error?.message || null,
      hint: null,
      request_id,
    });
  }
});

/**
 * POST /api/accommodations/request
 * Candidate-facing accommodation request form.
 */
router.post('/request', accommodationRequestRateLimit, upload.any(), async (req, res) => {
  const request_id = req.request_id || crypto.randomUUID?.() || String(Date.now());
  try {
    const candidate_name = safeText(req.body?.candidate_name || req.body?.name);
    const candidate_email = normalizeEmail(req.body?.candidate_email || req.body?.email);
    const candidate_phone_raw = safeText(req.body?.candidate_phone || req.body?.phone);
    const candidate_phone = normalizePhone(candidate_phone_raw);
    const request_text = safeText(req.body?.accommodation_request_text || req.body?.request_text);
    const role_token = safeText(req.body?.role_token);
    const role_id_in = safeText(req.body?.role_id);
    const role_lookup_value = role_id_in || role_token;
    const role_lookup_is_uuid = isUuid(role_lookup_value);
    const lookupAttempts = role_lookup_value ? (role_lookup_is_uuid ? ['id', 'slug_or_token'] : ['slug_or_token']) : [];

    if (!candidate_name || !candidate_email || !candidate_phone || !request_text || (!role_token && !role_id_in)) {
      return sendError(res, 400, {
        error: 'Missing required fields.',
        code: 'missing_fields',
        detail: null,
        hint: null,
        request_id,
      });
    }
    if (!isValidEmail(candidate_email)) {
      return sendError(res, 400, {
        error: 'Invalid email address.',
        code: 'invalid_email',
        detail: null,
        hint: null,
        request_id,
      });
    }

    let role = null;
    const attempted = [];
    const roleTokenForLog = role_lookup_value ? String(role_lookup_value).slice(0, 40) : null;
    if (role_lookup_value && role_lookup_is_uuid) {
      attempted.push('id');
      const { data: roleById, error: idErr } = await supabaseAdmin
        .from('roles')
        .select('id, title, client_id, slug_or_token, description, job_description_text')
        .eq('id', role_lookup_value)
        .limit(1)
        .maybeSingle();
      if (idErr || !roleById) {
        console.warn('[accommodation] role lookup failed', {
          request_id,
          lookup: 'id',
          role_token: roleTokenForLog,
          attempted,
          error: idErr?.message || null,
        });
      } else {
        role = roleById;
      }
    }
    if (!role && role_lookup_value) {
      attempted.push('slug_or_token');
      const { data: roleBySlug, error: slugErr } = await supabaseAdmin
        .from('roles')
        .select('id, title, client_id, slug_or_token, description, job_description_text')
        .eq('slug_or_token', role_lookup_value)
        .limit(1)
        .maybeSingle();
      if (slugErr || !roleBySlug) {
        console.warn('[accommodation] role lookup failed', {
          request_id,
          lookup: 'slug_or_token',
          role_token: roleTokenForLog,
          attempted,
          error: slugErr?.message || null,
        });
      } else {
        role = roleBySlug;
      }
    }
    if (!role) {
      return sendError(res, 404, {
        error: 'role_not_found',
        code: 'role_not_found',
        detail: 'Role not found for supplied request link.',
        hint: 'Use the role link provided for this request.',
        request_id,
      });
    }

    const dup = await checkDuplicateCandidate({
      supabase: supabaseAdmin,
      roleId: role.id,
      email: candidate_email,
      fullName: candidate_name,
      phone: candidate_phone,
      allowPhoneEnrich: true,
    });
    if (dup.duplicate) {
      console.warn('[accommodation] duplicate candidate blocked', {
        request_id,
        role_id: role.id,
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

    const { id: candidate_id, resume_url: existingResumeUrl } = await findOrCreateCandidate({
      role,
      name: candidate_name,
      email: candidate_email,
      phone: candidate_phone || null,
    });

    const { data: reqRow, error: reqErr } = await supabaseAdmin
      .from('accommodation_requests')
      .insert({
        role_id: role.id,
        candidate_id,
        candidate_name,
        candidate_email,
        candidate_phone: candidate_phone || null,
        request_text,
        status: 'pending',
      })
      .select('*')
      .single();
    if (reqErr || !reqRow) {
      return sendError(res, 500, {
        error: 'Could not create request.',
        code: reqErr?.code || 'request_insert_failed',
        detail: reqErr?.message || null,
        hint: reqErr?.hint || null,
        request_id,
      });
    }

    console.log('accommodation_request_created', {
      request_id: reqRow.id,
      role_id: role.id,
      candidate_email: redactEmail(candidate_email),
    });

    let resume_url = null;
    let resume_received_at = null;
    let resumeBuffer = null;
    let resumeMime = null;
    const file = (req.files || []).find(f =>
      ['resume', 'resume_file', 'file', 'resumeFile', 'pdf'].includes(f.fieldname)
    );
    if (file) {
      try {
        const bucket = getAccommodationResumeBucket();
        const fileType = file.mimetype || 'application/pdf';
        resumeBuffer = file.buffer;
        resumeMime = fileType;
        const ext = /pdf/i.test(fileType) ? 'pdf' : 'docx';
        const path = `accommodations/${reqRow.id}.${ext}`;
        const up = await supabaseAdmin.storage.from(bucket).upload(path, file.buffer, {
          contentType: fileType,
          upsert: true,
        });
        if (up.error) {
          logSupabaseError('[accommodation] resume upload failed', reqRow.id, up.error);
          return sendError(res, 500, {
            error: 'resume_upload_failed',
            code: up.error.code || 'resume_upload_failed',
            detail: up.error.message || null,
            hint: up.error.hint || null,
            request_id: reqRow.id,
          });
        }
        resume_url = path;
        resume_received_at = new Date().toISOString();
      } catch (e) {
        console.error('[accommodation] resume upload failed', {
          request_id: reqRow.id,
          error: e?.message || e,
          detail: e?.detail || null,
          hint: e?.hint || null,
        });
        return sendError(res, 500, {
          error: e?.code || 'resume_upload_failed',
          code: e?.code || 'resume_upload_failed',
          detail: e?.detail || e?.message || null,
          hint: e?.hint || null,
          request_id: reqRow.id,
        });
      }
    }

    if (resume_url) {
      const { error: updateErr } = await supabaseAdmin
        .from('accommodation_requests')
        .update({ resume_url, resume_received_at })
        .eq('id', reqRow.id);
      if (updateErr) {
        logSupabaseError('[accommodation] resume update failed', reqRow.id, updateErr);
        return sendError(res, 500, {
          error: 'resume_update_failed',
          code: updateErr.code || 'resume_update_failed',
          detail: updateErr.message || null,
          hint: updateErr.hint || null,
          request_id: reqRow.id,
        });
      }
      if (!existingResumeUrl && candidate_id) {
        const { error: candUpdateErr } = await supabaseAdmin
          .from('candidates')
          .update({ resume_url })
          .eq('id', candidate_id);
        if (candUpdateErr) {
          logSupabaseError('[accommodation] candidate resume update failed', reqRow.id, candUpdateErr);
        }
      }
    }

    if (resumeBuffer && candidate_id) {
      const roleForResume = {
        ...role,
        description: role.description || role.job_description_text || ''
      };
      try {
        const analysis = await analyzeResume(resumeBuffer, resumeMime, roleForResume, candidate_id);
        await supabaseAdmin
          .from('candidates')
          .update({ analysis_summary: analysis })
          .eq('id', candidate_id);
        console.log('resume_scored', { request_id: reqRow.id, candidate_id, role_id: role.id });
      } catch (e) {
        console.warn('[accommodation] resume scoring failed', { request_id: reqRow.id, error: e?.message || e });
      }
    }

    let notifySent = false;
    try {
      if (!SENDGRID_KEY || !FROM_EMAIL) throw new Error('SendGrid not configured');
      const textBody = [
        `New accommodation request (${reqRow.id})`,
        `Role: ${role.title || role.id}`,
        `Role ID: ${role.id}`,
        `Candidate: ${candidate_name}`,
        `Email: ${candidate_email}`,
        candidate_phone ? `Phone: ${candidate_phone}` : null,
        `Request: ${request_text}`,
        resume_url ? `Resume: ${resume_url}` : null,
        `Created: ${reqRow.created_at}`
      ].filter(Boolean).join('\n');

      const [resp] = await sg.send({
        to: NOTIFY_EMAIL,
        from: { email: FROM_EMAIL, name: APP_NAME },
        subject: `Accommodation request: ${candidate_name} (${role.title || 'Role'})`,
        text: textBody,
      });
      notifySent = resp?.statusCode === 202;
    } catch (e) {
      console.error('[accommodation] notify email failed', { request_id: reqRow.id, error: e?.message || e });
    }

    console.log('accommodation_notify_sent', {
      request_id: reqRow.id,
      role_id: role.id,
      sent: notifySent,
    });

    return res.status(200).json({ ok: true, request_id: reqRow.id });
  } catch (err) {
    console.error('[accommodation] request error', {
      request_id,
      error: err?.message || err,
      detail: err?.detail || null,
      hint: err?.hint || null,
    });
    return sendError(res, 500, {
      error: 'Server error.',
      code: err?.code || 'server_error',
      detail: err?.message || null,
      hint: err?.hint || null,
      request_id,
    });
  }
});

module.exports = router;
