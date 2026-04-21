// routes/accommodationRequests.js
const express = require('express');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const sg = require('@sendgrid/mail');
const analyzeResume = require('../analyzeResume');
const { supabaseAdmin } = require('../src/lib/supabaseClient');
const { requireAuth } = require('../src/middleware/auth');
const { getRequestSubjectKey, checkAndIncrementRateLimit } = require('../src/lib/rateLimit');
const { redactEmail } = require('../src/lib/recoveryHelper');
const { checkDuplicateCandidate, normalizeEmail, normalizePhone } = require('../src/lib/duplicateCandidate');
const { buildTextInterviewUrl } = require('../config/urlConfig');
const { buildBrandedEmailShell, escapeHtml } = require('../utils/mailer');

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
const TEXT_INTERVIEW_TOKEN_SECRET = String(process.env.TEXT_INTERVIEW_JWT_SECRET || process.env.SUPABASE_JWT_SECRET || '').trim();
function safeText(v) {
  return String(v || '').trim();
}

function buildTextInterviewLinkEmailHtml({ candidateName, interviewLink }) {
  const safeCandidateName = escapeHtml(candidateName || '');
  const safeInterviewLink = escapeHtml(interviewLink || '');
  const greeting = safeCandidateName ? `Hi ${safeCandidateName},` : 'Hi,';
  return buildBrandedEmailShell({
    preheader: 'Your interview link is ready.',
    title: `${APP_NAME} text interview link`,
    contentHtml: `
      <p style="margin:0 0 12px;color:#C9D3FF;font-size:15px;line-height:1.6;">
        ${greeting}
      </p>
      <p style="margin:0 0 18px;color:#C9D3FF;font-size:15px;line-height:1.6;">
        Your interview link is ready. Use the button below to start your text interview.
      </p>
      <p style="margin:0 0 18px;">
        <a class="cta" href="${safeInterviewLink}" target="_blank" rel="noopener noreferrer" style="display:inline-block;background:#A78BFA;color:#0A1547;border:1px solid #CFCBFF;border-radius:10px;padding:11px 18px;font-size:14px;font-weight:700;line-height:1;">
          Start text interview
        </a>
      </p>
      <p style="margin:0 0 16px;color:#C9D3FF;font-size:14px;line-height:1.55;">
        If the button doesn’t work, <a href="${safeInterviewLink}" target="_blank" rel="noopener noreferrer" style="color:#FFFFFF;">click here</a> to open your interview link.
      </p>
      <p style="margin:0 0 16px;color:#C9D3FF;font-size:14px;line-height:1.55;">
        If you did not request this, please ignore this email.
      </p>
    `
  });
}

function buildAccommodationNotifyEmailHtml({
  requestId,
  roleTitle,
  roleId,
  candidateName,
  candidateEmail,
  candidatePhone,
  requestText,
  resumeUrl,
  createdAt
}) {
  const safeRequestText = escapeHtml(requestText || '').replace(/\n/g, '<br />');
  const detailRows = [
    ['Request ID', escapeHtml(requestId || '')],
    ['Role', escapeHtml(roleTitle || '')],
    ['Role ID', escapeHtml(roleId || '')],
    ['Candidate', escapeHtml(candidateName || '')],
    ['Email', escapeHtml(candidateEmail || '')],
    candidatePhone ? ['Phone', escapeHtml(candidatePhone)] : null,
    ['Created', escapeHtml(createdAt || '')]
  ].filter(Boolean);

  return buildBrandedEmailShell({
    preheader: `New accommodation request (${requestId || ''})`,
    title: 'New accommodation request',
    contentHtml: `
      <p style="margin:0 0 14px;color:#C9D3FF;font-size:15px;line-height:1.6;">
        A new accommodation request has been submitted and may require follow-up.
      </p>
      <table role="presentation" width="100%" style="margin:0 0 14px;">
        ${detailRows.map(([label, value]) => `
          <tr>
            <td style="padding:5px 0;color:#9FB0FF;font-size:13px;line-height:1.4;vertical-align:top;width:140px;">${label}</td>
            <td style="padding:5px 0;color:#E6EBFF;font-size:13px;line-height:1.4;vertical-align:top;">${value}</td>
          </tr>
        `).join('')}
        <tr>
          <td style="padding:5px 0;color:#9FB0FF;font-size:13px;line-height:1.4;vertical-align:top;width:140px;">Request</td>
          <td style="padding:5px 0;color:#E6EBFF;font-size:13px;line-height:1.5;vertical-align:top;">${safeRequestText || '(none provided)'}</td>
        </tr>
        ${resumeUrl ? `
          <tr>
            <td style="padding:5px 0;color:#9FB0FF;font-size:13px;line-height:1.4;vertical-align:top;width:140px;">Resume</td>
            <td style="padding:5px 0;color:#E6EBFF;font-size:13px;line-height:1.4;vertical-align:top;">
              <a href="${escapeHtml(resumeUrl)}" target="_blank" rel="noopener noreferrer" style="color:#FFFFFF;">Open resume</a>
            </td>
          </tr>
        ` : ''}
      </table>
    `
  });
}

async function accommodationRequestRateLimit(req, res, next) {
  try {
    const result = await checkAndIncrementRateLimit({
      routeName: 'accommodation_request',
      subjectKey: getRequestSubjectKey(req),
      windowMs: ACCOMMODATION_REQUEST_RATE_WINDOW_MS,
      maxCount: ACCOMMODATION_REQUEST_RATE_MAX
    });
    if (!result.allowed) {
      return res.status(429).json({
        error: 'rate_limited',
        code: 'RATE_LIMIT_EXCEEDED',
        detail: 'Too many requests. Please try again later.',
        request_id: req.request_id || null
      });
    }
  } catch (error) {
    console.error('[rate-limit] accommodation request check failed', {
      request_id: req.request_id || null,
      error: error?.message || error
    });
    return res.status(503).json({
      error: 'rate_limit_unavailable',
      code: 'RATE_LIMIT_UNAVAILABLE',
      detail: 'Request protection is temporarily unavailable. Please try again shortly.',
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

function sendPublicRequestFailed(res, request_id) {
  return res.status(400).json({
    error: 'request_failed',
    code: 'REQUEST_FAILED',
    detail: 'We could not process this request. Please review your information and try again.',
    request_id,
  });
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

function parseBucketPath(v) {
  if (!v || typeof v !== 'string') return null;
  const s = v.trim();
  if (!s) return null;
  if (!/^https?:\/\//i.test(s)) {
    const i = s.indexOf('/');
    return i > 0 ? { bucket: s.slice(0, i), path: s.slice(i + 1) } : null;
  }
  try {
    const u = new URL(s);
    const parts = u.pathname.split('/').filter(Boolean);
    const idx = parts.findIndex((p) => p === 'public' || p === 'sign');
    if (idx >= 0 && parts[idx + 1]) {
      const bucket = parts[idx + 1];
      const path = parts.slice(idx + 2).join('/');
      if (bucket && path) return { bucket, path };
    }
  } catch (_) {}
  return null;
}

async function signResumeUrl(raw, { forceAccommodationBucket = false } = {}) {
  const value = String(raw || '').trim();
  if (!value) return null;
  if (/^https?:\/\//i.test(value)) return value;

  let bucket = null;
  let path = null;

  if (forceAccommodationBucket) {
    bucket = getAccommodationResumeBucket();
    path = value.replace(/^\/+/, '');
  } else {
    const parsed = parseBucketPath(value);
    if (parsed) {
      bucket = parsed.bucket;
      path = parsed.path;
    } else {
      bucket = process.env.SUPABASE_RESUMES_BUCKET || 'resumes';
      path = value.replace(/^\/+/, '');
    }
  }

  const expires = Number(process.env.SIGNED_URL_TTL_SECONDS || 600);
  const { data: signed, error } = await supabaseAdmin.storage.from(bucket).createSignedUrl(path, expires);
  if (error || !signed?.signedUrl) throw error || new Error('signed_url_missing');
  return signed.signedUrl;
}

async function enrichRequestForAdmin(row, { roleTitle = '', candidateResumeUrl = null, request_id = null } = {}) {
  let signedResumeUrl = null;
  try {
    if (row?.resume_url) {
      signedResumeUrl = await signResumeUrl(row.resume_url, { forceAccommodationBucket: true });
    } else if (candidateResumeUrl) {
      signedResumeUrl = await signResumeUrl(candidateResumeUrl, { forceAccommodationBucket: false });
    }
  } catch (error) {
    console.error('[accommodation] resume signed url failed', {
      request_id,
      accommodation_request_id: row?.id || null,
      error: error?.message || error,
      detail: error?.detail || null,
      hint: error?.hint || null,
    });
  }

  return {
    ...row,
    role: { title: roleTitle || '' },
    resume_url: signedResumeUrl || null,
  };
}

function buildTextInterviewToken(reqRow) {
  if (!TEXT_INTERVIEW_TOKEN_SECRET) {
    const err = new Error('TEXT_INTERVIEW_JWT_SECRET or SUPABASE_JWT_SECRET not configured');
    err.code = 'token_secret_missing';
    err.detail = 'TEXT_INTERVIEW_JWT_SECRET or SUPABASE_JWT_SECRET not configured';
    throw err;
  }
  return jwt.sign(
    {
      mode: 'text',
      request_id: reqRow.id,
      role_id: reqRow.role_id,
    },
    TEXT_INTERVIEW_TOKEN_SECRET,
    { expiresIn: '14d' }
  );
}

/**
 * GET /admin/accommodation-requests
 * Admin list endpoint for accommodation requests.
 */
router.get('/', requireAuth, requireAdmin, async (req, res) => {
  const request_id = req.request_id || null;
  try {
    const status = String(req.query.status || '').trim();
    const clientId = String(req.query.client_id || '').trim();
    let clientRoles = null;
    let q = supabaseAdmin
      .from('accommodation_requests')
      .select('id, created_at, role_id, candidate_id, candidate_name, candidate_email, candidate_phone, request_text, status, resume_url, resume_received_at, admin_notes, approved_at, sent_at')
      .order('created_at', { ascending: false });
    if (status) {
      q = q.eq('status', status);
    }
    if (clientId) {
      const { data: roles, error: rErr } = await supabaseAdmin.from('roles').select('id, title').eq('client_id', clientId);
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
      clientRoles = roles;
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
    const rows = data || [];
    if (!rows.length) return res.json({ ok: true, items: [] });

    const roleById = new Map((clientRoles || []).map((r) => [r.id, r]));
    const missingRoleIds = [...new Set(rows.map((row) => row.role_id).filter(Boolean))]
      .filter((roleId) => !roleById.has(roleId));
    if (missingRoleIds.length) {
      const { data: roleRows, error: roleErr } = await supabaseAdmin
        .from('roles')
        .select('id, title')
        .in('id', missingRoleIds);
      if (roleErr) {
        return sendError(res, 500, {
          error: 'Failed to fetch role titles.',
          code: 'roles_lookup_failed',
          detail: roleErr.message || null,
          hint: roleErr.hint || null,
          request_id,
        });
      }
      for (const role of roleRows || []) roleById.set(role.id, role);
    }

    const candidateIds = [...new Set(rows
      .filter((row) => !row.resume_url && row.candidate_id)
      .map((row) => row.candidate_id))];
    const candidateById = new Map();
    if (candidateIds.length) {
      const { data: candidates, error: cErr } = await supabaseAdmin
        .from('candidates')
        .select('id, resume_url')
        .in('id', candidateIds);
      if (cErr) {
        logSupabaseError('[accommodation] candidate fallback lookup failed', request_id, cErr);
      } else {
        for (const candidate of candidates || []) candidateById.set(candidate.id, candidate);
      }
    }

    const items = await Promise.all(rows.map((row) => enrichRequestForAdmin(row, {
      roleTitle: roleById.get(row.role_id)?.title || '',
      candidateResumeUrl: candidateById.get(row.candidate_id)?.resume_url || null,
      request_id,
    })));

    return res.json({ ok: true, items });
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

router.patch('/:id', requireAuth, requireAdmin, async (req, res) => {
  const request_id = req.request_id || null;
  const id = String(req.params?.id || '').trim();
  const payload = req.body || {};
  try {
    const { data: existing, error: fetchErr } = await supabaseAdmin
      .from('accommodation_requests')
      .select('id, created_at, role_id, candidate_id, candidate_name, candidate_email, candidate_phone, request_text, status, resume_url, resume_received_at, admin_notes, approved_at, sent_at')
      .eq('id', id)
      .maybeSingle();
    if (fetchErr) {
      return sendError(res, 500, {
        error: 'Failed to load accommodation request.',
        code: 'accommodation_request_fetch_failed',
        detail: fetchErr.message || null,
        hint: fetchErr.hint || null,
        request_id,
      });
    }
    if (!existing) {
      return sendError(res, 404, {
        error: 'accommodation_request_not_found',
        code: 'accommodation_request_not_found',
        detail: null,
        hint: null,
        request_id,
      });
    }

    const updates = {};
    if (Object.prototype.hasOwnProperty.call(payload, 'status')) {
      const normalizedStatus = String(payload.status || '').trim().toLowerCase();
      if (!['pending', 'approved', 'sent', 'denied'].includes(normalizedStatus)) {
        return sendError(res, 400, {
          error: 'invalid_status',
          code: 'invalid_status',
          detail: 'Status must be one of: pending, approved, sent, denied.',
          hint: null,
          request_id,
        });
      }
      updates.status = normalizedStatus;
      if (normalizedStatus === 'approved' && !existing.approved_at) {
        updates.approved_at = new Date().toISOString();
      }
    }
    if (Object.prototype.hasOwnProperty.call(payload, 'admin_notes')) {
      updates.admin_notes = String(payload.admin_notes ?? '').trim().slice(0, 5000);
    }

    let row = existing;
    if (Object.keys(updates).length) {
      const { data: updated, error: updateErr } = await supabaseAdmin
        .from('accommodation_requests')
        .update(updates)
        .eq('id', id)
        .select('id, created_at, role_id, candidate_id, candidate_name, candidate_email, candidate_phone, request_text, status, resume_url, resume_received_at, admin_notes, approved_at, sent_at')
        .maybeSingle();
      if (updateErr || !updated) {
        return sendError(res, 500, {
          error: 'Failed to update accommodation request.',
          code: 'accommodation_request_update_failed',
          detail: updateErr?.message || null,
          hint: updateErr?.hint || null,
          request_id,
        });
      }
      row = updated;
    }

    const [roleResp, candidateResp] = await Promise.all([
      supabaseAdmin.from('roles').select('id, title').eq('id', row.role_id).maybeSingle(),
      row.candidate_id
        ? supabaseAdmin.from('candidates').select('id, resume_url').eq('id', row.candidate_id).maybeSingle()
        : Promise.resolve({ data: null, error: null }),
    ]);
    if (roleResp.error) {
      return sendError(res, 500, {
        error: 'Failed to fetch role title.',
        code: 'roles_lookup_failed',
        detail: roleResp.error.message || null,
        hint: roleResp.error.hint || null,
        request_id,
      });
    }
    if (candidateResp.error) {
      logSupabaseError('[accommodation] candidate fallback lookup failed', request_id, candidateResp.error);
    }

    const item = await enrichRequestForAdmin(row, {
      roleTitle: roleResp.data?.title || '',
      candidateResumeUrl: candidateResp.data?.resume_url || null,
      request_id,
    });
    return res.json({ ok: true, item });
  } catch (error) {
    return sendError(res, 500, {
      error: 'Server error.',
      code: 'accommodation_request_update_failed',
      detail: error?.message || null,
      hint: error?.hint || null,
      request_id,
    });
  }
});

router.post('/:id/send-text-link', requireAuth, requireAdmin, async (req, res) => {
  const request_id = req.request_id || null;
  const id = String(req.params?.id || '').trim();
  try {
    const { data: reqRow, error: fetchErr } = await supabaseAdmin
      .from('accommodation_requests')
      .select('id, role_id, candidate_name, candidate_email, status')
      .eq('id', id)
      .maybeSingle();
    if (fetchErr) {
      return sendError(res, 500, {
        error: 'Failed to load accommodation request.',
        code: 'accommodation_request_fetch_failed',
        detail: fetchErr.message || null,
        hint: fetchErr.hint || null,
        request_id,
      });
    }
    if (!reqRow) {
      return sendError(res, 404, {
        error: 'accommodation_request_not_found',
        code: 'accommodation_request_not_found',
        detail: null,
        hint: null,
        request_id,
      });
    }

    const currentStatus = String(reqRow.status || '').trim().toLowerCase();
    if (!['approved', 'sent'].includes(currentStatus)) {
      return sendError(res, 400, {
        error: 'invalid_status',
        code: 'invalid_status',
        detail: 'Text interview links can only be sent for approved or sent requests.',
        hint: null,
        request_id,
      });
    }
    if (!SENDGRID_KEY || !FROM_EMAIL) {
      return sendError(res, 500, {
        error: 'sendgrid_not_configured',
        code: 'sendgrid_not_configured',
        detail: 'SENDGRID_API_KEY or SENDGRID_FROM not configured.',
        hint: null,
        request_id,
      });
    }

    let token = '';
    try {
      token = buildTextInterviewToken(reqRow);
    } catch (e) {
      return sendError(res, 500, {
        error: e?.code || 'token_secret_missing',
        code: e?.code || 'token_secret_missing',
        detail: e?.detail || e?.message || null,
        hint: e?.hint || null,
        request_id,
      });
    }

    const interviewLink = buildTextInterviewUrl(token);
    const candidateName = String(reqRow.candidate_name || '').trim();
    const textBody = [
      candidateName ? `Hi ${candidateName},` : 'Hi,',
      '',
      'Your interview link is ready. Use the link below to start your text interview:',
      interviewLink,
      '',
      'If you did not request this, please ignore this email.',
    ].join('\n');

    try {
      await sg.send({
        to: reqRow.candidate_email,
        from: { email: FROM_EMAIL, name: APP_NAME },
        subject: `${APP_NAME} text interview link`,
        text: textBody,
        html: buildTextInterviewLinkEmailHtml({ candidateName, interviewLink })
      });
    } catch (e) {
      return sendError(res, 500, {
        error: 'send_text_link_failed',
        code: 'send_text_link_failed',
        detail: e?.message || null,
        hint: null,
        request_id,
      });
    }

    const nextUpdate = { sent_at: new Date().toISOString() };
    if (currentStatus === 'approved') nextUpdate.status = 'sent';
    const { error: updateErr } = await supabaseAdmin
      .from('accommodation_requests')
      .update(nextUpdate)
      .eq('id', reqRow.id);
    if (updateErr) {
      logSupabaseError('[accommodation] send-text-link update failed', request_id, updateErr);
      return sendError(res, 500, {
        error: 'accommodation_request_update_failed',
        code: 'accommodation_request_update_failed',
        detail: updateErr.message || null,
        hint: updateErr.hint || null,
        request_id,
      });
    }

    return res.json({ ok: true });
  } catch (error) {
    return sendError(res, 500, {
      error: 'Server error.',
      code: 'send_text_link_failed',
      detail: error?.message || null,
      hint: error?.hint || null,
      request_id,
    });
  }
});

/**
 * POST /api/accommodations/request
 * Candidate-facing accommodation request form.
 */
router.post('/request', accommodationRequestRateLimit, upload.any(), async (req, res) => {
  const request_id = req.request_id || null;
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
      return sendPublicRequestFailed(res, request_id);
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
      return sendPublicRequestFailed(res, request_id);
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

    let resume_url = null;
    let candidate_resume_url = null;
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
        candidate_resume_url = `${bucket}/${path}`;
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
      if (!existingResumeUrl && candidate_id && candidate_resume_url) {
        const { error: candUpdateErr } = await supabaseAdmin
          .from('candidates')
          .update({ resume_url: candidate_resume_url })
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
        html: buildAccommodationNotifyEmailHtml({
          requestId: reqRow.id,
          roleTitle: role.title || role.id,
          roleId: role.id,
          candidateName: candidate_name,
          candidateEmail: candidate_email,
          candidatePhone: candidate_phone,
          requestText: request_text,
          resumeUrl: resume_url,
          createdAt: reqRow.created_at
        })
      });
      notifySent = resp?.statusCode === 202;
    } catch (e) {
      console.error('[accommodation] notify email failed', { request_id: reqRow.id, error: e?.message || e });
    }

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
