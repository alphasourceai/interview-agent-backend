// routes/clients.js
'use strict';

const express = require('express');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const sgMail = require('@sendgrid/mail');

const router = express.Router();

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
}
const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const FRONTEND_URL = (process.env.FRONTEND_URL || '').replace(/\/+$/, '');
const FROM_EMAIL = process.env.SENDGRID_FROM || process.env.SENDER_EMAIL || null;

if (process.env.SENDGRID_API_KEY) {
  try { sgMail.setApiKey(process.env.SENDGRID_API_KEY); } catch {}
}

function inScope(req, client_id) {
  const scope = req.clientIds || [];
  return scope.includes(client_id);
}

async function getUserEmail(uid) {
  try {
    const u = await supabaseAdmin.auth.admin.getUserById(uid);
    return u.data?.user?.email || null;
  } catch {
    return null;
  }
}

/* ---------- GET /clients/my (FE expects this) ---------- */
router.get('/my', async (req, res) => {
  try {
    const uid = req.user?.id;
    if (!uid) return res.status(401).json({ error: 'Unauthorized' });

    const { data: mem, error } = await supabaseAdmin
      .from('client_members')
      .select('client_id, role')
      .eq('user_id', uid);
    if (error) return res.status(400).json({ error: error.message });

    const clientIds = (mem || []).map(r => r.client_id);
    if (clientIds.length === 0) return res.json({ clients: [] });

    const { data: clients, error: e2 } = await supabaseAdmin
      .from('clients')
      .select('id, name')
      .in('id', clientIds);
    if (e2) return res.status(400).json({ error: e2.message });

    const roleById = Object.fromEntries((mem || []).map(r => [r.client_id, r.role || 'member']));
    const clientsOut = (clients || []).map(c => ({
      id: c.id,
      name: c.name || c.id,
      role: roleById[c.id] || 'member',
    }));

    res.json({ clients: clientsOut });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ---------- GET /clients/mine (alias; returns items[]) ---------- */
router.get('/mine', async (req, res) => {
  try {
    const uid = req.user?.id;
    if (!uid) return res.status(401).json({ error: 'Unauthorized' });

    const { data: mem, error } = await supabaseAdmin
      .from('client_members')
      .select('client_id, role')
      .eq('user_id', uid);
    if (error) return res.status(400).json({ error: error.message });

    const clientIds = (mem || []).map(r => r.client_id);
    if (clientIds.length === 0) return res.json({ items: [] });

    const { data: clients, error: e2 } = await supabaseAdmin
      .from('clients')
      .select('id, name')
      .in('id', clientIds);
    if (e2) return res.status(400).json({ error: e2.message });

    const roleById = Object.fromEntries((mem || []).map(r => [r.client_id, r.role || 'member']));
    const items = (clients || []).map(c => ({
      id: c.id,
      name: c.name || c.id,
      role: roleById[c.id] || 'member',
    }));

    res.json({ items });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ---------- GET /clients/members?client_id=... ---------- */
router.get('/members', async (req, res) => {
  try {
    const client_id = req.query.client_id;
    if (!client_id) return res.status(400).json({ error: 'Missing client_id' });
    if (!inScope(req, client_id)) return res.status(403).json({ error: 'Forbidden' });

    const { data: rows, error } = await supabaseAdmin
      .from('client_members')
      .select('user_id, role, name')
      .eq('client_id', client_id);
    if (error) return res.status(400).json({ error: error.message });

    const members = [];
    for (const r of rows || []) {
      const email = await getUserEmail(r.user_id);
      members.push({
        user_id: r.user_id,
        email: email || 'unknown',
        role: r.role || 'member',
        name: r.name || null,
        pending: false,
      });
    }

    const { data: invites, error: iErr } = await supabaseAdmin
      .from('client_invites')
      .select('email, role, name, accepted_at, expires_at')
      .eq('client_id', client_id)
      .is('accepted_at', null);
    if (iErr) return res.status(400).json({ error: iErr.message });

    const pending = (invites || []).map(i => ({
      user_id: null,
      email: i.email,
      role: i.role || 'member',
      name: i.name || null,
      pending: true,
      expires_at: i.expires_at || null,
    }));

    res.json({ members, invites: pending });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ---------- POST /clients/invite { client_id, email, role?, name? } ---------- */
router.post('/invite', async (req, res) => {
  try {
    const { client_id, email, role = 'member', name = null } = req.body || {};
    if (!client_id || !email) return res.status(400).json({ error: 'Missing client_id or email' });
    if (!inScope(req, client_id)) return res.status(403).json({ error: 'Forbidden' });

    const token = crypto.randomUUID();
    const expires_at = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString();

    const { error } = await supabaseAdmin.from('client_invites').insert({
      client_id, email, role, token, expires_at, name,
    });
    if (error) return res.status(400).json({ error: error.message });

    if (process.env.SENDGRID_API_KEY && FROM_EMAIL && FRONTEND_URL) {
      const accept = `${FRONTEND_URL}/accept-invite?token=${encodeURIComponent(token)}`;
      try {
        await sgMail.send({
          to: email,
          from: FROM_EMAIL,
          subject: 'You’ve been invited to Interview Agent',
          html: `<p>Hello${name ? ' ' + name : ''},</p>
                 <p>You’ve been invited to join the client workspace.</p>
                 <p><a href="${accept}">Accept your invite</a></p>
                 <p>This link expires in 7 days.</p>`,
        });
      } catch (e) {
        console.warn('[sendgrid] failed:', e.message);
      }
    }

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ---------- POST /clients/accept-invite { token } ---------- */
router.post('/accept-invite', async (req, res) => {
  try {
    const uid = req.user?.id;
    const userEmail = (req.user?.email || '').toLowerCase();
    const { token } = req.body || {};
    if (!uid) return res.status(401).json({ error: 'Unauthorized' });
    if (!token) return res.status(400).json({ error: 'Missing token' });

    const { data: invite, error } = await supabaseAdmin
      .from('client_invites')
      .select('id, client_id, email, role, name, expires_at, accepted_at')
      .eq('token', token)
      .maybeSingle();
    if (error) return res.status(400).json({ error: error.message });
    if (!invite) return res.status(400).json({ error: 'Invalid token' });
    if (invite.accepted_at) return res.status(400).json({ error: 'Already accepted' });
    if (invite.expires_at && new Date(invite.expires_at).getTime() < Date.now()) {
      return res.status(400).json({ error: 'Invite expired' });
    }

    // Require the signed-in user to match the invited email
    if ((invite.email || '').toLowerCase() !== userEmail) {
      return res.status(403).json({
        error: 'email_mismatch',
        message: `Signed in as ${userEmail || '(unknown)'} but invite is for ${invite.email}. Sign in with the invited address.`,
      });
    }

    // Preserve existing OWNER role if present
    const { data: existing } = await supabaseAdmin
      .from('client_members')
      .select('role, name')
      .eq('client_id', invite.client_id)
      .eq('user_id', uid)
      .maybeSingle();

    if (existing?.role === 'owner') {
      if (invite.name && invite.name !== existing.name) {
        await supabaseAdmin
          .from('client_members')
          .update({ name: invite.name })
          .eq('client_id', invite.client_id)
          .eq('user_id', uid);
      }
    } else {
      const { error: upErr } = await supabaseAdmin
        .from('client_members')
        .upsert(
          { client_id: invite.client_id, user_id: uid, role: invite.role || 'member', name: invite.name || null },
          { onConflict: 'client_id,user_id' }
        );
      if (upErr) return res.status(400).json({ error: upErr.message });
    }

    // Mark invite accepted
    const { error: accErr } = await supabaseAdmin
      .from('client_invites')
      .update({ accepted_at: new Date().toISOString() })
      .eq('id', invite.id);
    if (accErr) return res.status(400).json({ error: accErr.message });

    res.json({ ok: true, client_id: invite.client_id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ---------- POST /clients/members/revoke ---------- */
router.post('/members/revoke', async (req, res) => {
  try {
    const { client_id, user_id } = req.body || {};
    if (!client_id || !user_id) return res.status(400).json({ error: 'Missing client_id or user_id' });
    if (!inScope(req, client_id)) return res.status(403).json({ error: 'Forbidden' });

    // Do not allow revoking an owner
    const { data: row, error } = await supabaseAdmin
      .from('client_members')
      .select('role')
      .eq('client_id', client_id)
      .eq('user_id', user_id)
      .maybeSingle();
    if (error) return res.status(400).json({ error: error.message });
    if (row?.role === 'owner') return res.status(400).json({ error: 'Cannot revoke an owner' });

    const { error: delErr } = await supabaseAdmin
      .from('client_members')
      .delete()
      .eq('client_id', client_id)
      .eq('user_id', user_id);
    if (delErr) return res.status(400).json({ error: delErr.message });

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
