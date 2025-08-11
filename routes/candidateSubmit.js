const express = require('express');
const router = express.Router();
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const twilio = require('twilio');
const { supabase } = require('../lib/supabaseClient'); // keep your current client import

const upload = multer(); // memory storage

// Twilio best-effort: initialize only if configured
const hasTwilio =
  !!process.env.TWILIO_ACCOUNT_SID &&
  !!process.env.TWILIO_AUTH_TOKEN &&
  !!process.env.TWILIO_PHONE_NUMBER;

let smsClient = null;
if (hasTwilio) {
  try {
    smsClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
  } catch (e) {
    console.warn('Twilio init failed (non-fatal):', e?.message || e);
  }
}

router.post('/', upload.single('resume'), async (req, res) => {
  try {
    const { first_name, last_name, email, phone, role_token } = req.body;
    const resume = req.file;

    if (!first_name || !last_name || !email || !phone || !resume || !role_token) {
      return res.status(400).json({ error: 'All fields are required.' });
    }

    // 1) Resolve role by slug/token
    const { data: role, error: roleErr } = await supabase
      .from('roles')
      .select('id, client_id, title')
      .eq('slug_or_token', role_token)
      .single();

    if (roleErr || !role) {
      return res.status(404).json({ error: 'Invalid role link.' });
    }

    // 2) Prevent duplicate per role/email
    const { count: existingCount, error: dupErr } = await supabase
      .from('candidates')
      .select('*', { count: 'exact', head: true })
      .eq('email', email)
      .eq('role_id', role.id);

    if (dupErr) {
      console.error('Duplicate check error:', dupErr);
      return res.status(500).json({ error: 'Server error (dup check).' });
    }
    if (existingCount > 0) {
      return res.status(409).json({ error: 'You have already applied for this role.' });
    }

    // 3) Upload resume
    const safeName = resume.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
    const resumePath = `resumes/${role.id}/${uuidv4()}_${safeName}`;
    const { error: uploadError } = await supabase.storage
      .from('resumes')
      .upload(resumePath, resume.buffer, {
        contentType: resume.mimetype || 'application/octet-stream',
      });

    if (uploadError) {
      console.error('Resume upload error:', uploadError);
      return res.status(500).json({ error: 'Failed to upload resume.' });
    }

    // 4) Insert candidate
    const fullName = `${first_name} ${last_name}`.trim();
    const { data: candidate, error: candidateErr } = await supabase
      .from('candidates')
      .insert({
        name: fullName,
        first_name,
        last_name,
        email,
        phone,
        resume_url: resumePath,
        role_id: role.id,
        verified: false,
        status: 'pending',
      })
      .select('id, email, role_id')
      .single();

    if (candidateErr || !candidate) {
      console.error('Candidate insert error:', candidateErr);
      return res.status(500).json({ error: 'Failed to save candidate.' });
    }

    // 5) Create OTP (10 minutes)
    const otpCode = String(Math.floor(100000 + Math.random() * 900000));
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();

    const { error: otpErr } = await supabase
      .from('otp_tokens')
      .insert({
        candidate_email: email,
        phone,
        code: otpCode,
        role_id: role.id,
        // IMPORTANT: match your DB column name:
        expires_at: expiresAt,
      });

    if (otpErr) {
      console.error('OTP insert error:', otpErr);
      return res.status(500).json({ error: 'Failed to create OTP.' });
    }

    // 6) Notify via SMS (non-fatal)
    (async () => {
      try {
        if (smsClient && hasTwilio) {
          await smsClient.messages.create({
            to: phone,
            from: process.env.TWILIO_PHONE_NUMBER,
            body: `Your AlphaSource interview verification code is: ${otpCode}. It expires in 10 minutes.`,
          });
        } else {
          console.warn('Twilio disabled or not configured. Skipping SMS send.');
        }
      } catch (smsErr) {
        console.warn('Twilio send failed (non-fatal):', smsErr?.message || smsErr);
      }
    })();

    // 7) Respond success; frontend can immediately route to /verify-otp
    return res.status(200).json({
      message: 'OTP created. Check your phone (or use the code sent).',
      candidate_id: candidate.id,
      email: candidate.email,
      role_id: candidate.role_id,
    });
  } catch (err) {
    console.error('Error in /api/candidate/submit:', err);
    return res.status(500).json({ error: 'Server error.' });
  }
});

module.exports = router;
