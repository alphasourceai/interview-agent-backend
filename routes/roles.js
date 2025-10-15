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
      req.query.client_id ||
      req.client?.id ||
      req.clientScope?.defaultClientId ||
      null;

    if (!clientId) return res.json({ roles: [] });

    const { data, error } = await supabase
      .from('roles')
      .select('*')
      .eq('client_id', clientId)
      .order('created_at', { ascending: false });

    if (error) {
      console.error('[GET /roles] supabase error', error);
      return res.status(500).json({ error: 'Failed to fetch roles' });
    }

    return res.json({ roles: data || [] });
  } catch (e) {
    console.error('[GET /roles] unexpected', e);
    return res.status(500).json({ error: 'Server error' });
  }
});

/**
 * POST /roles
 * Body: { title, description, jd_text, client_id? }
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
      jd_text: req.body.jd_text || null,
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
