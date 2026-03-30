// routes/candidateSubmit.js
const express = require('express');
const router = express.Router();
const multer = require('multer');
const sg = require('@sendgrid/mail');
const { supabase, supabaseAdmin } = require('../src/lib/supabaseClient');
const { getRoleInterviewAvailability, syncRoleInterviewLimitNotification } = require('../src/lib/roleInterviewAvailability');
const { getRequestSubjectKey, checkAndIncrementRateLimit } = require('../src/lib/rateLimit');
const analyzeResume = require('../analyzeResume'); // resume analyzer

// uploads: keep in memory; 10MB limit
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
});

// email config
const FROM_EMAIL = process.env.SENDGRID_FROM;
const SENDGRID_KEY = process.env.SENDGRID_API_KEY;
const APP_NAME = process.env.APP_NAME || 'Interview Agent';
const BILLING_MODE = String(process.env.BILLING_MODE || 'off').toLowerCase();
const BILLING_ENFORCED = BILLING_MODE === 'enforce';
if (SENDGRID_KEY) sg.setApiKey(SENDGRID_KEY);
const SUBMIT_RATE_WINDOW_MS = 60 * 60 * 1000;
const SUBMIT_RATE_MAX = 10;

async function candidateSubmitRateLimit(req, res, next) {
  try {
    const result = await checkAndIncrementRateLimit({
      routeName: 'candidate_submit',
      subjectKey: getRequestSubjectKey(req),
      windowMs: SUBMIT_RATE_WINDOW_MS,
      maxCount: SUBMIT_RATE_MAX
    });
    if (!result.allowed) {
      return res.status(429).json({
        error: 'rate_limited',
        code: 'RATE_LIMIT_EXCEEDED',
        detail: 'Too many requests. Please try again later.'
      });
    }
  } catch (error) {
    console.error('[rate-limit] candidate submit check failed', {
      request_id: req.request_id || null,
      error: error?.message || error
    });
    return res.status(503).json({
      error: 'rate_limit_unavailable',
      code: 'RATE_LIMIT_UNAVAILABLE',
      detail: 'Request protection is temporarily unavailable. Please try again shortly.'
    });
  }
  return next();
}

// 6-digit OTP
function six() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

// normalize helpers
function normEmail(v = '') {
  return String(v || '').trim().toLowerCase();
}
function normPhone(v = '') {
  const digits = String(v || '').replace(/\D/g, '');
  // Keep only last 10 digits (NANP style), chopping country codes/leading 1
  return digits.length > 10 ? digits.slice(-10) : digits;
}
function normName(v = '') {
  return String(v || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * POST /api/candidate/submit
 * Accepts multipart form (resume) or JSON (resume_url).
 * Required: email + (name OR first/last) + (role_id OR role_token)
 */
router.post('/', candidateSubmitRateLimit, upload.any(), async (req, res) => {
  try {
    const request_id = req.request_id || null;
    const submissionFailed = (reason, details = {}) => {
      console.warn('[candidate-submit] submission_failed', { request_id, reason, ...details });
      const payload = {
        error: 'submission_failed',
        code: 'SUBMISSION_FAILED',
        detail: 'We could not process this request. Please review your information and try again.'
      };
      if (request_id) payload.request_id = request_id;
      return res.status(400).json(payload);
    };
    // --- normalize inputs ---
    const role_token   = (req.body.role_token || '').trim();
    const role_id_in   = (req.body.role_id || '').trim();
    const first_name   = (req.body.first_name || '').trim();
    const last_name    = (req.body.last_name  || '').trim();
    const rawName      = (req.body.name || '').trim();
    const emailRaw     = (req.body.email || '').trim();
    const phoneRaw     = (req.body.phone || '').trim();
    const resume_url_in = req.body.resume_url || null;

    const fullName = rawName || [first_name, last_name].filter(Boolean).join(' ').trim();

    const email = normEmail(emailRaw);
    const phone = normPhone(phoneRaw);
    const nameNorm = normName(fullName);

    if (!email || !fullName || (!role_token && !role_id_in)) {
      return res.status(400).json({
        error: 'Required: email, (name OR first_name+last_name), and (role_id OR role_token).',
      });
    }

    // --- role lookup (need client_id + description) ---
    let role = null, rErr = null;
    if (role_id_in) {
      ({ data: role, error: rErr } = await supabase
        .from('roles')
        .select('id, title, description, kb_document_id, client_id')
        .eq('id', role_id_in)
        .single());
    } else {
      ({ data: role, error: rErr } = await supabase
        .from('roles')
        .select('id, title, description, kb_document_id, client_id')
        .eq('slug_or_token', role_token)
        .single());
    }
    if (rErr || !role) {
      return submissionFailed('role_not_found', {
        role_id: role_id_in || null,
        role_token: role_token || null
      });
    }
    const roleId = role.id;

    if (BILLING_ENFORCED && role.client_id) {
      const { data: client, error: clientErr } = await supabase
        .from('clients')
        .select('id,billing_status,manual_active_override,access_override_mode,candidate_assistance_contact')
        .eq('id', role.client_id)
        .maybeSingle();

      if (clientErr || !client) {
        return res.status(500).json({
          error: 'server_error',
          code: 'CLIENT_LOOKUP_FAILED',
          detail: clientErr?.message || 'Failed to load client record',
          hint: clientErr?.hint || null,
          request_id
        });
      }

      const accessOverrideMode = String(client.access_override_mode || 'inherit').toLowerCase();
      if (accessOverrideMode === 'force_inactive' || (accessOverrideMode !== 'force_active' && client.billing_status !== 'active')) {
        return res.status(403).json({
          error: 'forbidden',
          code: 'CLIENT_INACTIVE',
          detail: 'Interviewing service is currently inactive for this employer.',
          hint: client.candidate_assistance_contact || 'Please contact the employer.',
          request_id
        });
      }
    }

    const availability = await getRoleInterviewAvailability({
      db: supabaseAdmin,
      roleId,
      clientId: role.client_id || null
    });
    await syncRoleInterviewLimitNotification({
      db: supabaseAdmin,
      roleId,
      clientId: role.client_id || null,
      remainingInterviews: availability.remaining_interviews,
      roleTitle: role?.title || ''
    });
    if (availability.remaining_interviews != null && availability.remaining_interviews <= 0) {
      return res.status(403).json({
        error: 'forbidden',
        code: 'interview_limit_reached',
        detail: 'This role has no interviews remaining under the current plan.',
        hint: null,
        request_id
      });
    }

    // --- duplicate & enrichment policy ---
    // RULES:
    // 1) Email match for this role -> BLOCK (409). Enrich phone if missing, then stop (no OTP, no resume upload, no analysis).
    // 2) If email does NOT match, but (name + phone) BOTH match for this role -> BLOCK (409). Enrich phone on the existing record if missing.
    // 3) Otherwise, ALLOW (create candidate, upload, send OTP).

    // 1) Email match
    let existingByEmail = null;
    {
      const { data, error } = await supabase
        .from('candidates')
        .select('id, name, email, phone')
        .eq('role_id', roleId)
        .eq('email', email)
        .limit(1)
        .maybeSingle();
      if (!error && data) existingByEmail = data;
    }
    if (existingByEmail) {
      // Enrich phone if missing
      if (phone && !existingByEmail.phone) {
        await supabase.from('candidates').update({ phone }).eq('id', existingByEmail.id);
      }
      return submissionFailed('duplicate_email', {
        role_id: roleId,
        candidate_id: existingByEmail.id || null
      });
    }

    // 2) Name + phone match (only if we have both a name and a phone)
    if (fullName && phone) {
      let existingByNamePhone = null;
      const { data, error } = await supabase
        .from('candidates')
        .select('id, phone')
        .eq('role_id', roleId)
        .eq('phone', phone)
        .ilike('name', fullName) // case-insensitive exact match
        .limit(1)
        .maybeSingle();
      if (!error && data) existingByNamePhone = data;

      if (existingByNamePhone) {
        // Enrich phone if the stored record is missing it (defensive; may already be set)
        if (!existingByNamePhone.phone && phone) {
          await supabase.from('candidates').update({ phone }).eq('id', existingByNamePhone.id);
        }
        return submissionFailed('duplicate_name_phone', {
          role_id: roleId,
          candidate_id: existingByNamePhone.id || null
        });
      }
    }

    // --- create candidate (denormalize client_id) ---
    let candidate_id = null;
    {
      const { data: inserted, error: cErr } = await supabase
        .from('candidates')
        .insert({
          role_id: roleId,
          client_id: role.client_id || null,
          name: fullName,
          first_name,
          last_name,
          email,
          phone, // already normalized to last 10 digits
          status: 'Resume Uploaded',
        })
        .select('id')
        .single();
      if (cErr) return res.status(500).json({ error: cErr.message });
      candidate_id = inserted.id;

      // self-reference (candidate_id column)
      await supabase.from('candidates').update({ candidate_id }).eq('id', candidate_id);
    }

    // --- resume upload (optional) ---
    let resume_url = resume_url_in;
    let fileBuf = null, fileType = '';
    try {
      const file = (req.files || []).find(f =>
        ['resume', 'resume_file', 'file', 'resumeFile', 'pdf'].includes(f.fieldname)
      );
      if (file) {
        fileBuf = file.buffer;
        fileType = file.mimetype || 'application/pdf';
        const bucket = process.env.SUPABASE_RESUMES_BUCKET || 'resumes';
        const ext = /pdf/i.test(fileType) ? 'pdf' : 'docx';
        const path = `${candidate_id}.${ext}`;

        const up = await supabase.storage.from(bucket).upload(path, file.buffer, {
          contentType: fileType,
          upsert: true,
        });
        if (!up.error) {
          resume_url = `${bucket}/${path}`;
        }
      }
    } catch (e) {
      console.error('resume upload failed:', e?.message || e);
    }
    if (resume_url) {
      await supabase.from('candidates').update({ resume_url }).eq('id', candidate_id);
    }

    // --- analyze resume (non-fatal) ---
    try {
      if (fileBuf) {
        const summary = await analyzeResume(fileBuf, fileType, role, candidate_id);
        await supabase.from('candidates').update({ analysis_summary: summary }).eq('id', candidate_id);
      }
    } catch (e) {
      console.warn('resume analysis failed:', e?.message || e);
    }

    // --- OTP hardening: invalidate old + create fresh ---
    const nowIso = new Date().toISOString();
    await supabase
      .from('otp_tokens')
      .update({ used: true, used_at: nowIso })
      .eq('candidate_email', email)
      .eq('role_id', roleId)
      .eq('used', false);

    const freshCode = six();
    const { error: otpErr } = await supabase.from('otp_tokens').insert({
      candidate_email: email,
      role_id: roleId,
      code: freshCode,
      expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
      used: false,
    });
    if (otpErr) {
      console.error('otp create failed', {
        request_id,
        candidate_id,
        role_id: roleId,
        error: otpErr.message,
        code: otpErr.code || null
      });
      return res.status(500).json({
        error: 'server_error',
        code: 'OTP_CREATE_FAILED',
        detail: 'Unable to continue verification at this time.',
        ...(request_id ? { request_id } : {})
      });
    }

    // --- email OTP (non-fatal) ---
    let emailSent = false;
    try {
      if (!SENDGRID_KEY || !FROM_EMAIL) throw new Error('SENDGRID_API_KEY or SENDGRID_FROM not configured');
      const [resp] = await sg.send({
        to: email,
        from: { email: FROM_EMAIL, name: APP_NAME },
        subject: `Your ${APP_NAME} verification code`,
        text: `Your verification code is ${freshCode}. It expires in 10 minutes.`,
        html: `<p>Your verification code is <strong style="font-size:18px">${freshCode}</strong>.</p>
               <p>It expires in 10 minutes.</p>`,
      });
      emailSent = resp?.statusCode === 202;
    } catch (e) {
      const status = e?.response?.status || e?.code || null;
      const message = e?.message || 'send_failed';
      console.error('sendEmailOtp failed', { request_id, status, message });
    }

    // success
    return res.status(200).json({
      message: 'If your information is accepted, a verification code will be sent shortly.',
      candidate_id,
      role_id: roleId,
      resume_url: resume_url || null,
    });
  } catch (err) {
    console.error('Error in /candidate/submit:', err);
    return res.status(500).json({ error: 'Server error.' });
  }
});

module.exports = router;
