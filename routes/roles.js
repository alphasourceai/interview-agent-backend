// routes/roles.js
// Direct-export Express router (standardized)

const express = require('express');
const { supabase } = require('../src/lib/supabaseClient');
const { requireAuth, withClientScope } = require('../src/middleware/auth');

const router = express.Router();

/**
 * GET /roles?client_id=...
 * Returns roles for the specified (or scoped) client.
 */
router.get('/', requireAuth, withClientScope, async (req, res) => {
  try {
    const clientId =
      req.client?.id ||
      req.clientScope?.defaultClientId ||
      req.query.client_id ||
      null;

    if (!clientId) return res.status(400).json({ error: 'client_id required' });

    const { data, error } = await supabase
      .from('roles')
      .select('id,client_id,title,interview_type,created_at,rubric,job_description_url')
      .eq('client_id', clientId)
      .order('created_at', { ascending: false })
      .limit(500);

    if (error) {
      console.error('[GET /roles] supabase error', error);
      return res.status(500).json({ error: 'query failed (roles)' });
    }

    return res.json({ items: data || [] });
  } catch (e) {
    console.error('[GET /roles] unexpected', e);
    return res.status(500).json({ error: 'Server error' });
  }
});

/**
 * POST /roles
 * Body: { title, description, interview_type, client_id? }
 * Creates a role for the scoped client (or explicit client_id if provided).
 */
router.post('/', requireAuth, withClientScope, async (req, res) => {
  try {
    const clientId =
      req.body.client_id ||
      req.client?.id ||
      req.clientScope?.defaultClientId ||
      null;

    if (!clientId) return res.status(400).json({ error: 'client_id required' });

    const payload = {
      client_id: clientId,
      title: req.body.title || 'Untitled Role',
      description: req.body.description || null,
      interview_type: req.body.interview_type || 'BASIC',
    };

    const { data, error } = await supabase
      .from('roles')
      .insert(payload)
      .select()
      .limit(1)
      .single();

    if (error) {
      console.error('[POST /roles] supabase error', error);
      return res.status(500).json({ error: 'Failed to create role' });
    }

    return res.json({ role: data });
  } catch (e) {
    console.error('[POST /roles] unexpected', e);
    return res.status(500).json({ error: 'Server error' });
  }
});

/**
 * GET /roles/:id/jd-signed-url
 * Returns signed URL for job description file
 */
router.get('/:id/jd-signed-url', requireAuth, withClientScope, async (req, res) => {
  try {
    const clientId =
      req.query.client_id ||
      req.client?.id ||
      req.clientScope?.defaultClientId ||
      null;
    const roleId = req.params.id;

    if (!clientId || !roleId) {
      return res.status(400).json({ error: 'client_id and id required' });
    }

    const { data, error } = await supabase
      .from('roles')
      .select('id,client_id,job_description_url')
      .eq('id', roleId)
      .eq('client_id', clientId)
      .maybeSingle();

    if (error) {
      console.error('[GET /roles/:id/jd-signed-url] supabase error', error);
      return res.status(500).json({ error: 'Server error' });
    }
    if (!data || !data.job_description_url) {
      return res.status(404).json({ error: 'Not found' });
    }

    let path = data.job_description_url;
    if (path.startsWith('job-descriptions/')) {
      path = path.substring('job-descriptions/'.length);
    }

    const { data: urlData, error: storageError } = await supabase
      .storage
      .from('job-descriptions')
      .createSignedUrl(path, 60 * 10);

    if (storageError) {
      console.error('[GET /roles/:id/jd-signed-url] storage error', storageError);
      return res.status(500).json({ error: 'Failed to sign url' });
    }

    return res.json({ url: urlData.signedUrl });
  } catch (e) {
    console.error('[GET /roles/:id/jd-signed-url] unexpected', e);
    return res.status(500).json({ error: 'Server error' });
  }
});

/**
 * POST /roles/:id/rubric-request-changes
 * Logs a request for rubric changes
 */
router.post('/:id/rubric-request-changes', requireAuth, withClientScope, async (req, res) => {
  try {
    const clientId =
      req.body.client_id ||
      req.query.client_id ||
      req.client?.id ||
      req.clientScope?.defaultClientId ||
      null;
    const roleId = req.params.id;

    if (!clientId || !roleId) {
      return res.status(400).json({ error: 'client_id and id required' });
    }

    const { data: roleData, error: roleError } = await supabase
      .from('roles')
      .select('id')
      .eq('id', roleId)
      .eq('client_id', clientId)
      .maybeSingle();

    if (roleError) {
      console.error('[POST /roles/:id/rubric-request-changes] supabase error', roleError);
      return res.status(500).json({ error: 'Server error' });
    }
    if (!roleData) {
      return res.status(404).json({ error: 'Not found' });
    }

    console.log('[POST /roles/:id/rubric-request-changes]', {
      clientId,
      roleId,
      notes: (req.body?.notes || '').slice(0, 500),
      questions_count: Array.isArray(req.body?.questions) ? req.body.questions.length : 0,
    });

    return res.json({ ok: true });
  } catch (e) {
    console.error('[POST /roles/:id/rubric-request-changes] unexpected', e);
    return res.status(500).json({ error: 'Server error' });
  }
});

/**
 * DELETE /admin/roles?id=...&client_id=...
 * Also supports JSON body. Requires auth (global admin dashboard behavior).
 */
router.delete('/admin/roles', requireAuth, async (req, res) => {
  try {
    const roleId = req.query.id || req.body?.id;
    const clientId = req.query.client_id || req.body?.client_id;

    if (!roleId || !clientId) {
      return res.status(400).json({ error: 'Missing id or client_id' });
    }

    const { data, error } = await supabase
      .from('roles')
      .delete()
      .eq('id', roleId)
      .eq('client_id', clientId)
      .select('id')
      .maybeSingle();

    if (error) {
      console.error('[DELETE /admin/roles] supabase error', error);
      return res.status(500).json({ error: 'Failed to delete role' });
    }
    if (!data) return res.status(404).json({ error: 'Not found' });

    return res.json({ ok: true, id: data.id });
  } catch (e) {
    console.error('[DELETE /admin/roles] unexpected', e);
    return res.status(500).json({ error: 'Server error' });
  }
});

/**
 * POST /admin/roles/delete
 * Body: { id, client_id }
 * Mirrors FE fall-back call pattern.
 */
router.post('/admin/roles/delete', requireAuth, async (req, res) => {
  try {
    const roleId = req.body?.id;
    const clientId = req.body?.client_id;

    if (!roleId || !clientId) {
      return res.status(400).json({ error: 'Missing id or client_id' });
    }

    const { data, error } = await supabase
      .from('roles')
      .delete()
      .eq('id', roleId)
      .eq('client_id', clientId)
      .select('id')
      .maybeSingle();

    if (error) {
      console.error('[POST /admin/roles/delete] supabase error', error);
      return res.status(500).json({ error: 'Failed to delete role' });
    }
    if (!data) return res.status(404).json({ error: 'Not found' });

    return res.json({ ok: true, id: data.id });
  } catch (e) {
    console.error('[POST /admin/roles/delete] unexpected', e);
    return res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
