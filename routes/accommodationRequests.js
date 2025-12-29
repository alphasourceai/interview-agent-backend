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
const RESUME_BUCKET = process.env.SUPABASE_RESUMES_BUCKET || 'resumes';

if (SENDGRID_KEY) sg.setApiKey(SENDGRID_KEY);

const isValidEmail = (value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || '').trim());

function safeText(v) {
  return String(v || '').trim();
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
      return res.status(400).json({ error: 'Missing required fields.' });
    }
    if (!isValidEmail(candidate_email)) {
      return res.status(400).json({ error: 'Invalid email address.' });
    }

    let role = null;
    if (role_id_in) {
      const { data, error } = await supabaseAdmin
        .from('roles')
        .select('id, title, client_id')
        .eq('id', role_id_in)
        .maybeSingle();
      if (error || !data) return res.status(404).json({ error: 'Role not found.' });
      role = data;
    } else {
      const { data, error } = await supabaseAdmin
        .from('roles')
        .select('id, title, client_id, slug_or_token')
        .or(`slug_or_token.eq.${role_token},token.eq.${role_token}`)
        .maybeSingle();
      if (error || !data) return res.status(404).json({ error: 'Role not found.' });
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
      return res.status(500).json({ error: reqErr?.message || 'Could not create request.' });
    }

    console.log('accommodation_request_created', {
      request_id: reqRow.id,
      role_id: role.id,
      candidate_email: redactEmail(candidate_email),
    });

    let resume_url = null;
    let resume_received_at = null;
    try {
      const file = (req.files || []).find(f =>
        ['resume', 'resume_file', 'file', 'resumeFile', 'pdf'].includes(f.fieldname)
      );
      if (file) {
        const fileType = file.mimetype || 'application/pdf';
        const ext = /pdf/i.test(fileType) ? 'pdf' : 'docx';
        const path = `accommodations/${reqRow.id}.${ext}`;
        const up = await supabaseAdmin.storage.from(RESUME_BUCKET).upload(path, file.buffer, {
          contentType: fileType,
          upsert: true,
        });
        if (!up.error) {
          const { data: pub } = supabaseAdmin.storage.from(RESUME_BUCKET).getPublicUrl(path);
          resume_url = pub?.publicUrl || null;
          resume_received_at = new Date().toISOString();
        }
      }
    } catch (e) {
      console.error('[accommodation] resume upload failed', { request_id: reqRow.id, error: e?.message || e });
    }

    if (resume_url) {
      await supabaseAdmin
        .from('accommodation_requests')
        .update({ resume_url, resume_received_at })
        .eq('id', reqRow.id);
      if (!existingResumeUrl && candidate_id) {
        await supabaseAdmin.from('candidates').update({ resume_url }).eq('id', candidate_id);
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
    console.error('[accommodation] request error', { request_id, error: err?.message || err });
    return res.status(500).json({ error: 'Server error.' });
  }
});

module.exports = router;
