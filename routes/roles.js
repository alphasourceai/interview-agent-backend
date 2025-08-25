const express = require("express");
const { supabaseAdmin } = require("../src/lib/supabaseClient");

const router = express.Router();

function normalizeString(x) {
  return (x || "").toString().trim();
}

// GET /roles?client_id=...
router.get("/", async (req, res) => {
  try {
    const clientId = req.query.client_id;
    if (!clientId || !req.clientIds?.includes(clientId)) {
      return res.status(403).json({ error: "Forbidden or missing client_id" });
    }

    const { data, error } = await supabaseAdmin
      .from("roles")
      .select("*")
      .eq("client_id", clientId)
      .order("created_at", { ascending: false });

    if (error) return res.status(400).json({ error: error.message });
    return res.json({ roles: data || [] });
  } catch (e) {
    console.error("GET /roles error", e);
    return res.status(500).json({ error: "Unable to list roles" });
  }
});

// POST /roles
// body: { client_id, title, interview_type, manual_questions[], jd_file? {bucket, path} | jd_text? }
router.post("/", async (req, res) => {
  try {
    const { client_id, title, interview_type, manual_questions, jd_text, jd_file } = req.body || {};

    if (!client_id || !req.clientIds?.includes(client_id)) {
      return res.status(403).json({ error: "Forbidden or missing client_id" });
    }

    const payload = {
      client_id,
      title: normalizeString(title),
      interview_type: normalizeString(interview_type),
      manual_questions: Array.isArray(manual_questions) ? manual_questions : [],
      jd_text: null,
      jd_file: null,
      created_at: new Date().toISOString(),
    };

    if (jd_file && jd_file.bucket && jd_file.path) {
      payload.jd_file = jd_file;
    } else {
      payload.jd_text = normalizeString(jd_text);
    }

    const { data, error } = await supabaseAdmin
      .from("roles")
      .insert(payload)
      .select("*")
      .single();

    if (error) return res.status(400).json({ error: error.message });
    return res.json({ role: data });
  } catch (e) {
    console.error("POST /roles error", e);
    return res.status(500).json({ error: "Unable to create role" });
  }
});

module.exports = router;
