// routes/clients.js
const express = require('express');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const { sendInvite } = require('../utils/mailer');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
}
const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const FRONTEND_URL = (process.env.FRONTEND_URL || '').replace(/\/+$/, '');

const router = express.Router();
router.use(express.json());

// Ensure request has client scope prepared by app.js
function requireScope(req, res, next) {
  if (!Array.isArray(req.client_memberships)) {
    return res.status(403).json({ error: 'No client scope' });
  }
  next();
}

// ---------- GET /clients/my ----------
router.get('/my', async (req, res) => {
  try {
    const uid = req.user?.id;
    if (!uid) return res.status(401).json({ error: 'Unauthorized' });

    // join to clients to return NAME so the FE doesn’t have to enrich
    const { data: rows, error } = await supabaseAdmin
      .from('client_members')
      .select('client_id, role, clients!inner(name)')
      .eq('user_id', uid)
      .order('client_id', { ascending: true });

    if (error) return res.status(400).json({ error: error.message });

    const clients = (rows || []).map(r => ({
      client_id: r.client_id,
      client_name: r.clients?.name || null,
      role: r.role,
    }));

    res.json({ clients });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------- POST /clients/invite { client_id, email, name?, role? } ----------
router.post('/invite', requireScope, async (req, res) => {
  try {
    const { client_id, email, name, role } = req.body || {};
    if (!client_id || !email) {
      return res.status(400).json({ error: 'client_id and email are required' });
    }
    if (!req.client_memberships.includes(client_id)) {
      return res.status(403).json({ error: 'Forbidden for this client' });
    }

    const token = crypto.randomBytes(24).toString('hex');
    const { data: invite, error } = await supabaseAdmin
      .from('client_invites')
      .insert({
        client_id,
        email,
        name: name || null,                 // <-- store name on invite
        role: role || 'member',
        token,
        invited_by: req.user?.id || null,
        accepted_at: null,
      })
      .select('*')
      .single();
    if (error) return res.status(400).json({ error: error.message });

    const accept_url = `${FRONTEND_URL}/accept-invite?token=${encodeURIComponent(token)}`;
    try {
      await sendInvite(email, accept_url, req.user?.email || '');
    } catch (mailErr) {
      console.warn('[clients/invite] email send failed:', mailErr?.message);
      // don’t fail the request just because the email failed
    }

    res.json({ ok: true, accept_url, invite });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------- POST /clients/accept-invite { token } ----------
router.post('/accept-invite', async (req, res) => {
  try {
    const uid = req.user?.id;
    if (!uid) return res.status(401).json({ error: 'Unauthorized' });

    const { token } = req.body || {};
    if (!token) return res.status(400).json({ error: 'token required' });

    const { data: inv, error: invErr } = await supabaseAdmin
      .from('client_invites')
      .select('*')
      .eq('token', token)
      .is('accepted_at', null)
      .maybeSingle();
    if (invErr) return res.status(400).json({ error: invErr.message });
    if (!inv) return res.status(404).json({ error: 'Invite not found or already accepted' });

    // Upsert membership and carry forward NAME from invite if present
    const { error: memErr } = await supabaseAdmin
      .from('client_members')
      .upsert(
        {
          client_id: inv.client_id,
          user_id: uid,
          role: inv.role || 'member',
          name: inv.name || null,         // <-- carry over name
        },
        { onConflict: 'client_id,user_id' }
      );
    if (memErr) return res.status(400).json({ error: memErr.message });

    const { error: updErr } = await supabaseAdmin
      .from('client_invites')
      .update({ accepted_at: new Date().toISOString() })
      .eq('token', token);
    if (updErr) return res.status(400).json({ error: updErr.message });

    res.json({ ok: true, client_id: inv.client_id, role: inv.role || 'member' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------- GET /clients/members?client_id=... ----------
router.get('/members', requireScope, async (req, res) => {
  try {
    const cid = req.query.client_id;
    if (!cid) return res.status(400).json({ error: 'client_id required' });
    if (!req.client_memberships.includes(cid)) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    // Read members (include NAME from client_members)
    const { data: rows, error } = await supabaseAdmin
      .from('client_members')
      .select('user_id, role, name')
      .eq('client_id', cid);
    if (error) return res.status(400).json({ error: error.message });

    // Fetch emails via auth.users (service role)
    const ids = (rows || []).map(r => r.user_id).filter(Boolean);
    let emailsById = {};
    if (ids.length) {
      const { data: users } = await supabaseAdmin.auth.admin.listUsers();
      for (const u of users?.users || []) {
        if (ids.includes(u.id)) emailsById[u.id] = u.email;
      }
    }

    const members = (rows || []).map(r => ({
      user_id: r.user_id,
      role: r.role || 'member',
      name: r.name || null,                          // <-- return name
      email: emailsById[r.user_id] || null,
    }));

    res.json({ members });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------- POST /clients/members/revoke { client_id, user_id } ----------
router.post('/members/revoke', requireScope, async (req, res) => {
  try {
    const { client_id, user_id } = req.body || {};
    if (!client_id || !user_id) {
      return res.status(400).json({ error: 'client_id and user_id are required' });
    }
    if (!req.client_memberships.includes(client_id)) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const { error } = await supabaseAdmin
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

// ---------- (Optional) GET /clients/invites?client_id=... ----------
router.get('/invites', requireScope, async (req, res) => {
  try {
    const cid = req.query.client_id;
    if (!cid) return res.status(400).json({ error: 'client_id required' });
    if (!req.client_memberships.includes(cid)) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const { data, error } = await supabaseAdmin
      .from('client_invites')
      .select('email, name, role, invited_by, token, expires_at, accepted_at')
      .eq('client_id', cid)
      .order('created_at', { ascending: false });

    if (error) return res.status(400).json({ error: error.message });
    res.json({ invites: data || [] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
