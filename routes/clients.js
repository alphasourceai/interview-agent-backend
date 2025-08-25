// routes/clients.js
const express = require('express');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const router = express.Router();
router.use(express.json());

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

const FRONTEND_URL = (process.env.FRONTEND_URL || '').replace(/\/+$/, '');

// Ensure downstream sees req.client_memberships[]
function ensureScope(req, _res, next) {
  if (!Array.isArray(req.client_memberships)) {
    const ids = Array.isArray(req.memberships) ? req.memberships.map(m => m.client_id) : (req.clientIds || []);
    req.client_memberships = ids;
  }
  next();
}

// ---------- GET /clients/my ----------
router.get('/my', ensureScope, async (req, res) => {
  try {
    const uid = req.user?.id;
    if (!uid) return res.status(401).json({ error: 'Unauthorized' });

    const { data: rows, error } = await supabase
      .from('client_members')
      .select('client_id, role, clients:clients(id, name)')
      .eq('user_id', uid)
      .order('created_at', { ascending: false });

    if (error) return res.status(400).json({ error: error.message });

    const clients = (rows || []).map(r => ({
      id: r.clients?.id || r.client_id,
      name: r.clients?.name || r.client_id,
      role: r.role || 'member',
    }));

    res.json({ clients });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------- GET /clients/members?client_id=... ----------
router.get('/members', ensureScope, async (req, res) => {
  try {
    const cid = req.query.client_id;
    if (!cid) return res.status(400).json({ error: 'client_id required' });
    if (!req.client_memberships.includes(cid)) return res.status(403).json({ error: 'No client scope' });

    const { data: rows, error } = await supabase
      .from('client_members')
      .select('user_id, role, name')
      .eq('client_id', cid)
      .order('created_at', { ascending: true });

    if (error) return res.status(400).json({ error: error.message });

    // Enrich with auth user email (service role)
    const members = [];
    for (const row of rows || []) {
      let email = null;
      if (row.user_id) {
        try {
          const u = await supabase.auth.admin.getUserById(row.user_id);
          email = u.data?.user?.email || null;
        } catch (_) {}
      }
      members.push({ user_id: row.user_id, role: row.role, name: row.name || null, email });
    }

    res.json({ members });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Optional alt path
router.get('/:id/members', ensureScope, async (req, res, next) => {
  req.url = `/members?client_id=${encodeURIComponent(req.params.id)}`;
  next();
}, router);

// ---------- POST /clients/invite ----------
// body: { client_id, email, name?, role? }
router.post('/invite', ensureScope, async (req, res) => {
  try {
    const { client_id, email, name, role } = req.body || {};
    if (!client_id || !email) return res.status(400).json({ error: 'client_id and email required' });
    if (!req.client_memberships.includes(client_id)) return res.status(403).json({ error: 'No client scope' });

    const token = crypto.randomBytes(24).toString('hex');
    const expires_at = new Date(Date.now() + 1000 * 60 * 60 * 24 * 7).toISOString(); // 7 days

    const { error } = await supabase
      .from('client_invites')
      .insert({
        client_id,
        email: email.toLowerCase(),
        role: role || 'member',
        token,
        expires_at,
        name: name || null, // column you added
      });

    if (error) return res.status(400).json({ error: error.message });

    const accept_url = `${FRONTEND_URL}/accept-invite?token=${encodeURIComponent(token)}`;
    res.json({ ok: true, accept_url });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------- POST /clients/accept-invite ----------
// body: { token }
router.post('/accept-invite', ensureScope, async (req, res) => {
  try {
    const uid = req.user?.id;
    const { token } = req.body || {};
    if (!uid) return res.status(401).json({ error: 'Unauthorized' });
    if (!token) return res.status(400).json({ error: 'token required' });

    const { data: invite, error } = await supabase
      .from('client_invites')
      .select('id, client_id, email, role, name, expires_at, accepted_at')
      .eq('token', token)
      .single();

    if (error || !invite) return res.status(400).json({ error: 'invalid token' });
    if (invite.accepted_at) return res.json({ ok: true, alreadyAccepted: true });
    if (new Date(invite.expires_at) < new Date()) return res.status(400).json({ error: 'expired' });

    const { error: upErr } = await supabase
      .from('client_members')
      .upsert({
        client_id: invite.client_id,
        user_id: uid,
        role: invite.role || 'member',
        name: invite.name || null,
      }, { onConflict: 'client_id,user_id' });

    if (upErr) return res.status(400).json({ error: upErr.message });

    await supabase
      .from('client_invites')
      .update({ accepted_at: new Date().toISOString() })
      .eq('id', invite.id);

    res.json({ ok: true, client_id: invite.client_id, role: invite.role, name: invite.name || null });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------- POST /clients/members/revoke ----------
// body: { client_id, user_id }
router.post('/members/revoke', ensureScope, async (req, res) => {
  try {
    const { client_id, user_id } = req.body || {};
    if (!client_id || !user_id) return res.status(400).json({ error: 'client_id and user_id required' });
    if (!req.client_memberships.includes(client_id)) return res.status(403).json({ error: 'No client scope' });

    const { error } = await supabase
      .from('client_members')
      .delete()
      .eq('client_id', client_id)
      .eq('user_id', user_id);

    if (error) return res.status(400).json({ error: error.message });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
