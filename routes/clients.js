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

      // Get memberships for this user (new column first, then legacy)
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

  // -----------------------------------------------------------------------
  // GET /clients/members?client_id=...
  // Returns { members: [{id, email, name, role}] }
  // Tolerates schema drift (user_id_uuid vs user_id). If lookup fails,
  // gracefully returns an empty list instead of 404.
  // -----------------------------------------------------------------------
  router.get('/members', auth, async (req, res) => {
    try {
      const clientId = req.query.client_id;
      if (!clientId) return res.status(400).json({ error: 'client_id is required' });

      // Try to select membership rows and join client/users if available.
      // Keep selection simple to avoid brittle joins across envs.
      let { data, error } = await supabase
        .from('client_members')
        .select('id, client_id, role, invited_email, user_id_uuid');

      if (error && error.code === '42703') {
        // Legacy column fallback
        const retry = await supabase
          .from('client_members')
          .select('id, client_id, role, invited_email, user_id');
        data = retry.data;
        error = retry.error;
      }
      if (error) {
        console.error('[clients/members] select error', error);
        return res.json({ members: [] });
      }

      const rows = (data || []).filter(r => r.client_id === clientId);

      // Optionally look up emails for linked users if we have a user id column.
      // We’ll try a tolerant approach: if we can't resolve emails, we still respond.
      let members = rows.map(r => ({
        id: r.id,
        role: r.role || 'member',
        email: r.invited_email || null,
        name: null,
      }));

      // If there’s no invited_email, try to pull email from auth users or profiles
      const needLookup = rows
        .filter(r => !r.invited_email && (r.user_id_uuid || r.user_id))
        .map(r => r.user_id_uuid || r.user_id);

      // Best-effort: try profiles table first, then auth.users via RPC if you have one.
      if (needLookup.length) {
        try {
          // profiles table (if present)
          const { data: profiles } = await supabase
            .from('profiles')
            .select('id, email, full_name')
            .in('id', needLookup);

          const pMap = new Map((profiles || []).map(p => [p.id, p]));
          members = members.map((m, idx) => {
            const row = rows[idx];
            const pid = row.user_id_uuid || row.user_id;
            const p = pid ? pMap.get(pid) : null;
            return p
              ? { ...m, email: m.email || p.email || null, name: p.full_name || null }
              : m;
          });
        } catch (e2) {
          // If this fails, we just keep members as-is
          console.warn('[clients/members] profile lookup skipped', e2.message);
        }
      }

      return res.json({ members });
    } catch (e) {
      console.error('[GET /clients/members] unexpected', e);
      return res.json({ members: [] }); // Never 404; FE expects JSON
    }
  });

  return router;
};
