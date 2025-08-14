const express = require("express");
const { supabase } = require("../src/lib/supabaseClient");

const router = express.Router();

router.post("/", async (req, res) => {
  try {
    const { email, code } = req.body || {};
    if (!email || !/^\d{6}$/.test(String(code || ""))) {
      return res.status(400).json({ error: "Invalid email or 6-digit code." });
    }

    // newest token (try candidate_email first)
    let token = null, tErr = null;

    const tryBy = async (col) => {
      const { data, error } = await supabase
        .from("otp_tokens")
        .select("code, expires_at, used, authkey_logid")
        .eq(col, email)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      return { data, error };
    };

    ({ data: token, error: tErr } = await tryBy("candidate_email"));
    if ((!token || tErr) ) {
      // fallback if some rows still use 'email'
      ({ data: token, error: tErr } = await tryBy("email"));
    }

    if (tErr || !token) return res.status(400).json({ error: "OTP not found." });
    if (token.expires_at && new Date(token.expires_at) <= new Date()) {
      return res.status(400).json({ error: "OTP has expired. Please try again." });
    }
    if (token.used === true) return res.status(400).json({ error: "OTP already used." });
    if (String(token.code) !== String(code)) return res.status(400).json({ error: "Invalid code." });

    // mark token used (prefer candidate_email; fallback to email)
    const nowIso = new Date().toISOString();
    let upd = await supabase
      .from("otp_tokens")
      .update({ used: true, used_at: nowIso })
      .eq("candidate_email", email);
    if (upd.error || (upd.count === 0 && (upd.data ?? []).length === 0)) {
      await supabase
        .from("otp_tokens")
        .update({ used: true, used_at: nowIso })
        .eq("email", email);
    }

    // Latest candidate for this email → Verified
    const { data: cand } = await supabase
      .from("candidates")
      .select("id, role_id")
      .eq("email", email)
      .order("created_at", { ascending: false })
      .limit(1)
      .single();

    await supabase.from("candidates").update({ status: "Verified" }).eq("id", cand.id);

    return res.status(200).json({
      message: "Verified",
      candidate_id: cand.id,
      role_id: cand.role_id,
      email
    });
  } catch (e) {
    return res.status(500).json({ error: e.message || "Server error" });
  }
});

module.exports = router;
