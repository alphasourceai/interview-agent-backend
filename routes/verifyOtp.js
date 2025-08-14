// routes/verifyOtp.js
const express = require("express");
const { supabase } = require("../src/lib/supabaseClient");

const router = express.Router();

/**
 * POST /api/candidate/verify-otp
 * Body: { email: string, code: "######" }
 * - Looks up newest candidate by email
 * - Validates newest OTP for (candidate_email=email AND role_id)
 * - Marks OTP used and candidate Verified
 * - Returns { message, candidate_id, role_id, email }
 */
router.post("/", async (req, res) => {
  try {
    const rawEmail = (req.body?.email || "").trim();
    const rawCode = String(req.body?.code ?? "").trim();

    if (!rawEmail || !/^\d{6}$/.test(rawCode)) {
      return res.status(400).json({ error: "Invalid email or 6-digit code." });
    }

    // 1) Get newest candidate for this email
    const { data: cand, error: cErr } = await supabase
      .from("candidates")
      .select("id, role_id, status")
      .eq("email", rawEmail)
      .order("created_at", { ascending: false })
      .limit(1)
      .single();

    if (cErr || !cand) {
      return res.status(404).json({ error: "Candidate not found." });
    }

    // 2) Get newest OTP token for this email + role (prefer candidate_email column)
    let token = null;

    const { data: t1, error: t1Err } = await supabase
      .from("otp_tokens")
      .select("id, code, expires_at, used, role_id")
      .eq("candidate_email", rawEmail)
      .eq("role_id", cand.role_id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!t1Err && t1) token = t1;

    // Fallback: if your older rows used 'email' instead of 'candidate_email'
    if (!token) {
      const { data: t2 } = await supabase
        .from("otp_tokens")
        .select("id, code, expires_at, used, role_id")
        .eq("email", rawEmail)
        .eq("role_id", cand.role_id)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (t2) token = t2;
    }

    if (!token) {
      return res.status(400).json({ error: "OTP not found." });
    }

    // 3) Validate token (expiry + used + code match)
    if (token.expires_at && new Date(token.expires_at) <= new Date()) {
      return res.status(400).json({ error: "OTP has expired. Please try again." });
    }
    if (token.used === true) {
      return res.status(400).json({ error: "OTP already used. Please request a new one." });
    }
    if (String(token.code) !== rawCode) {
      return res.status(400).json({ error: "Invalid code." });
    }

    // 4) Mark token used (by id to avoid touching other rows)
    const nowIso = new Date().toISOString();
    const { error: uTokErr } = await supabase
      .from("otp_tokens")
      .update({ used: true, used_at: nowIso })
      .eq("id", token.id);
    if (uTokErr) {
      return res.status(500).json({ error: "Could not mark OTP as used." });
    }

    // 5) Mark candidate Verified
    const { error: uCandErr } = await supabase
      .from("candidates")
      .update({ status: "Verified" })
      .eq("id", cand.id);

    if (uCandErr) {
      return res.status(500).json({ error: "Could not update verification status." });
    }

    // 6) Done
    return res.status(200).json({
      message: "Verified",
      candidate_id: cand.id,
      role_id: cand.role_id,
      email: rawEmail
    });
  } catch (e) {
    return res.status(500).json({ error: e?.message || "Server error" });
  }
});

module.exports = router;
