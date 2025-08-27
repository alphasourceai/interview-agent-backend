// routes/roles.js
// Factory router. ctx is provided by app.js: { supabase, auth, withClientScope, buckets }

const express = require('express');

module.exports = function makeRolesRouter({ supabase, auth, withClientScope }) {
  const router = express.Router();

  // GET /roles?client_id=...
  // Returns a list of roles for the specified (or scoped) client.
  router.get('/', auth, withClientScope, async (req, res) => {
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

  // POST /roles  { title, description, jd_text }
  // Minimal create; accepts JSON or FormData (when going through api.post it’s JSON).
  router.post('/', auth, withClientScope, async (req, res) => {
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

  return router;
};
