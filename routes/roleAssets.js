// routes/roleAssets.js
const express = require('express');
const crypto = require('crypto');
const sg = require('@sendgrid/mail');
const { supabaseAdmin } = require('../src/lib/supabaseClient');

const router = express.Router();

const SENDGRID_KEY = process.env.SENDGRID_API_KEY || '';
const FROM_EMAIL = process.env.SENDGRID_FROM || '';
const NOTIFY_EMAIL = 'info@alphasourceai.com';
const SIGNED_URL_TTL_SECONDS = Number(process.env.SIGNED_URL_TTL_SECONDS || 300);

if (SENDGRID_KEY) {
  try {
    sg.setApiKey(SENDGRID_KEY);
  } catch (e) {
    console.error('[roles] failed to set SendGrid key', e?.message || e);
  }
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

function isHttpUrl(value) {
  return /^https?:\/\//i.test(String(value || ''));
}

function parseBucketPath(value) {
  if (!value || typeof value !== 'string') return null;
  const raw = value.trim();
  if (!raw) return null;
  if (!isHttpUrl(raw)) {
    const idx = raw.indexOf('/');
    if (idx > 0) {
      return { bucket: raw.slice(0, idx), path: raw.slice(idx + 1) };
    }
    return null;
  }
  try {
    const u = new URL(raw);
    const parts = u.pathname.split('/').filter(Boolean);
    const idx = parts.findIndex((p) => p === 'public' || p === 'sign');
    if (idx >= 0 && parts[idx + 1]) {
      const bucket = parts[idx + 1];
      const path = parts.slice(idx + 2).join('/');
      if (bucket && path) return { bucket, path };
    }
  } catch (_) {
    return null;
  }
  return null;
}

function normalizeQuestions(input) {
  if (!Array.isArray(input)) return [];
  return input
    .map((q) => (q == null ? '' : String(q).trim()))
    .filter((q) => q);
}

router.get('/:role_id/jd-signed-url', async (req, res) => {
  const request_id = req.request_id || crypto.randomUUID?.() || String(Date.now());
  try {
    const role_id = String(req.params?.role_id || '').trim();
    if (!role_id) {
      return sendError(res, 400, {
        error: 'Role id is required.',
        code: 'missing_role_id',
        detail: null,
        hint: null,
        request_id,
      });
    }

    const { data: role, error } = await supabaseAdmin
      .from('roles')
      .select('id, title, client_id, job_description_url')
      .eq('id', role_id)
      .maybeSingle();

    if (error) {
      logSupabaseError('[roles/jd] lookup failed', request_id, error);
      return sendError(res, 500, {
        error: 'Role lookup failed.',
        code: error.code || 'role_lookup_failed',
        detail: error.message,
        hint: error.hint,
        request_id,
      });
    }

    if (!role) {
      return sendError(res, 404, {
        error: 'Role not found.',
        code: 'role_not_found',
        detail: 'No role found for the supplied role_id.',
        hint: null,
        request_id,
      });
    }

    const allowedIds = Array.isArray(req.clientIds) ? req.clientIds.filter(Boolean) : [];
    if (!allowedIds.includes(role.client_id)) {
      return sendError(res, 403, {
        error: 'Forbidden.',
        code: 'client_scope_mismatch',
        detail: 'You do not have access to this role.',
        hint: 'Join the client to view roles.',
        request_id,
      });
    }

    const raw = role.job_description_url;
    if (!raw) {
      return sendError(res, 404, {
        error: 'Job description not available.',
        code: 'jd_not_found',
        detail: 'job_description_url is empty.',
        hint: null,
        request_id,
      });
    }

    if (isHttpUrl(raw)) {
      return res.json({ url: raw, request_id });
    }

    const parsed = parseBucketPath(raw);
    if (!parsed) {
      return sendError(res, 400, {
        error: 'Invalid job description path.',
        code: 'jd_path_invalid',
        detail: 'Unrecognized storage path.',
        hint: 'Expected bucket/path.',
        request_id,
      });
    }

    const { data: signed, error: signErr } = await supabaseAdmin
      .storage
      .from(parsed.bucket)
      .createSignedUrl(parsed.path, SIGNED_URL_TTL_SECONDS);

    if (signErr) {
      logSupabaseError('[roles/jd] sign failed', request_id, signErr);
      return sendError(res, 500, {
        error: 'Signed URL creation failed.',
        code: signErr.code || 'signed_url_failed',
        detail: signErr.message,
        hint: signErr.hint,
        request_id,
      });
    }

    return res.json({ url: signed?.signedUrl || null, request_id });
  } catch (e) {
    console.error('[roles/jd] unexpected', { request_id, error: e?.message || e });
    return sendError(res, 500, {
      error: 'Server error.',
      code: 'server_error',
      detail: e?.message || 'Server error',
      hint: null,
      request_id,
    });
  }
});

router.post('/:role_id/rubric-request-changes', async (req, res) => {
  const request_id = req.request_id || crypto.randomUUID?.() || String(Date.now());
  try {
    const role_id = String(req.params?.role_id || '').trim();
    if (!role_id) {
      return sendError(res, 400, {
        error: 'Role id is required.',
        code: 'missing_role_id',
        detail: null,
        hint: null,
        request_id,
      });
    }

    const notes = String(req.body?.notes || '').trim();
    const questions = normalizeQuestions(req.body?.questions);

    const { data: role, error } = await supabaseAdmin
      .from('roles')
      .select('id, title, client_id')
      .eq('id', role_id)
      .maybeSingle();

    if (error) {
      logSupabaseError('[roles/rubric] lookup failed', request_id, error);
      return sendError(res, 500, {
        error: 'Role lookup failed.',
        code: error.code || 'role_lookup_failed',
        detail: error.message,
        hint: error.hint,
        request_id,
      });
    }

    if (!role) {
      return sendError(res, 404, {
        error: 'Role not found.',
        code: 'role_not_found',
        detail: 'No role found for the supplied role_id.',
        hint: null,
        request_id,
      });
    }

    const allowedIds = Array.isArray(req.clientIds) ? req.clientIds.filter(Boolean) : [];
    if (!allowedIds.includes(role.client_id)) {
      return sendError(res, 403, {
        error: 'Forbidden.',
        code: 'client_scope_mismatch',
        detail: 'You do not have access to this role.',
        hint: 'Join the client to view roles.',
        request_id,
      });
    }

    if (!SENDGRID_KEY || !FROM_EMAIL) {
      return sendError(res, 500, {
        error: 'SendGrid not configured.',
        code: 'sendgrid_not_configured',
        detail: 'SENDGRID_API_KEY or SENDGRID_FROM missing.',
        hint: 'Configure SendGrid env vars.',
        request_id,
      });
    }

    const subject = `Rubric change request — ${role.title || 'Role'} (${role.id})`;
    const body = [
      `Client ID: ${role.client_id || '—'}`,
      `Role ID: ${role.id}`,
      `Role Title: ${role.title || '—'}`,
      '',
      'Notes:',
      notes || '—',
      '',
      'Questions:',
      questions.length ? questions.map((q, i) => `${i + 1}. ${q}`).join('\n') : '—',
    ].join('\n');

    const msg = {
      to: NOTIFY_EMAIL,
      from: FROM_EMAIL,
      subject,
      text: body,
    };

    try {
      const [resp] = await sg.send(msg);
      console.log('[roles/rubric] change request sent', {
        request_id,
        role_id: role.id,
        status: resp?.statusCode || null,
        questions: questions.length,
      });
    } catch (e) {
      console.error('[roles/rubric] email failed', {
        request_id,
        error: e?.message || e,
        detail: e?.response?.body || null,
      });
      return sendError(res, 500, {
        error: 'Email send failed.',
        code: 'email_send_failed',
        detail: e?.message || 'Email send failed',
        hint: null,
        request_id,
      });
    }

    return res.json({ ok: true, request_id });
  } catch (e) {
    console.error('[roles/rubric] unexpected', { request_id, error: e?.message || e });
    return sendError(res, 500, {
      error: 'Server error.',
      code: 'server_error',
      detail: e?.message || 'Server error',
      hint: null,
      request_id,
    });
  }
});

module.exports = router;
