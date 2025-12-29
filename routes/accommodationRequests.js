// routes/accommodationRequests.js
const express = require('express');
const crypto = require('crypto');
const multer = require('multer');
const sg = require('@sendgrid/mail');
const { supabaseAdmin } = require('../src/lib/supabaseClient');
const { redactEmail } = require('../src/lib/recoveryHelper');

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

function safeText(v) {
  return String(v || '').trim();
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
 * POST /api/accommodations/request
 * Candidate-facing accommodation request form.
 */
router.post('/request', upload.any(), async (req, res) => {
  const request_id = req.request_id || crypto.randomUUID?.() || String(Date.now());
  try {
    const candidate_name = safeText(req.body?.candidate_name || req.body?.name);
    const candidate_email = safeText(req.body?.candidate_email || req.body?.email).toLowerCase();
    const candidate_phone = safeText(req.body?.candidate_phone || req.body?.phone);
    const request_text = safeText(req.body?.accommodation_request_text || req.body?.request_text);
    const role_token = safeText(req.body?.role_token);
    const role_id_in = safeText(req.body?.role_id);

    if (!candidate_name || !candidate_email || !request_text || (!role_token && !role_id_in)) {
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
    if (role_id_in) {
      const { data, error } = await supabaseAdmin
        .from('roles')
        .select('id, title, client_id')
        .eq('id', role_id_in)
        .maybeSingle();
      if (error || !data) {
        return sendError(res, 404, {
          error: 'Role not found.',
          code: 'role_not_found',
          detail: error?.message || null,
          hint: error?.hint || null,
          request_id,
        });
      }
      role = data;
    } else {
      const { data, error } = await supabaseAdmin
        .from('roles')
        .select('id, title, client_id, slug_or_token')
        .or(`slug_or_token.eq.${role_token},token.eq.${role_token}`)
        .maybeSingle();
      if (error || !data) {
        return sendError(res, 404, {
          error: 'Role not found.',
          code: 'role_not_found',
          detail: error?.message || null,
          hint: error?.hint || null,
          request_id,
        });
      }
      role = data;
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
    const file = (req.files || []).find(f =>
      ['resume', 'resume_file', 'file', 'resumeFile', 'pdf'].includes(f.fieldname)
    );
    if (file) {
      try {
        const bucket = getAccommodationResumeBucket();
        const fileType = file.mimetype || 'application/pdf';
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
