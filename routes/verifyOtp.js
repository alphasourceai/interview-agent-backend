const express = require('express');
const router = express.Router();
const { supabase } = require('../lib/supabaseClient');
const createTavusInterview = require('../handlers/createTavusInterview'); // ✅ Use working handler version

router.post('/', async (req, res) => {
  try {
    const { email, code } = req.body;

    if (!email || !code) {
      return res.status(400).json({ error: 'Missing email or OTP.' });
    }

    // Get the latest OTP for this email
    const { data: otpToken, error: otpErr } = await supabase
      .from('otp_tokens')
      .select('*')
      .eq('candidate_email', email)
      .order('created_at', { ascending: false })
      .limit(1)
      .single();

    if (otpErr || !otpToken || otpToken.code !== code) {
      return res.status(401).json({ error: 'Invalid or expired OTP.' });
    }

    if (new Date() > new Date(otpToken.expires_at)) {
      return res.status(410).json({ error: 'OTP has expired. Please try again.' });
    }

    // Mark candidate as verified
    const { data: candidate, error: updateErr } = await supabase
      .from('candidates')
      .update({
        verified: true,
        otp_verified_at: new Date()
      })
      .eq('email', email)
      .eq('role_id', otpToken.role_id)
      .select()
      .single();

    if (updateErr || !candidate) {
      return res.status(500).json({ error: 'Failed to verify candidate.' });
    }

    // ✅ Trigger Tavus interview using the working handler
    const tavusData = await createTavusInterview(candidate);

    return res.status(200).json({
      message: 'Verification complete.',
      redirect_url: tavusData.conversation_url
    });
  } catch (err) {
    console.error('Error in verify-otp:', err);
    return res.status(500).json({ error: 'Server error during OTP verification.' });
  }
});

module.exports = router;
