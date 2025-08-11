const express = require('express');
const router = express.Router();
const { supabase } = require('../lib/supabaseClient');
const createTavusInterview = require('../handlers/createTavusInterview'); // your working handler

router.post('/', async (req, res) => {
  try {
    const { email, code } = req.body;

    if (!email || !code) {
      return res.status(400).json({ error: 'Missing email or OTP.' });
    }

    // Get the most recent matching OTP for this email + code
    const { data: otpToken, error: otpErr } = await supabase
      .from('otp_tokens')
      .select('*')
      .eq('candidate_email', email)
      .eq('code', code)
      .order('created_at', { ascending: false })
      .limit(1)
      .single();

    if (otpErr || !otpToken) {
      return res.status(401).json({ error: 'Invalid OTP.' });
    }

    // Expiry check (column is expire_at in your DB)
    if (otpToken.expire_at && new Date(otpToken.expire_at) < new Date()) {
      return res.status(410).json({ error: 'OTP has expired. Please try again.' });
    }

    // Mark candidate verified and return the candidate row
    const { data: candidate, error: updateErr } = await supabase
      .from('candidates')
      .update({
        verified: true,
        otp_verified_at: new Date().toISOString(),
      })
      .eq('email', email)
      .eq('role_id', otpToken.role_id)
      .select('*')
      .single();

    if (updateErr || !candidate) {
      return res.status(500).json({ error: 'Failed to verify candidate.' });
    }

    // (Optional) delete OTP so it can't be reused
    await supabase.from('otp_tokens').delete().eq('id', otpToken.id);

    // ✅ Trigger Tavus interview using your working handler
    // Make sure your handler uses role-specific prompts/rubric internally.
    let tavusData = null;
    try {
      tavusData = await createTavusInterview(candidate);
    } catch (tavusErr) {
      console.error('Tavus creation failed:', tavusErr?.message || tavusErr);
      // Still return 200 so the frontend can show "verified" and instruct a retry/link
      return res.status(200).json({
        message: 'Verification complete, but the interview link is not ready yet. Please try again shortly.',
        verified: true,
        redirect_url: null,
      });
    }

    return res.status(200).json({
      message: 'Verification complete.',
      verified: true,
      redirect_url: tavusData?.conversation_url || tavusData?.video_url || null,
    });
  } catch (err) {
    console.error('Error in verify-otp:', err);
    return res.status(500).json({ error: 'Server error during OTP verification.' });
  }
});

module.exports = router;
