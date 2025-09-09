// routes/candidateSubmit.js
const express = require('express');
const router = express.Router();
const multer = require('multer');
const sg = require('@sendgrid/mail');
const { supabase } = require('../src/lib/supabaseClient'); // <- keep this path

// --- config ---
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
});
const FROM_EMAIL = process.env.SENDGRID_FROM;
const SENDGRID_KEY = process.env.SENDGRID_API_KEY;
const APP_NAME = process.env.APP_NAME || 'Interview Agent';
if (SENDGRID_KEY) sg.setApiKey(SENDGRID_KEY);

function six() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

/**
 * POST /api/candidate/submit
 * Accepts multipart (file fields: resume | resume_file | file | resumeFile | pdf)
 * OR JSON with resume_url.
 *
 * Supports both payload shapes:
 *  - role_id  OR role_token
 *  - name     OR first_name + last_name
 *
 * Required: email + (name or first/last) + (role_id or role_token)
 * Phone is optional (kept if provided).
 */
router.post('/', upload.any(), async (req, res) => {
  try {
    // --- accept both shapes ---
    const role_token = (req.body.role_token || '').trim();
    const role_id_in = (req.body.role_id || '').trim();
    const first_name = req.body.first_name?.trim();
    const last_name  = req.body.last_name?.trim();
    const rawName    = req.body.name?.trim();
    // normalize email so BE + DB (unique index on lower(email)) agree
    const email      = (req.body.email || '').trim().toLowerCase();
    const phone      = (req.body.phone || '').replace(/\D/g, ''); // optional
    const resume_url_in = req.body.resume_url || null;

    const fullName = rawName || [first_name, last_name].filter(Boolean).join(' ').trim();

    if (!email || !fullName || (!role_token && !role_id_in)) {
      return res.status(400).json({
        error: 'Required: email, (name OR first_name+last_name), and (role_id OR role_token).',
      });
    }

    // --- find role by id OR token (slug_or_token) ---
    let role = null, rErr = null;
    if (role_id_in) {
      ({ data: role, error: rErr } = await supabase
        .from('roles')
        .select('id, title')
        .eq('id', role_id_in)
        .single());
    } else {
      ({ data: role, error: rErr } = await supabase
        .from('roles')
        .select('id, title, slug_or_token')
        .eq('slug_or_token', role_token)
        .single());
    }
    if (rErr || !role) {
      return res.status(404).json({ error: 'Role not found.' });
    }
    const roleId = role.id;

    // --- duplicate check (same email + role) ---
    const { count: existingCount, error: dupErr } = await supabase
      .from('candidates')
      .select('*', { count: 'exact', head: true })
      .eq('email', email)
      .eq('role_id', roleId);
    if (dupErr) return res.status(500).json({ error: dupErr.message });
    if ((existingCount || 0) > 0) {
      return res.status(409).json({ error: 'You have already started an interview for this role.' });
    }

    // --- create candidate ---
    const { data: inserted, error: cErr } = await supabase
      .from('candidates')
      .insert({ role_id: roleId, name: fullName, email, phone, status: 'Resume Uploaded' })
      .select('id')
      .single();
    if (cErr) return res.status(500).json({ error: cErr.message });
    const candidate_id = inserted.id;

    // --- optional: upload resume to storage ---
    let resume_url = resume_url_in;
    try {
      const file = (req.files || []).find(f =>
        ['resume', 'resume_file', 'file', 'resumeFile', 'pdf'].includes(f.fieldname)
      );
      if (file) {
        const bucket = process.env.SUPABASE_RESUMES_BUCKET || 'resumes';
        const path = `${candidate_id}.pdf`;
        const up = await supabase.storage.from(bucket).upload(path, file.buffer, {
          contentType: file.mimetype || 'application/pdf',
          upsert: true,
        });
        if (!up.error) {
          const { data: pub } = supabase.storage.from(bucket).getPublicUrl(path);
          resume_url = pub?.publicUrl || resume_url;
        }
      }
    } catch (e) {
      console.error('resume upload failed:', e?.message || e);
    }
    if (resume_url) {
      await supabase.from('candidates').update({ resume_url }).eq('id', candidate_id);
    }

    // ----------------- HARDENING PATCH START -----------------

    // Invalidate any previous, unused OTPs for this (email, role)
    const nowIso = new Date().toISOString();
    await supabase
      .from('otp_tokens')
      .update({ used: true, used_at: nowIso })
      .eq('candidate_email', email)
      .eq('role_id', roleId)
      .eq('used', false);

    // Create exactly one fresh OTP (10-minute TTL)
    const freshCode = six();
    const { error: otpErr } = await supabase.from('otp_tokens').insert({
      candidate_email: email,
      role_id: roleId,
      code: freshCode,
      expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
      used: false,
    });
    if (otpErr) {
      return res.status(500).json({ error: `Could not create OTP: ${otpErr.message}` });
    }

    // Read back the newest OTP (defensive) and email THAT code
    const { data: newest, error: readErr } = await supabase
      .from('otp_tokens')
      .select('id, code, created_at')
      .eq('candidate_email', email)
      .eq('role_id', roleId)
      .order('created_at', { ascending: false })
      .limit(1)
      .single();
    const codeToSend = (!readErr && newest?.code) ? newest.code : freshCode;

    // ------------------ HARDENING PATCH END ------------------

    // --- send OTP via SendGrid (non-fatal on failure; surfaced in response) ---
    let emailSent = false, emailError = null;
    try {
      if (!SENDGRID_KEY || !FROM_EMAIL) throw new Error('SENDGRID_API_KEY or SENDGRID_FROM not configured');
      const subject = `Your ${APP_NAME} verification code`;
      const text = `Your verification code is ${codeToSend}. It expires in 10 minutes.`;
      const html = `<p>Your verification code is <strong style="font-size:18px">${codeToSend}</strong>.</p>
                    <p>It expires in 10 minutes.</p>`;
      const [resp] = await sg.send({
        to: email,
        from: { email: FROM_EMAIL, name: APP_NAME },
        subject, text, html,
      });
      emailSent = resp?.statusCode === 202;
    } catch (e) {
      emailError = e?.response?.data || e?.message || String(e);
      console.error('sendEmailOtp failed:', emailError);
    }

    return res.status(200).json({
      message: emailSent ? 'Candidate created. OTP emailed.' : 'Candidate created. OTP email failed.',
      email_sent: emailSent,
      email_error: emailError,
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
