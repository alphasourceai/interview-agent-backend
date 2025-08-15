// routes/createTavusInterview.js
'use strict';

const express = require('express');
const { supabase } = require('../src/lib/supabaseClient');
const { createTavusInterviewHandler } = require('../handlers/createTavusInterview');

const createInterviewRouter = express.Router();

/**
 * POST /create-tavus-interview
 * Body: { candidate_id: string, role_id?: string, email?: string }
 * Behavior:
 *  - Loads candidate + role (role by candidate.role_id if role_id not provided)
 *  - Builds webhook URL from PUBLIC_BACKEND_URL
 *  - Calls handler to create/ensure Tavus conversation (attaches KB via document_ids)
 *  - Upserts into interviews table (status 'Pending' until webhook marks 'Video Ready')
 */
createInterviewRouter.post('/', async (req, res) => {
  try {
    const base = (process.env.PUBLIC_BACKEND_URL || '').replace(/\/+$/, '');
    if (!base) return res.status(500).json({ error: 'PUBLIC_BACKEND_URL not set' });

    const { candidate_id, role_id: roleIdFromBody } = req.body || {};
    if (!candidate_id) return res.status(400).json({ error: 'candidate_id required' });

    // Candidate
    const { data: candidate, error: cErr } = await supabase
      .from('candidates')
      .select('*')
      .eq('id', candidate_id)
      .single();
    if (cErr || !candidate) return res.status(404).json({ error: cErr?.message || 'Candidate not found' });

    // Role (allow role_id passed in body to override)
    const roleId = roleIdFromBody || candidate.role_id;
    if (!roleId) return res.status(400).json({ error: 'role_id not provided and candidate has no role_id' });

    const { data: role, error: rErr } = await supabase
      .from('roles')
      .select('*')
      .eq('id', roleId)
      .single();
    if (rErr || !role) return res.status(404).json({ error: rErr?.message || 'Role not found' });

    const webhookUrl = `${base}/webhook/recording-ready`;

    // Create (or recreate) conversation with KB if present
    const result = await createTavusInterviewHandler(candidate, role, webhookUrl);

    // Check for existing interview for this (candidate, role)
    const { data: existing, error: eErr } = await supabase
      .from('interviews')
      .select('id, tavus_application_id')
      .eq('candidate_id', candidate_id)
      .eq('role_id', roleId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (eErr) return res.status(500).json({ error: eErr.message });

    if (!existing) {
      // Insert fresh interview row
      const { error: iErr, data: iData } = await supabase
        .from('interviews')
        .insert({
          candidate_id,
          role_id: roleId,
          // Conversation URL is the join link; we reuse 'video_url' until webhook sets real video URL.
          video_url: result.conversation_url || null,
          tavus_application_id: result.conversation_id || null,
          status: 'Pending'
        })
        .select('id')
        .single();
      if (iErr) return res.status(500).json({ error: iErr.message });

      return res.status(200).json({
        message: 'Interview created',
        conversation_url: result.conversation_url || null,
        interview_id: iData.id
      });
    } else {
      // Update existing record with latest conversation info
      const { error: uErr } = await supabase
        .from('interviews')
        .update({
          video_url: result.conversation_url || null,
          tavus_application_id: result.conversation_id || existing.tavus_application_id || null,
          status: 'Pending'
        })
        .eq('id', existing.id);
      if (uErr) return res.status(500).json({ error: uErr.message });

      return res.status(200).json({
        message: 'Interview updated',
        conversation_url: result.conversation_url || null,
        interview_id: existing.id
      });
    }
  } catch (e) {
    const status = e.status || 500;
    return res.status(status).json({ error: e.message });
  }
});

module.exports = createInterviewRouter;
