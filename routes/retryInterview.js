// routes/retryInterview.js
'use strict';

const express = require('express');
const { supabase } = require('../src/lib/supabaseClient');
const { requireAuth, withClientScope } = require('../src/middleware/auth');
const { createTavusInterviewHandler } = require('../handlers/createTavusInterview');

const router = express.Router();

// Collect scoped client IDs from standardized middleware
function getScopedClientIds(req) {
  const fromScope = Array.isArray(req?.clientScope?.memberships)
    ? req.clientScope.memberships.map(m => m.client_id).filter(Boolean)
    : [];
  const legacy = req.client?.id ? [req.client.id] : [];
  return Array.from(new Set([...fromScope, ...legacy]));
}

// Build a backend base URL when env var is missing (works on Render/localhost)
function deriveBaseUrl(req) {
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const proto = req.headers['x-forwarded-proto'] || (req.secure ? 'https' : 'http');
  return host ? `${proto}://${host}` : '';
}

/**
 * POST /interviews/retry/:id/retry-create
 *
 * Re-attempts creating a Tavus conversation for an interview that doesn't
 * yet have a video_url. Enforces auth + client scope.
 */
router.post('/:id/retry-create', requireAuth, withClientScope, async (req, res) => {
  try {
    const { id } = req.params;

    const envBase = (process.env.PUBLIC_BACKEND_URL || '').replace(/\/+$/, '');
    const base = envBase || deriveBaseUrl(req);
    if (!base) return res.status(500).json({ error: 'PUBLIC_BACKEND_URL not set and could not derive base URL' });

    // Load interview (includes client_id for scope check)
    const { data: interview, error: e1 } = await supabase
      .from('interviews')
      .select('id, candidate_id, role_id, client_id, video_url, status, tavus_application_id')
      .eq('id', id)
      .single();

    if (e1 || !interview) return res.status(404).json({ error: 'Interview not found' });

    // Scope enforcement using standardized scope
    const scopedIds = getScopedClientIds(req);
    if (!scopedIds.includes(interview.client_id)) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    // If video already exists, return it (idempotent)
    if (interview.video_url) {
      return res.status(200).json({
        video_url: interview.video_url,
        message: 'Already available',
      });
    }

    // Load candidate + role
    const { data: candidate, error: cErr } = await supabase
      .from('candidates')
      .select('id, role_id, email, name')
      .eq('id', interview.candidate_id)
      .single();
    if (cErr || !candidate) return res.status(404).json({ error: cErr?.message || 'Candidate not found' });

    const { data: role, error: rErr } = await supabase
      .from('roles')
      .select('id, kb_document_id')
      .eq('id', interview.role_id)
      .single();
    if (rErr || !role) return res.status(404).json({ error: rErr?.message || 'Role not found' });

    // Create Tavus conversation (keeping your existing webhook path)
    const webhookUrl = `${base}/webhook/recording-ready`;
    const result = await createTavusInterviewHandler(candidate, role, webhookUrl);

    if (!result?.conversation_url) {
      return res.status(502).json({ error: 'Failed to create conversation' });
    }

    // Update interview record
    const { error: uErr } = await supabase
      .from('interviews')
      .update({
        status: 'Video Ready',
        video_url: result.conversation_url,
        tavus_application_id: result.conversation_id || interview.tavus_application_id || null,
      })
      .eq('id', interview.id);

    if (uErr) return res.status(500).json({ error: uErr.message });

    return res.status(200).json({ video_url: result.conversation_url });
  } catch (e) {
    console.error('[POST /interviews/retry/:id/retry-create] error:', e);
    return res.status(500).json({ error: e.message || 'Server error' });
  }
});

module.exports = router;
