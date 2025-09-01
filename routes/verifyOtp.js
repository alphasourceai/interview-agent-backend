// routes/verifyOtp.js
'use strict';

const express = require('express');
const { supabase } = require('../src/lib/supabaseClient');

const router = express.Router();

/**
 * POST /verify-otp
 * Body: { email: string, code: "######" }
 *
 * Public endpoint used by candidates to verify the 6-digit code.
 */
router.post('/', async (req, res) => {
  try {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const code  = String(req.body?.code  || '').trim();

    if (!email || !/^\d{6}$/.test(code)) {
      return res.status(400).json({ error: 'Invalid email or 6-digit code.' });
    }

    // 1) Newest candidate for this email
    const { data: cand, error: cErr } = await supabase
      .from('candidates')
      .select('id, role_id')
      .eq('email', email)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (cErr || !cand) return res.status(404).json({ error: 'Candidate not found.' });

    // 2) Newest OTP for (candidate_email, role_id)
    const { data: token, error: tErr } = await supabase
      .from('otp_tokens')
      .select('id, code, expires_at, used, role_id, created_at')
      .eq('candidate_email', email)
      .eq('role_id', cand.role_id)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (tErr || !token) return res.status(400).json({ error: 'OTP not found.' });

    // 3) Validate
    const nowMs = Date.now();
    const expMs = token.expires_at ? new Date(token.expires_at).getTime() : null;
    if (expMs && expMs <= nowMs) {
      return res.status(400).json({ error: 'OTP has expired. Please try again.' });
    }

    const usedStr = String(token.used).toLowerCase();
    const isUsed = usedStr === 'true' || usedStr === 't' || usedStr === '1';
    if (isUsed) return res.status(400).json({ error: 'OTP already used. Please request a new one.' });

    if (String(token.code) !== code) return res.status(400).json({ error: 'Invalid code.' });

    // 4) Mark OTP used (multi-schema support). Prefer update by id, verify by read-back.
    const updatesToTry = [
      { used: true, used_at: new Date().toISOString() }, // boolean + used_at (newer schema)
      { used: true },                                     // boolean only
      { used: 'true' },                                   // text schema
    ];

    let updatedOk = false;
    let lastErr = null;

    for (const payload of updatesToTry) {
      const { error } = await supabase
        .from('otp_tokens')
        .update(payload)
        .eq('id', token.id);

      if (!error) {
        const { data: checkRow } = await supabase
          .from('otp_tokens')
          .select('used')
          .eq('id', token.id)
          .maybeSingle();

        const nowUsedStr = String(checkRow?.used).toLowerCase();
        const nowUsed = nowUsedStr === 'true' || nowUsedStr === 't' || nowUsedStr === '1';
        if (nowUsed) { updatedOk = true; break; }
      } else {
        lastErr = error;
      }
    }

    // Last-resort composite update if id route failed (RLS quirks, etc.)
    if (!updatedOk) {
      const { error } = await supabase
        .from('otp_tokens')
        .update({ used: 'true' })
        .eq('candidate_email', email)
        .eq('role_id', cand.role_id)
        .eq('code', code);

      if (!error) {
        const { data: checkRow2 } = await supabase
          .from('otp_tokens')
          .select('used')
          .eq('candidate_email', email)
          .eq('role_id', cand.role_id)
          .eq('code', code)
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle();

        const nowUsedStr2 = String(checkRow2?.used).toLowerCase();
        const nowUsed2 = nowUsedStr2 === 'true' || nowUsedStr2 === 't' || nowUsedStr2 === '1';
        updatedOk = nowUsed2;
      } else {
        lastErr = error;
      }
    }

    if (!updatedOk) {
      console.error('mark-used failed:', lastErr);
      return res.status(500).json({ error: 'Could not mark OTP as used.' });
    }

    // 5) Update candidate to Verified
    const { error: uCandErr } = await supabase
      .from('candidates')
      .update({ status: 'Verified' })
      .eq('id', cand.id);

    if (uCandErr) return res.status(500).json({ error: 'Could not update verification status.' });

    return res.status(200).json({
      message: 'Verified',
      candidate_id: cand.id,
      role_id: cand.role_id,
      email,
    });
  } catch (e) {
    console.error('verify-otp error:', e?.response?.data || e?.message || e);
    return res.status(500).json({ error: e?.message || 'Server error' });
  }
});

module.exports = router;
