const express = require('express');
const router = express.Router();
const multer = require('multer');
const { supabase } = require('../src/lib/supabaseClient'); // <-- adjust if your tree differs
const sg = require('@sendgrid/mail');

// config
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });
const FROM_EMAIL = process.env.SENDGRID_FROM;
const SENDGRID_KEY = process.env.SENDGRID_API_KEY;
if (SENDGRID_KEY) sg.setApiKey(SENDGRID_KEY);

function six() { return String(Math.floor(100000 + Math.random() * 900000)); }

/**
 * POST /api/candidate/submit
 * Accepts multipart (resume under: resume | resume_file | file | resumeFile | pdf)
 * or JSON that includes resume_url.
 * Required: role_token, first_name, last_name, email
 * Phone is optional when using email OTP.
 */
router.post('/', upload.any(), async (req, res) => {
  try {
    const first_name = req.body.first_name?.trim();
    const last_name  = req.body.last_name?.trim();
    const email      = (req.body.email || '').trim();
    const phone      = (req.body.phone || '').replace(/\D/g, ''); // optional now
    const role_token = (req.body.role_token || '').trim();
    const resume_url_in = req.body.resume_url || null;

    if (!role_token || !first_name || !last_name || !email) {
      return res.status(400).json({ error: 'Required: role_token, first_name, last_name, email.' });
    }

    // 1) Find role by token
    const { data: role, error: roleErr } = await supabase
      .from('roles')
      .select('id, title, token')
      .eq('token', role_token)
      .single();

    if (roleErr || !role) {
      return res.status(404).json({ error: 'Invalid role link.' });
    }

    // 2) Duplicate check (same email + role)
    const { count: existingCount, error: dupErr } = await supabase
      .from('candidates')
      .select('*', { count: 'exact', head: true })
      .eq('email', email)
      .eq('role_id', role.id);

    if (dupErr) return res.status(500).json({ error: dupErr.message });
    if ((existingCount || 0) > 0) {
      return res.status(409).json({ error: 'You have already started an interview for this role.' });
    }

    // 3) Create candidate
    const fullName = `${first_name} ${last_name}`.trim();
    const { data: inserted, error: cErr } = await supabase
      .from('candidates')
      .insert({ role_id: role.id, name: fullName, email, phone, status: 'Resume Uploaded' })
      .select('id')
      .single();
    if (cErr) return res.status(500).json({ error: cErr.message });
    const candidate_id = inserted.id;

    // 4) Upload resume (optional)
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
          upsert: true
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

    // 5) Issue OTP (10-minute TTL)
    const code = six();
    const { error: otpErr } = await supabase.from('otp_tokens').insert({
      email,
      code,
      expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
      used: false
    });
    if (otpErr) return res.status(500).json({ error: `Could not create OTP: ${otpErr.message}` });

    // 6) Email the OTP via SendGrid
    let emailSent = false, emailError = null;
    try {
      if (!SENDGRID_KEY || !FROM_EMAIL) throw new Error('SENDGRID_API_KEY or SENDGRID_FROM not configured');
      const subject = `Your ${process.env.APP_NAME || 'Interview Agent'} verification code`;
      const text = `Your verification code is ${code}. It expires in 10 minutes.`;
      const html = `<p>Your verification code is <strong style="font-size:18px">${code}</strong>.</p>
                    <p>It expires in 10 minutes.</p>`;
      const [resp] = await sg.send({
        to: email,
        from: { email: FROM_EMAIL, name: process.env.APP_NAME || 'Interview Agent' },
        subject, text, html
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
      role_id: role.id,
      resume_url: resume_url || null
    });
  } catch (err) {
    console.error('Error in /candidate/submit:', err);
    return res.status(500).json({ error: 'Server error.' });
  }
});

module.exports = router;
