// routes/clients.js
// Factory-style router; ctx is provided by app.js.
// ctx: { supabase, auth, withClientScope }

const express = require('express');

module.exports = function makeClientsRouter({ supabase, auth, withClientScope }) {
  const router = express.Router();

  // -----------------------------------------------------------------------
  // GET /clients/my
  // Returns { client, clients, membership }
  // -----------------------------------------------------------------------

router.get('/my', auth, withClientScope, async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    // Try new column, then legacy
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

    // Normalize to { id, name, role }
    const clients = (data || []).map(r => ({
      id: r.clients?.id || r.client_id,
      name: r.clients?.name || null,
      role: r.role || 'member',
    }));

    const hintedId =
      req.client?.id ||
      req.clientScope?.defaultClientId ||
      null;

    const primary =
      clients.find(c => c.id === hintedId) ||
      clients[0] ||
      null;

    const membership = primary ? { role: primary.role } : null;

    return res.json({ client: primary, clients, membership });
  } catch (e) {
    console.error('[GET /clients/my] unexpected', e);
    return res.status(500).json({ error: 'Server error' });
  }
});


  // -----------------------------------------------------------------------
  // GET /clients/members?client_id=...
  // Only accepted members (from client_members). No pending invites here.
  // Schema-safe: client_members has no 'id' column in prod.
  // -----------------------------------------------------------------------
  router.get('/members', auth, async (req, res) => {
    try {
      const clientId = req.query.client_id;
      if (!clientId) return res.status(400).json({ error: 'client_id is required' });

      // 1) Current members (there is no numeric 'id' column here)
      const { data: rows, error } = await supabase
        .from('client_members')
        .select('client_id, user_id, role, name')
        .eq('client_id', clientId);

      if (error) {
        console.error('[clients/members] select error', error);
        return res.json({ members: [] }); // do not crash UI
      }

      // 2) Enrich with email/full_name via profiles
      const userIds = (rows || []).map(r => r.user_id).filter(Boolean);
      let profileMap = new Map();
      if (userIds.length) {
        const { data: profiles } = await supabase
          .from('profiles')
          .select('id, email, full_name')
          .in('id', userIds);
        if (profiles) profileMap = new Map(profiles.map(p => [p.id, { email: p.email, name: p.full_name }]));
      }

      // 3) Response shape (keep fields UI expects)
      const members = (rows || []).map(r => {
        const p = profileMap.get(r.user_id) || {};
        return {
          id: null,                     // table has no id column
          role: r.role || 'member',
          name: r.name || p.name || null,
          email: p.email || null,
          user_id: r.user_id,
        };
      });

      return res.json({ members });
    } catch (e) {
      console.error('[GET /clients/members] unexpected', e);
      return res.json({ members: [] });
    }
  });

  return router;
};
