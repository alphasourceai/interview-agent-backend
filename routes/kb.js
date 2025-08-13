const express = require("express");
const axios = require("axios");
const { supabase } = require("../src/lib/supabaseClient");

const kbRouter = express.Router();

kbRouter.get("/:role_id", async (req, res) => {
  try {
    const { role_id } = req.params;
    const { data: role, error } = await supabase
      .from("roles")
      .select("id, title, rubric")
      .eq("id", role_id)
      .single();
    if (error || !role) return res.status(404).send("Not found");
    const lines = [];
    lines.push(`Role: ${role.title}`);
    lines.push(`Interview Rubric / Questions`);
    if (Array.isArray(role?.rubric?.questions)) {
      role.rubric.questions.forEach((q, i) => {
        const t = typeof q === "string" ? q : q?.text || "";
        lines.push(`${i + 1}. ${t}`);
      });
    }
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    return res.status(200).send(lines.join("\n"));
  } catch (e) {
    return res.status(500).send("Error");
  }
});

kbRouter.post("/upload", async (req, res) => {
  try {
    const { role_id } = req.body || {};
    if (!role_id) return res.status(400).json({ error: "role_id required" });

    const base = (process.env.PUBLIC_BACKEND_URL || "").replace(/\/+$/,"");
    if (!base) return res.status(500).json({ error: "PUBLIC_BACKEND_URL not set" });

    const document_url = `${base}/kb/${role_id}`;

    const r = await axios.post(
      "https://tavusapi.com/v2/documents",
      { document_url, document_tags: ["role", String(role_id)] },
      { headers: { "x-api-key": process.env.TAVUS_API_KEY } }
    );

    const kbId = r?.data?.uuid || r?.data?.id || null;
    if (!kbId) return res.status(502).json({ error: "No document id from Tavus" });

    const { error } = await supabase.from("roles").update({ kb_document_id: kbId }).eq("id", role_id);
    if (error) return res.status(500).json({ error: error.message });

    return res.status(200).json({ kb_document_id: kbId });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

module.exports = { kbRouter };
