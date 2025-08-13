const express = require("express");
const { supabase } = require("../src/lib/supabaseClient");
const { createTavusInterviewHandler } = require("../handlers/createTavusInterview");

const retryRouter = express.Router();

retryRouter.post("/:id/retry-create", async (req, res) => {
  try {
    const { id } = req.params;
    const base = (process.env.PUBLIC_BACKEND_URL || "").replace(/\/+$/,"");
    if (!base) return res.status(500).json({ error: "PUBLIC_BACKEND_URL not set" });

    const { data: interview, error: e1 } = await supabase
      .from("interviews")
      .select("id, candidate_id, role_id, video_url, status, tavus_application_id")
      .eq("id", id)
      .single();
    if (e1 || !interview) return res.status(404).json({ error: "Interview not found" });

    if (interview.video_url) return res.status(200).json({ video_url: interview.video_url, message: "Already available" });

    const { data: candidate } = await supabase
      .from("candidates")
      .select("id, role_id, email, name")
      .eq("id", interview.candidate_id)
      .single();

    const { data: role } = await supabase
      .from("roles")
      .select("id, kb_document_id")
      .eq("id", interview.role_id)
      .single();

    const webhookUrl = `${base}/webhook/recording-ready`;
    const result = await createTavusInterviewHandler(candidate, role, webhookUrl);
    if (!result?.conversation_url) return res.status(502).json({ error: "Failed to create conversation" });

    const { error: uErr } = await supabase
      .from("interviews")
      .update({
        status: "Video Ready",
        video_url: result.conversation_url,
        tavus_application_id: result.conversation_id || interview.tavus_application_id || null
      })
      .eq("id", interview.id);
    if (uErr) return res.status(500).json({ error: uErr.message });

    return res.status(200).json({ video_url: result.conversation_url });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

module.exports = retryRouter;
