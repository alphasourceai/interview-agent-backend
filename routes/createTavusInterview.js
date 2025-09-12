// routes/createTavusInterview.js
'use strict';

const express = require('express');
const { supabase } = require('../src/lib/supabaseClient');
const { createTavusInterviewHandler } = require('../handlers/createTavusInterview');

const router = express.Router();

router.post('/', async (req, res) => {
  try {
    const computedBase = `${req.protocol}://${req.get('host')}`;
    const base = (process.env.PUBLIC_BACKEND_URL || computedBase).replace(/\/+$/, '');

    const { candidate_id, role_id: roleIdFromBody } = req.body || {};
    if (!candidate_id) return res.status(400).json({ error: 'candidate_id required' });

    // candidate
    const { data: candidate, error: cErr } = await supabase
      .from('candidates')
      .select('*')
      .eq('id', candidate_id)
      .single();
    if (cErr || !candidate) return res.status(404).json({ error: cErr?.message || 'Candidate not found' });

    const roleId = roleIdFromBody || candidate.role_id;
    if (!roleId) return res.status(400).json({ error: 'role_id not provided and candidate has no role_id' });

    // role
    const { data: role, error: rErr } = await supabase
      .from('roles')
      .select('*')
      .eq('id', roleId)
      .single();
    if (rErr || !role) return res.status(404).json({ error: rErr?.message || 'Role not found' });

    const webhookUrl = `${base}/webhook/tavus`;

    // Tavus
    const result = await createTavusInterviewHandler(candidate, role, webhookUrl);

    // Immediately reflect on candidate
    await supabase
      .from('candidates')
      .update({
        interview_status: 'Started',
        interview_video_url: result.conversation_url || null,
        candidate_external_id: result.conversation_id || null
      })
      .eq('id', candidate_id);

    // Stamp linkage on existing report rows for this candidate (if any)
    await supabase
      .from('reports')
      .update({
        role_id: role.id,
        client_id: role.client_id || candidate.client_id || null,
        candidate_external_id: result.conversation_id || null
      })
      .eq('candidate_id', candidate_id);

    // Check for existing interview row
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
      const { error: iErr, data: iData } = await supabase
        .from('interviews')
        .insert({
          candidate_id,
          role_id: roleId,
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

module.exports = router;
