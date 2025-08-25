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

// Optional mailer (won't crash if not present)
let sendInviteSafe = async () => {};
try {
  const { sendInvite } = require('../utils/mailer');
  if (typeof sendInvite === 'function') sendInviteSafe = sendInvite;
} catch (_) { /* noop */ }

// Utility: ensure req.client_memberships exists (app.js sets it)
function ensureScope(req, _res, next) {
  if (!Array.isArray(req.client_memberships)) req.client_memberships = [];
  next();
}

// ---------- GET /clients/my ----------
// Returns the current user's client memberships with client NAME
router.get('/my', async (req, res) => {
  try {
    const uid = req.user?.id;
    if (!uid) return res.status(401).json({ error: 'Unauthorized' });

    const { data, error } = await supabase
      .from('client_members')
      .select('client_id, role, clients!inner(name)')
      .eq('user_id', uid)
      .order('client_id', { ascending: true });

    if (error) return res.status(400).json({ error: error.message });

    const clients = (data || []).map(r => ({
      id: r.client_id,
      name: r.clients?.name || r.client_id,
      role: r.role || 'member',
    }));

    res.json({ clients });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------- GET /clients/members?client_id=... ----------
// Returns member list WITH name (from client_members.name) + emails
router.get('/members', ensureScope, async (req, res) => {
  try {
    const cid = req.query.client_id;
    if (!cid) return res.status(400).json({ error: 'client_id required' });
    if (!req.client_memberships.includes(cid)) return res.status(403).json({ error: 'No client scope' });

    const { data: rows, error } = await supabase
      .from('client_members')
      .select('user_id, role, name')
      .eq('client_id', cid);

    if (error) return res.status(400).json({ error: error.message });

    // enrich emails via admin list
    const { data: usersRes } = await supabase.auth.admin.listUsers();
    const emailById = {};
    for (const u of usersRes?.users || []) emailById[u.id] = u.email;

    const members = (rows || []).map(r => ({
      user_id: r.user_id,
      email: emailById[r.user_id] || null,
      role: r.role || 'member',
      name: r.name || null,
    }));

    res.json({ members });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------- POST /clients/invite { client_id, email, name?, role? } ----------
router.post('/invite', ensureScope, async (req, res) => {
  try {
    const { client_id, email, name, role } = req.body || {};
    if (!client_id || !email) return res.status(400).json({ error: 'client_id and email are required' });
    if (!req.client_memberships.includes(client_id)) return res.status(403).json({ error: 'No client scope' });

    const token = crypto.randomBytes(24).toString('hex');

    const { data: invite, error } = await supabase
      .from('client_invites')
      .insert({
        client_id,
        email,
        name: name || null,          // <-- store invited name
        role: role || 'member',
        token,
        invited_by: req.user?.id || null,
        accepted_at: null,
      })
      .select('*')
      .single();

    if (error) return res.status(400).json({ error: error.message });

    const acceptUrl = `${FRONTEND_URL}/accept-invite?token=${encodeURIComponent(token)}`;
    try { await sendInviteSafe(email, acceptUrl, req.user?.email || ''); } catch (_) {}

    res.json({ ok: true, invite, accept_url: acceptUrl });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------- POST /clients/accept-invite { token } ----------
// Carries invite.name into client_members.name
router.post('/accept-invite', async (req, res) => {
  try {
    const uid = req.user?.id;
    if (!uid) return res.status(401).json({ error: 'Unauthorized' });

    const { token } = req.body || {};
    if (!token) return res.status(400).json({ error: 'token required' });

    const { data: inv, error: invErr } = await supabase
      .from('client_invites')
      .select('*')
      .eq('token', token)
      .is('accepted_at', null)
      .maybeSingle();

    if (invErr) return res.status(400).json({ error: invErr.message });
    if (!inv) return res.status(404).json({ error: 'Invite not found or already accepted' });

    const { error: upErr } = await supabase
      .from('client_members')
      .upsert(
        {
          client_id: inv.client_id,
          user_id: uid,
          role: inv.role || 'member',
          name: inv.name || null,   // <-- carry invited name into membership
        },
        { onConflict: 'client_id,user_id' }
      );
    if (upErr) return res.status(400).json({ error: upErr.message });

    const { error: markErr } = await supabase
      .from('client_invites')
      .update({ accepted_at: new Date().toISOString() })
      .eq('token', token);
    if (markErr) return res.status(400).json({ error: markErr.message });

    res.json({ ok: true, client_id: inv.client_id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------- POST /clients/members/revoke { client_id, user_id } ----------
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
