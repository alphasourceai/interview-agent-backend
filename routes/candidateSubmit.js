const express = require('express');
const router = express.Router();
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const twilio = require('twilio');

// IMPORTANT: use the backend service-role client (not anon)
const { supabase } = require('../supabaseClient');
const analyzeResume = require('../analyzeResume');

const upload = multer();

// Twilio (best-effort; never block the request)
const hasTwilio =
  !!process.env.TWILIO_ACCOUNT_SID &&
  !!process.env.TWILIO_AUTH_TOKEN &&
  !!process.env.TWILIO_PHONE_NUMBER;

let sms = null;
if (hasTwilio) {
  try {
    sms = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
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

    const name = `${first_name} ${last_name}`.trim();

    // 1) Resolve role via slug/token
    const { data: role, error: roleErr } = await supabase
      .from('roles')
      .select('id, title, description, interview_type, rubric, client_id')
      .eq('slug_or_token', role_token)
      .single();

    if (roleErr || !role) {
      return res.status(404).json({ error: 'Invalid role link.' });
    }

    // 2) Prevent duplicate per role/email
    const { count: existing, error: dupErr } = await supabase
      .from('candidates')
      .select('*', { count: 'exact', head: true })
      .eq('email', email)
      .eq('role_id', role.id);

    if (dupErr) {
      console.error('Duplicate check error:', dupErr);
      return res.status(500).json({ error: 'Server error.' });
    }
    if (existing > 0) {
      return res.status(409).json({ error: 'You have already applied for this role.' });
    }

    // 3) Upload resume
    const safeName = (resume.originalname || 'resume.pdf').replace(/[^a-zA-Z0-9.\-_]/g, '_');
    const resumePath = `resumes/${role.id}/${uuidv4()}_${safeName}`;

    const { error: uploadError } = await supabase.storage
      .from('resumes')
      .upload(resumePath, resume.buffer, {
        contentType: resume.mimetype || 'application/octet-stream',
        upsert: false
      });

    if (uploadError) {
      console.error('Resume upload error:', uploadError);
      return res.status(500).json({ error: 'Failed to upload resume.' });
    }

    // 4) Insert candidate with correct status
    const { data: candidate, error: candidateErr } = await supabase
      .from('candidates')
      .insert({
        name,
        first_name,
        last_name,
        email,
        phone,
        resume_url: resumePath,
        role_id: role.id,
        verified: false,
        status: 'Resume Uploaded',
        upload_ts: new Date().toISOString()
      })
      .select()
      .single();

    if (candidateErr || !candidate) {
      console.error('Candidate insert error:', candidateErr);
      return res.status(500).json({ error: 'Failed to save candidate.' });
    }

    // 5) Resume analysis (non-blocking)
    try {
      const analysis = await analyzeResume(resume.buffer, resume.mimetype, role, candidate.id);
      await supabase
        .from('candidates')
        .update({ analysis_summary: analysis })
        .eq('id', candidate.id);
    } catch (analysisErr) {
      console.warn('Resume analysis failed (non-fatal):', analysisErr?.message || analysisErr);
    }

    // 6) Create OTP (10 min)
    const otpCode = String(Math.floor(100000 + Math.random() * 900000));
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();

    const { error: otpErr } = await supabase.from('otp_tokens').insert({
      candidate_email: email,
      phone,
      code: otpCode,
      role_id: role.id,
      expires_at: expiresAt
    });

    if (otpErr) {
      console.error('OTP insert error:', otpErr);
      // continue — frontend can still route to /verify-otp and read code from DB during testing
    }

    // 7) Send OTP via Twilio (best-effort)
    (async () => {
      try {
        if (sms && hasTwilio) {
          await sms.messages.create({
            body: `Your AlphaSource interview verification code is: ${otpCode}. It expires in 10 minutes.`,
            from: process.env.TWILIO_PHONE_NUMBER,
            to: phone
          });
        } else {
          console.warn('Twilio not configured. Skipping SMS send.');
        }
      } catch (smsErr) {
        console.warn('Twilio send failed (non-fatal):', smsErr?.message || smsErr);
      }
    })();

    // 8) Success (return data for redirect to /verify-otp)
    return res.status(200).json({
      message: 'OTP created.',
      candidate_id: candidate.id,
      email,
      role_id: role.id
    });
  } catch (err) {
    console.error('Error in /api/candidate/submit:', err);
    return res.status(500).json({ error: 'Server error.' });
  }
});

module.exports = router;
