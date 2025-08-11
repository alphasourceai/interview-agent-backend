const express = require('express');
const router = express.Router();

// Use the service-role Supabase client on the backend
const { supabase } = require('../supabaseClient');

// Reuse your working Tavus creator; we’ll pass both candidate + role
const createTavusInterview = require('../handlers/createTavusInterview');

router.post('/', async (req, res) => {
  try {
    const { email, code } = req.body;

    if (!email || !code) {
      return res.status(400).json({ error: 'Missing email or OTP.' });
    }

    // 1) Get the latest OTP for this email
    const { data: otpToken, error: otpErr } = await supabase
      .from('otp_tokens')
      .select('*')
      .eq('candidate_email', email)
      .order('created_at', { ascending: false })
      .limit(1)
      .single();

    if (otpErr || !otpToken) {
      return res.status(401).json({ error: 'Invalid or expired OTP.' });
    }

    if (otpToken.code !== code) {
      return res.status(401).json({ error: 'Invalid OTP code.' });
    }

    if (new Date() > new Date(otpToken.expires_at)) {
      return res.status(410).json({ error: 'OTP has expired. Please try again.' });
    }

    // 2) Mark candidate as verified (also fetch the candidate row)
    const { data: candidate, error: candErr } = await supabase
      .from('candidates')
      .update({
        verified: true,
        otp_verified_at: new Date().toISOString()
      })
      .eq('email', email)
      .eq('role_id', otpToken.role_id)
      .select('id, email, role_id, first_name, last_name, name')
      .single();

    if (candErr || !candidate) {
      return res.status(500).json({ error: 'Failed to verify candidate.' });
    }

    // 3) Load the role so we can build a role-specific Tavus prompt
    const { data: role, error: roleErr } = await supabase
      .from('roles')
      .select('id, title, description, interview_type, rubric')
      .eq('id', candidate.role_id)
      .single();

    if (roleErr || !role) {
      return res.status(500).json({ error: 'Failed to load role for interview.' });
    }

    // 4) Create the Tavus interview (handler should use role to craft prompt)
    let tavusData;
    try {
      tavusData = await createTavusInterview(candidate, role);
    } catch (tvErr) {
      console.error('Tavus creation failed:', tvErr?.response?.data || tvErr?.message || tvErr);
      return res.status(502).json({ error: 'Failed to create interview session.' });
    }

    // 5) (Optional) Invalidate the OTP after successful verification
    try {
      await supabase.from('otp_tokens').delete().eq('id', otpToken.id);
    } catch (delErr) {
      // non-fatal
      console.warn('Failed to delete OTP token (non-fatal):', delErr?.message || delErr);
    }

    return res.status(200).json({
      message: 'Verification complete.',
      redirect_url: tavusData?.conversation_url || tavusData?.url || null
    });
  } catch (err) {
    console.error('Error in verify-otp:', err);
    return res.status(500).json({ error: 'Server error during OTP verification.' });
  }
});

module.exports = router;
