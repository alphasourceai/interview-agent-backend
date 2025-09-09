// routes/candidates.js
const express = require('express');
const router = express.Router();

const { requireAuth, withClientScope } = require('../src/middleware/auth');
const { supabase } = require('../src/lib/supabaseClient');

// Keep FE flexible for now
const CANDIDATE_SELECT = '*';

// GET /candidates?role_id=... OR /candidates?client_id=...
router.get('/', requireAuth, withClientScope, async (req, res) => {
  try {
    const roleId = req.query.role_id || null;
    const clientId =
      req.query.client_id ||
      req.client?.id ||
      req.clientScope?.defaultClientId ||
      null;

    if (!roleId && !clientId) return res.json({ candidates: [] });

    let query = supabase.from('candidates').select(CANDIDATE_SELECT);
    if (roleId)   query = query.eq('role_id', roleId);
    if (clientId) query = query.eq('client_id', clientId);
    query = query.order('created_at', { ascending: false });

    const { data, error } = await query;
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

// GET /candidates/by-role/:roleId
router.get('/by-role/:roleId', requireAuth, withClientScope, async (req, res) => {
  try {
    const roleId = req.params.roleId;
    if (!roleId) return res.json({ candidates: [] });

    const { data, error } = await supabase
      .from('candidates')
      .select(CANDIDATE_SELECT)
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

module.exports = router;
