const express = require('express');
const router = express.Router();
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const { supabase } = require('../lib/supabaseClient');
const twilio = require('twilio');
const analyzeResume = require('../analyzeResume'); // ✅ from earlier working version

const upload = multer();
const client = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

router.post('/', upload.single('resume'), async (req, res) => {
  try {
    const { first_name, last_name, email, phone, role_token } = req.body;
    const resume = req.file;

    if (!first_name || !last_name || !email || !phone || !resume || !role_token) {
      return res.status(400).json({ error: 'All fields are required.' });
    }

    const name = `${first_name} ${last_name}`.trim();

    // Get role
    const { data: role, error: roleErr } = await supabase
      .from('roles')
      .select('*')
      .eq('slug_or_token', role_token)
      .single();

    if (roleErr || !role) {
      return res.status(404).json({ error: 'Invalid role link.' });
    }

    // Prevent duplicates
    const { count } = await supabase
      .from('candidates')
      .select('*', { count: 'exact', head: true })
      .eq('email', email)
      .eq('role_id', role.id);

    if (count > 0) {
      return res.status(409).json({ error: 'You have already applied for this role.' });
    }

    // Upload resume to Supabase Storage
    const resumePath = `resumes/${role.id}/${uuidv4()}_${resume.originalname}`;
    const { error: uploadError } = await supabase.storage
      .from('resumes')
      .upload(resumePath, resume.buffer, {
        contentType: resume.mimetype,
      });

    if (uploadError) {
      return res.status(500).json({ error: 'Failed to upload resume.' });
    }

    // Insert candidate
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
        verified: false
      })
      .select()
      .single();

    if (candidateErr) {
      return res.status(500).json({ error: 'Failed to save candidate.' });
    }

    // ✅ Resume Analysis — restored from earlier working version
    try {
      const analysis = await analyzeResume(resume.buffer, resume.mimetype, role, candidate.id);
// Store a readable summary on the candidate record (optional but nice)
await supabase
  .from('candidates')
  .update({ analysis_summary: analysis.summary })
  .eq('id', candidate.id);
    } catch (analysisErr) {
      console.error('Resume analysis failed:', analysisErr);
      // Continue without blocking OTP
    }

    // ✅ OTP Generation
    const otpCode = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

    await supabase.from('otp_tokens').insert({
      candidate_email: email,
      phone,
      code: otpCode,
      role_id: role.id,
      expires_at: expiresAt
    });

    // ✅ Twilio SMS
    await client.messages.create({
      body: `Your AlphaSource interview verification code is: ${otpCode}`,
      from: process.env.TWILIO_PHONE_NUMBER,
      to: phone
    });

    return res.status(200).json({ message: 'OTP sent to your phone number.' });
  } catch (err) {
    console.error('Error in /candidate/submit:', err);
    return res.status(500).json({ error: 'Server error.' });
  }
});

module.exports = router;
