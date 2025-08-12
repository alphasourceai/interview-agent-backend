const express = require('express');
const router = express.Router();

const { supabase } = require('../supabaseClient'); // service-role client
const createTavusInterview = require('../handlers/createTavusInterview');

router.post('/', async (req, res) => {
  try {
    const { email, code } = req.body;

    if (!email || !code) {
      return res.status(400).json({ error: 'Missing email or OTP.' });
    }

    // 1) Latest OTP for this email
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

    // 2) Mark candidate verified + set status
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

    // 3) Load role for dynamic Tavus prompt
    const { data: role, error: roleErr } = await supabase
      .from('roles')
      .select('id, title, description, interview_type, rubric')
      .eq('id', candidate.role_id)
      .single();

    if (roleErr || !role) {
      return res.status(500).json({ error: 'Failed to load role for interview.' });
    }

    // 4) Create Tavus (timeout inside handler)
    let tavusData = null;
    try {
      tavusData = await createTavusInterview(candidate, role);
      // Optional: bump status to reflect interview availability
      try {
        await supabase.from('candidates').update({ status: 'Interview Ready' }).eq('id', candidate.id);
      } catch (_) {}
    } catch (tvErr) {
      console.error('Tavus creation failed:', tvErr?.response?.data || tvErr?.message || tvErr);
      // Don’t block verification; return success without link and keep status as Verified
      try { await supabase.from('otp_tokens').delete().eq('id', otpToken.id); } catch {}
      return res.status(200).json({
        message: 'Verification complete, but the interview link is not ready yet. Please try again shortly.',
        verified: true,
        redirect_url: null
      });
    }

    // 5) Invalidate OTP
    try {
      await supabase.from('otp_tokens').delete().eq('id', otpToken.id);
    } catch (delErr) {
      console.warn('Failed to delete OTP token (non-fatal):', delErr?.message || delErr);
    }

    return res.status(200).json({
      message: 'Verification complete.',
      verified: true,
      redirect_url: tavusData?.conversation_url || tavusData?.url || null
    });
  } catch (err) {
    console.error('Error in /api/candidate/verify-otp:', err);
    return res.status(500).json({ error: 'Server error during OTP verification.' });
  }
});

module.exports = router;
