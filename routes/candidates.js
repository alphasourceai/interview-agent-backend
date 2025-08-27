// routes/candidates.js
// Factory router. ctx: { supabase, auth, withClientScope }
// Minimal endpoints to satisfy existing FE calls.

const express = require('express');

module.exports = function makeCandidatesRouter({ supabase, auth, withClientScope }) {
  const router = express.Router();

  // GET /candidates?role_id=...  OR  /candidates?client_id=...
  router.get('/', auth, withClientScope, async (req, res) => {
    try {
      const roleId = req.query.role_id || null;
      const clientId =
        req.query.client_id ||
        req.client?.id ||
        req.clientScope?.defaultClientId ||
        null;

      let query = supabase.from('candidates').select('*');

      if (roleId) query = query.eq('role_id', roleId);
      if (!roleId && clientId) query = query.eq('client_id', clientId);

      const { data, error } = await query.order('created_at', { ascending: false });

      if (error) {
        console.error('[GET /candidates] supabase error', error);
        return res.status(500).json({ error: 'Failed to fetch candidates' });
      }

      return res.json({ candidates: data || [] });
    } catch (e) {
      console.error('[GET /candidates] unexpected', e);
      return res.status(500).json({ error: 'Server error' });
    }
  });

  // (Optional) GET /candidates/by-role/:roleId
  router.get('/by-role/:roleId', auth, async (req, res) => {
    try {
      const roleId = req.params.roleId;
      if (!roleId) return res.status(400).json({ error: 'roleId required' });

      const { data, error } = await supabase
        .from('candidates')
        .select('*')
        .eq('role_id', roleId)
        .order('created_at', { ascending: false });

      if (error) {
        console.error('[GET /candidates/by-role/:roleId] supabase error', error);
        return res.status(500).json({ error: 'Failed to fetch candidates' });
      }

      return res.json({ candidates: data || [] });
    } catch (e) {
      console.error('[GET /candidates/by-role/:roleId] unexpected', e);
      return res.status(500).json({ error: 'Server error' });
    }
  });

  return router;
};
