// routes/verifyOtp.js
const express = require("express");
const { supabase } = require("../src/lib/supabaseClient");

const router = express.Router();

/**
 * POST /api/candidate/verify-otp
 * Body (preferred): { email, code, candidate_id?, role_id? }
 * - email and 6-digit code are required
 * - candidate_id/role_id remove ambiguity if the same email is used across roles
 */
router.post("/", async (req, res) => {
  try {
    const email = String(req.body?.email || "").trim().toLowerCase();
    const code  = String(req.body?.code  || "").trim();
    const candidateIdIn = req.body?.candidate_id ? String(req.body.candidate_id).trim() : "";
    const roleIdIn      = req.body?.role_id ? String(req.body.role_id).trim() : "";

    if (!email || !/^\d{6}$/.test(code)) {
      return res.status(400).json({ error: "Invalid email or 6-digit code." });
    }

    // 1) Resolve candidate + role
    let cand = null, cErr = null;
    if (candidateIdIn) {
      ({ data: cand, error: cErr } = await supabase
        .from("candidates")
        .select("id, role_id")
        .eq("id", candidateIdIn)
        .single());
    } else {
      ({ data: cand, error: cErr } = await supabase
        .from("candidates")
        .select("id, role_id")
        .eq("email", email)
        .order("created_at", { ascending: false })
        .limit(1)
        .single());
    }
    if (cErr || !cand) return res.status(404).json({ error: "Candidate not found." });

    const roleId = roleIdIn || cand.role_id;

    // 2) Newest OTP for (candidate_email, role_id)
    const { data: token, error: tErr } = await supabase
      .from("otp_tokens")
      .select("id, code, expires_at, used, role_id")
      .eq("candidate_email", email)
      .eq("role_id", roleId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (tErr || !token) return res.status(400).json({ error: "OTP not found." });

    // 3) Validate
    if (token.expires_at && new Date(token.expires_at) <= new Date()) {
      return res.status(400).json({ error: "OTP has expired. Please try again." });
    }
    const isUsed = String(token.used).toLowerCase() === "true"; // supports text/boolean
    if (isUsed) return res.status(400).json({ error: "OTP already used. Please request a new one." });
    if (String(token.code) !== code) return res.status(400).json({ error: "Invalid code." });

    // 4) Mark OTP used (handle text/boolean schemas). Prefer update by id; confirm with read-back.
    const updatesToTry = [
      { used: true,  used_at: new Date().toISOString() }, // boolean + used_at (newer schema)
      { used: true },                                     // boolean only
      { used: "true" },                                   // text schema
    ];

    let updatedOk = false;
    let lastErr = null;

    for (const payload of updatesToTry) {
      const { error } = await supabase.from("otp_tokens").update(payload).eq("id", token.id);
      if (!error) {
        const { data: checkRow } = await supabase
          .from("otp_tokens")
          .select("used")
          .eq("id", token.id)
          .single();
        const nowUsed = String(checkRow?.used).toLowerCase() === "true";
        if (nowUsed) { updatedOk = true; break; }
      } else {
        lastErr = error;
      }
    }

    // Last-resort composite update if id route failed (RLS quirks, etc.)
    if (!updatedOk) {
      const { error } = await supabase
        .from("otp_tokens")
        .update({ used: "true" }) // text-safe; casts in boolean schemas as well
        .eq("candidate_email", email)
        .eq("role_id", roleId)
        .eq("code", code);
      if (!error) {
        const { data: checkRow2 } = await supabase
          .from("otp_tokens")
          .select("used")
          .eq("candidate_email", email)
          .eq("role_id", roleId)
          .eq("code", code)
          .order("created_at", { ascending: false })
          .limit(1)
          .single();
        const nowUsed = String(checkRow2?.used).toLowerCase() === "true";
        updatedOk = nowUsed;
      } else {
        lastErr = error;
      }
    }

    if (!updatedOk) {
      console.error("mark-used failed:", lastErr);
      return res.status(500).json({ error: "Could not mark OTP as used." });
    }

    // 5) Update candidate to Verified (set flags + timestamp)
    const { error: uCandErr } = await supabase
      .from("candidates")
      .update({ status: "Verified", verified: true, otp_verified_at: new Date().toISOString() })
      .eq("id", cand.id);
    if (uCandErr) return res.status(500).json({ error: "Could not update verification status." });

    return res.status(200).json({
      message: "Verified",
      verified: true,
      candidate_id: cand.id,
      role_id: roleId,
      email
    });
  } catch (e) {
    console.error("verify-otp error:", e?.response?.data || e?.message || e);
    return res.status(500).json({ error: e?.message || "Server error" });
  }
});

module.exports = router;
