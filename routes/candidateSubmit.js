const express = require("express");
const multer = require("multer");
const { supabase } = require("../src/lib/supabaseClient");
const { sendEmailOtp } = require("../utils/sendEmailOtp");

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

function six() { return String(Math.floor(100000 + Math.random() * 900000)); }

router.post("/", upload.any(), async (req, res) => {
  try {
    const role_id = req.body.role_id;
    const name = req.body.name;
    const email = req.body.email;
    const phone = (req.body.phone || "").replace(/\D/g, ""); // optional now
    const resume_url_in = req.body.resume_url || null;

    if (!role_id || !name || !email) {
      return res.status(400).json({ error: "Required: role_id, name, email." });
    }

    const file = (req.files || []).find(f =>
      ["resume", "resume_file", "file", "resumeFile", "pdf"].includes(f.fieldname)
    );

    // 1) Create candidate
    const { data: inserted, error: cErr } = await supabase
      .from("candidates")
      .insert({ role_id, name, email, phone, status: "Resume Uploaded" })
      .select("id")
      .single();
    if (cErr) return res.status(500).json({ error: cErr.message });
    const candidate_id = inserted.id;

    // 2) Upload resume if provided
    let resume_url = resume_url_in;
    try {
      if (file) {
        const bucket = process.env.SUPABASE_RESUMES_BUCKET || "resumes";
        const path = `${candidate_id}.pdf`;
        const up = await supabase.storage.from(bucket).upload(path, file.buffer, {
          contentType: file.mimetype || "application/pdf", upsert: true
        });
        if (!up.error) {
          const { data: pub } = supabase.storage.from(bucket).getPublicUrl(path);
          resume_url = pub?.publicUrl || resume_url;
        }
      }
    } catch (e) {
      console.error("resume upload failed:", e?.message || e);
    }
    if (resume_url) await supabase.from("candidates").update({ resume_url }).eq("id", candidate_id);

    // 3) Create OTP (10 min) and email it
    const code = six();
    await supabase.from("otp_tokens").insert({
      email,
      code,
      expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
      used: false
    });

    try {
      await sendEmailOtp({ to: email, code });
    } catch (e) {
      console.error("sendEmailOtp failed:", e?.response?.data || e?.message || e);
      // Non-fatal: they can still fetch code from DB in dev
    }

    return res.status(200).json({
      message: "Candidate created. OTP emailed.",
      candidate_id,
      role_id,
      resume_url: resume_url || null
    });
  } catch (e) {
    return res.status(500).json({ error: e.message || "Server error" });
  }
});

module.exports = router;
