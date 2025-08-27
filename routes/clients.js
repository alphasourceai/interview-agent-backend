// routes/clients.js
// Factory-style router. Do NOT require middleware or supabase here;
// app.js will pass them in the ctx argument.

const express = require('express');

module.exports = function makeClientsRouter({ supabase, auth, withClientScope }) {
  const router = express.Router();

  // GET /clients/my
  // Returns: { client, clients, membership }
  router.get('/my', auth, withClientScope, async (req, res) => {
    try {
      const userId = req.user?.id;
      if (!userId) return res.status(401).json({ error: 'Unauthorized' });

      // Fetch all memberships for this user.
      // Try modern column first; fall back to legacy column if needed.
      let { data, error } = await supabase
        .from('client_members')
        .select('client_id, role, user_id_uuid, clients ( id, name )')
        .eq('user_id_uuid', userId);

      if (error && error.code === '42703') {
        const retry = await supabase
          .from('client_members')
          .select('client_id, role, user_id, clients ( id, name )')
          .eq('user_id', userId);
        data = retry.data;
        error = retry.error;
      }

      if (error) return res.status(500).json({ error: 'Failed to load clients for user' });

      const clients = (data || []).map(r => ({
        client_id: r.clients?.id || r.client_id,
        name: r.clients?.name || null,
        role: r.role || 'member',
      }));

      // Prefer the client resolved by withClientScope if present, else first.
      const defaultId =
        req.client?.id ||
        req.clientScope?.defaultClientId ||
        (clients[0] && clients[0].client_id) ||
        null;

      const primary = clients.find(c => c.client_id === defaultId) || null;
      const membership = primary ? { role: primary.role } : null;

      return res.json({ client: primary, clients, membership });
    } catch (e) {
      console.error('[GET /clients/my] unexpected', e);
      return res.status(500).json({ error: 'Server error' });
    }
  });

  return router;
};
