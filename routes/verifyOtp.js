// routes/verifyOtp.js
const express = require("express");
const { supabase } = require("../src/lib/supabaseClient");

const router = express.Router();

/**
 * POST /api/candidate/verify-otp
 * Body: { email: string, code: "######" }
 */
router.post("/", async (req, res) => {
  try {
    const email = String(req.body?.email || "").trim();
    const code  = String(req.body?.code  || "").trim();

    if (!email || !/^\d{6}$/.test(code)) {
      return res.status(400).json({ error: "Invalid email or 6-digit code." });
    }

    // 1) Find newest candidate for this email
    const { data: cand, error: cErr } = await supabase
      .from("candidates")
      .select("id, role_id, status")
      .eq("email", email)
      .order("created_at", { ascending: false })
      .limit(1)
      .single();

    if (cErr || !cand) return res.status(404).json({ error: "Candidate not found." });

    // 2) Newest OTP token for this email + role (your schema uses candidate_email + role_id)
    const { data: token, error: tErr } = await supabase
      .from("otp_tokens")
      .select("id, code, expires_at, used, role_id")
      .eq("candidate_email", email)
      .eq("role_id", cand.role_id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (tErr || !token) return res.status(400).json({ error: "OTP not found." });

    // 3) Validate that token
    if (token.expires_at && new Date(token.expires_at) <= new Date()) {
      return res.status(400).json({ error: "OTP has expired. Please try again." });
    }
    if (token.used === true) {
      return res.status(400).json({ error: "OTP already used. Please request a new one." });
    }
    if (String(token.code) !== code) {
      return res.status(400).json({ error: "Invalid code." });
    }

    // 4) Mark OTP used (robust): first try by id; if that fails, try by composite keys
    const nowIso = new Date().toISOString();

    let uTokErr = null;
    let updated = 0;

    // try by id (preferred)
    {
      const { data: upd, error } = await supabase
        .from("otp_tokens")
        .update({ used: true, used_at: nowIso })
        .eq("id", token.id)
        .eq("used", false)              // idempotent guard
        .select("id");
      uTokErr = error || null;
      updated = Array.isArray(upd) ? upd.length : 0;
    }

    // fallback by composite if nothing updated (handles schemas without id or RLS quirks)
    if (!uTokErr && updated === 0) {
      const { data: upd2, error: err2 } = await supabase
        .from("otp_tokens")
        .update({ used: true, used_at: nowIso })
        .eq("candidate_email", email)
        .eq("role_id", cand.role_id)
        .eq("code", code)
        .eq("used", false)
        .select("role_id");
      uTokErr = err2 || null;
      updated = Array.isArray(upd2) ? upd2.length : updated;
    }

    if (uTokErr || updated === 0) {
      return res.status(500).json({
        error: "Could not mark OTP as used."
        // (we keep the error minimal in the response; logs will have details)
      });
    }

    // 5) Update candidate to Verified
    const { error: uCandErr } = await supabase
      .from("candidates")
      .update({ status: "Verified" })
      .eq("id", cand.id);
    if (uCandErr) return res.status(500).json({ error: "Could not update verification status." });

    // 6) Done
    return res.status(200).json({
      message: "Verified",
      candidate_id: cand.id,
      role_id: cand.role_id,
      email
    });
  } catch (e) {
    // Log server-side for debugging
    console.error("verify-otp error:", e?.response?.data || e?.message || e);
    return res.status(500).json({ error: e?.message || "Server error" });
  }
});

module.exports = router;
