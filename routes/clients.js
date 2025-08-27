// routes/clients.js
const router = require('express').Router();
const { requireAuth, withClientScope, supabase } = require('../middleware/auth');

// GET /clients/my  → list memberships and return the selected client
router.get('/my', requireAuth, withClientScope, async (req, res) => {
  const userId = req.user.id;

  // Try user_id_uuid first
  let { data, error } = await supabase
    .from('client_members')
    .select('client_id, role, user_id_uuid, clients ( id, name )')
    .eq('user_id_uuid', userId);

  // Fallback to user_id if needed
  if (error && error.code === '42703') {
    const retry = await supabase
      .from('client_members')
      .select('client_id, role, user_id, clients ( id, name )')
      .eq('user_id', userId);
    data = retry.data;
    error = retry.error;
  }

  if (error) return res.status(500).json({ error: 'Failed to load clients for user' });

  const list = (data || []).map(r => ({
    client_id: r.clients?.id || r.client_id,
    name: r.clients?.name || null,
    role: r.role || 'member',
  }));

  const primary = list.find(c => c.client_id === req.client?.id) || list[0] || null;

  res.json({ client: primary, membership: req.membership || null, clients: list });
});

// Mirror FE “who am I” call
router.get('/auth/me', requireAuth, (req, res) => {
  res.json({ user: { id: req.user.id, email: req.user.email || null } });
});

module.exports = router;
