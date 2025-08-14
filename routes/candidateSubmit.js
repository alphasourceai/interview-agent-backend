const express = require('express');
const router = express.Router();
const multer = require('multer');
const { supabase } = require('../src/lib/supabaseClient');
const sg = require('@sendgrid/mail');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });
const FROM_EMAIL = process.env.SENDGRID_FROM;
const SENDGRID_KEY = process.env.SENDGRID_API_KEY;
if (SENDGRID_KEY) sg.setApiKey(SENDGRID_KEY);

function six() { return String(Math.floor(100000 + Math.random() * 900000)); }

router.post('/', upload.any(), async (req, res) => {
  try {
    // Accept both shapes
    const role_token = (req.body.role_token || '').trim();
    const role_id_in = (req.body.role_id || '').trim();
    const first_name = req.body.first_name?.trim();
    const last_name  = req.body.last_name?.trim();
    const rawName    = req.body.name?.trim();
    const email      = (req.body.email || '').trim();
    const phone      = (req.body.phone || '').replace(/\D/g, ''); // optional
    const resume_url_in = req.body.resume_url || null;

    const fullName = rawName || [first_name, last_name].filter(Boolean).join(' ').trim();

    if (!email || !fullName || (!role_token && !role_id_in)) {
      return res.status(400).json({
        error: "Required: email, (name OR first_name+last_name), and (role_id OR role_token)."
      });
    }

    // Find role by id OR token
    let role, rErr;
    if (role_id_in) {
      ({ data: role, error: rErr } = await supabase.from('roles').select('id, title').eq('id', role_id_in).single());
    } else {
      ({ data: role, error: rErr } = await supabase.from('roles').select('id, title, token').eq('token', role_token).single());
    }
    if (rErr || !role) return res.status(404).json({ error: 'Role not found.' });

    // Duplicate check (email + role)
    const { count: existingCount, error: dupErr } = await supabase
      .from('candidates')
      .select('*', { count: 'exact', head: true })
      .eq('email', email)
      .eq('role_id', role.id);
    if (dupErr) return res.status(500).json({ error: dupErr.message });
    if ((existingCount || 0) > 0) {
      return res.status(409).json({ error: 'You have already started an interview for this role.' });
    }

    // Create candidate
    const { data: inserted, error: cErr } = await supabase
      .from('candidates')
      .insert({ role_id: role.id, name: fullName, email, phone, status: 'Resume Uploaded' })
      .select('id')
      .single();
    if (cErr) return res.status(500).json({ error: cErr.message });
    const candidate_id = inserted.id;

    // Optional: upload resume file to storage
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
    if (resume_url) await supabase.from('candidates').update({ resume_url }).eq('id', candidate_id);

    // OTP (10 minutes)
    const code = six();
    const { error: otpErr } = await supabase.from('otp_tokens').insert({
      email,
      code,
      expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
      used: false
    });
    if (otpErr) return res.status(500).json({ error: `Could not create OTP: ${otpErr.message}` });

    // Email the OTP via SendGrid
    let emailSent = false, emailError = null;
    try {
      if (!SENDGRID_KEY || !FROM_EMAIL) throw new Error('SENDGRID_API_KEY or SENDGRID_FROM not configured');
      const appName = process.env.APP_NAME || 'Interview Agent';
      const subject = `Your ${appName} verification code`;
      const text = `Your verification code is ${code}. It expires in 10 minutes.`;
      const html = `<p>Your verification code is <strong style="font-size:18px">${code}</strong>.</p>
                    <p>It expires in 10 minutes.</p>`;
      const [resp] = await sg.send({
        to: email,
        from: { email: FROM_EMAIL, name: appName },
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
