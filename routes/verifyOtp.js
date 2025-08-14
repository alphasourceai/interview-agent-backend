const express = require("express");
const { supabase } = require("../src/lib/supabaseClient");

const router = express.Router();

router.post("/", async (req, res) => {
  try {
    const { email, code } = req.body || {};
    if (!email || !/^\d{6}$/.test(String(code || ""))) {
      return res.status(400).json({ error: "Invalid email or 6-digit code." });
    }

    // newest OTP
    const { data: token } = await supabase
      .from("otp_tokens")
      .select("code, expires_at, used")
      .eq("email", email)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!token) return res.status(400).json({ error: "OTP not found." });
    if (token.expires_at && new Date(token.expires_at) <= new Date()) {
      return res.status(400).json({ error: "OTP has expired. Please try again." });
    }
    if (token.used === true) return res.status(400).json({ error: "OTP already used." });
    if (String(token.code) !== String(code)) return res.status(400).json({ error: "Invalid code." });

    // Mark token used (best-effort)
    await supabase.from("otp_tokens")
      .update({ used: true, used_at: new Date().toISOString() })
      .eq("email", email)
      .eq("code", String(code));

    // Latest candidate for this email → Verified
    const { data: cand } = await supabase
      .from("candidates")
      .select("id, role_id")
      .eq("email", email)
      .order("created_at", { ascending: false })
      .limit(1)
      .single();

    await supabase.from("candidates").update({ status: "Verified" }).eq("id", cand.id);

    return res.status(200).json({ message: "Verified", candidate_id: cand.id, role_id: cand.role_id, email });
  } catch (e) {
    return res.status(500).json({ error: e.message || "Server error" });
  }
});

module.exports = router;
