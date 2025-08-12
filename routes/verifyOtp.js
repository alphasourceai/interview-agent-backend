// routes/verifyOtp.js
const express = require('express');
const router = express.Router();
const { supabase } = require('../supabaseClient'); // service-role client

// NOTE: This route ONLY verifies OTP and marks the candidate verified.
// Tavus creation happens in a separate request (/create-tavus-interview) from the frontend.

router.post('/', async (req, res) => {
  try {
    const { email, code } = req.body;

    if (!email || !code) {
      return res.status(400).json({ error: 'Missing email or OTP.' });
    }

    // 1) Get latest OTP for this email
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
    if (otpToken.expires_at && new Date(otpToken.expires_at) < new Date()) {
      return res.status(410).json({ error: 'OTP has expired. Please try again.' });
    }

    // 2) Mark candidate verified + update status
    const { data: candidate, error: candErr } = await supabase
      .from('candidates')
      .update({
        verified: true,
        otp_verified_at: new Date().toISOString(),
        status: 'Verified'
      })
      .eq('email', email)
      .eq('role_id', otpToken.role_id)
      .select('id, email, role_id, first_name, last_name, name')
      .single();

    if (candErr || !candidate) {
      return res.status(500).json({ error: 'Could not update verification status.' });
    }

    // 3) Invalidate OTP (non-fatal if delete fails)
    try {
      await supabase.from('otp_tokens').delete().eq('id', otpToken.id);
    } catch (_) {}

    // 4) Return data the frontend needs to start Tavus in a separate call
    return res.status(200).json({
      message: 'Verification complete.',
      verified: true,
      candidate_id: candidate.id,
      email: candidate.email,
      role_id: candidate.role_id
    });
  } catch (err) {
    console.error('Error in /api/candidate/verify-otp:', err);
    return res.status(500).json({ error: 'Server error during OTP verification.' });
  }
});

module.exports = router;
