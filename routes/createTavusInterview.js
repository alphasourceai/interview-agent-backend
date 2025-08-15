const express = require("express");
const { supabase } = require("../src/lib/supabaseClient");
const { createTavusInterviewHandler } = require("../handlers/createTavusInterview");

const createInterviewRouter = express.Router();

createInterviewRouter.post("/", async (req, res) => {
  try {
    const base = (process.env.PUBLIC_BACKEND_URL || "").replace(/\/+$/,"");
if (!base) return res.status(500).json({ error: "PUBLIC_BACKEND_URL not set" });

    const { candidate_id, role_id: roleIdFromBody } = req.body || {};
    if (!candidate_id) return res.status(400).json({ error: "candidate_id required" });

    const { data: candidate, error: cErr } = await supabase
      .from("candidates")
      .select("id, role_id, email, name")
      .eq("id", candidate_id)
      .single();
    if (cErr || !candidate) return res.status(404).json({ error: "Candidate not found" });

    const role_id = roleIdFromBody || candidate.role_id;

    const { data: role, error: rErr } = await supabase
      .from("roles")
      .select("id, kb_document_id")
      .eq("id", role_id)
      .single();
    if (rErr || !role) return res.status(404).json({ error: "Role not found" });

    const { data: existing } = await supabase
      .from("interviews")
      .select("id, video_url, status, tavus_application_id")
      .eq("candidate_id", candidate.id)
      .eq("role_id", role_id)
      .maybeSingle();

    const webhookUrl = `${base}/webhook/recording-ready`;
    const result = await createTavusInterviewHandler(candidate, role, webhookUrl);

    if (!existing) {
      const { data: inserted, error: iErr } = await supabase
        .from("interviews")
        .insert({
          candidate_id: candidate.id,
          role_id,
          status: result.conversation_url ? "Video Ready" : "Pending",
          video_url: result.conversation_url || null,
          tavus_application_id: result.conversation_id || null
        })
        .select("id")
        .single();
      if (iErr) return res.status(500).json({ error: iErr.message });
      return res.status(200).json({ message: "Interview created", video_url: result.conversation_url || null, interview_id: inserted.id });
    } else {
      const { error: uErr } = await supabase
        .from("interviews")
        .update({
          status: result.conversation_url ? "Video Ready" : "Pending",
          video_url: result.conversation_url || null,
          tavus_application_id: result.conversation_id || existing.tavus_application_id || null
        })
        .eq("id", existing.id);
      if (uErr) return res.status(500).json({ error: uErr.message });
      return res.status(200).json({ message: "Interview updated", video_url: result.conversation_url || null, interview_id: existing.id });
    }
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

module.exports = createInterviewRouter;
