// routes/kb.js (POST /kb/upload)
const express = require("express");
const axios = require("axios");
const { supabase } = require("../src/lib/supabaseClient");

const kbRouter = express.Router();

kbRouter.post("/upload", async (req, res) => {
  try {
    const { role_id } = req.body || {};
    if (!role_id) return res.status(400).json({ error: "role_id required" });

    const base = (process.env.PUBLIC_BACKEND_URL || "").replace(/\/+$/,"");
    if (!base) return res.status(500).json({ error: "PUBLIC_BACKEND_URL not set" });

    // optional: fetch role name for a nicer document_name
    const { data: role, error: rErr } = await supabase
      .from("roles")
      .select("id, title")
      .eq("id", role_id)
      .single();
    if (rErr || !role) return res.status(404).json({ error: "Role not found" });

    const document_url = `${base}/kb/${role_id}`;

    // IMPORTANT: use `tags` (not `document_tags`)
    const payload = {
      document_url,
      document_name: role.title ? `Role KB — ${role.title}` : `role-kb-${role_id}`,
      tags: ["role", String(role_id)]
      // callback_url: "<optional webhook for doc processing>"
      // properties: { any: "metadata" } // optional
    };

    const resp = await axios.post("https://tavusapi.com/v2/documents", payload, {
      headers: { "x-api-key": process.env.TAVUS_API_KEY }
    });

    const kbId = resp?.data?.uuid || resp?.data?.id || null;
    if (!kbId) return res.status(502).json({ error: "No document id from Tavus", details: resp?.data });

    const { error } = await supabase.from("roles").update({ kb_document_id: kbId }).eq("id", role_id);
    if (error) return res.status(500).json({ error: error.message });

    return res.status(200).json({ kb_document_id: kbId });
  } catch (e) {
    // Bubble up Tavus error details to help debugging
    const status = e.response?.status || 500;
    const details = e.response?.data || e.message;
    return res.status(status).json({ error: details });
  }
});

module.exports = { kbRouter };
