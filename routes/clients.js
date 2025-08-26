// routes/clients.js
'use strict';

const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');
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
const SENDER_EMAIL = process.env.SENDGRID_FROM || process.env.SENDER_EMAIL;

if (process.env.SENDGRID_API_KEY) {
  sgMail.setApiKey(process.env.SENDGRID_API_KEY);
}

function mustBeInScope(req, client_id) {
  const scope = req.clientIds || [];
  return scope.includes(client_id);
}

async function getUserEmail(uid) {
  // Admin API to fetch email for a user_id
  const { data, error } = await supabaseAdmin.auth.admin.getUserById(uid);
  if (error) return null;
  return data?.user?.email || null;
}

// GET /clients/mine  -> [{id, name, email, role}]
router.get('/mine', async (req, res) => {
  try {
    const uid = req.user?.id;
    if (!uid) return res.status(401).json({ error: 'Unauthorized' });

    const { data, error } = await supabaseAdmin
      .from('client_members')
      .select('client_id, role')
      .eq('user_id', uid);

    if (error) return res.status(400).json({ error: error.message });

    const clientIds = (data || []).map(r => r.client_id);
    if (clientIds.length === 0) return res.json({ items: [] });

    const { data: clients, error: e2 } = await supabaseAdmin
      .from('clients')
      .select('id, name, email')
      .in('id', clientIds)
      .order('created_at', { ascending: false });

    if (e2) return res.status(400).json({ error: e2.message });

    // attach role
    const roleByClient = Object.fromEntries((data || []).map(r => [r.client_id, r.role]));
    const items = (clients || []).map(c => ({
      id: c.id,
      name: c.name || c.id,
      email: c.email || null,
      role: roleByClient[c.id] || 'member',
    }));

    res.json({ items });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /clients/members?client_id=...
// Returns accepted members (with email + name + role) and pending invites.
router.get('/members', async (req, res) => {
  try {
    const client_id = req.query.client_id;
    if (!client_id) return res.status(400).json({ error: 'Missing client_id' });
    if (!mustBeInScope(req, client_id)) return res.status(403).json({ error: 'Forbidden' });

    // accepted members
    const { data: membersRows, error: mErr } = await supabaseAdmin
      .from('client_members')
      .select('client_id, user_id, role, name')
      .eq('client_id', client_id);
    if (mErr) return res.status(400).json({ error: mErr.message });

    // hydrate emails via Admin API
    const members = [];
    for (const r of membersRows || []) {
      const email = await getUserEmail(r.user_id);
      members.push({
        user_id: r.user_id,
        email: email || 'unknown',
        role: r.role || 'member',
        name: r.name || null,
        pending: false,
      });
    }

    // pending invites (not yet accepted)
    const { data: invitesRows, error: iErr } = await supabaseAdmin
      .from('client_invites')
      .select('email, role, name, accepted_at, expires_at')
      .eq('client_id', client_id)
      .is('accepted_at', null);
    if (iErr) return res.status(400).json({ error: iErr.message });

    const invites = (invitesRows || []).map(r => ({
      user_id: null,
      email: r.email,
      role: r.role || 'member',
      name: r.name || null,
      pending: true,
      expires_at: r.expires_at || null,
    }));

    res.json({ members, invites });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /clients/invite  { client_id, email, role, name }
router.post('/invite', async (req, res) => {
  try {
    const { client_id, email, role = 'member', name = null } = req.body || {};
    if (!client_id || !email) return res.status(400).json({ error: 'Missing client_id or email' });
    if (!mustBeInScope(req, client_id)) return res.status(403).json({ error: 'Forbidden' });

    const token = crypto.randomUUID();
    const expires_at = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString();

    const { error } = await supabaseAdmin.from('client_invites').insert({
      client_id,
      email,
      role,
      token,
      expires_at,
      name,
    });
    if (error) return res.status(400).json({ error: error.message });

    if (process.env.SENDGRID_API_KEY && SENDER_EMAIL && FRONTEND_URL) {
      const link = `${FRONTEND_URL.replace(/\/+$/, '')}/accept-invite?token=${encodeURIComponent(token)}`;
      try {
        await sgMail.send({
          to: email,
          from: SENDER_EMAIL,
          subject: 'You’ve been invited to Interview Agent',
          text: `Hello${name ? ` ${name}` : ''},\n\nYou’ve been invited to join the client workspace.\n\nAccept your invite: ${link}\n\nThis link expires in 7 days.`,
          html: `
            <p>Hello${name ? ` ${name}` : ''},</p>
            <p>You’ve been invited to join the client workspace.</p>
            <p><a href="${link}">Accept your invite</a></p>
            <p>This link expires in 7 days.</p>
          `,
        });
      } catch (e) {
        // email failure shouldn't block the API; surface as warning
        console.warn('[sendgrid] failed:', e.message);
      }
    }

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /clients/accept-invite  { token }
router.post('/accept-invite', async (req, res) => {
  try {
    const uid = req.user?.id;
    const token = (req.body && req.body.token) || null;
    if (!uid) return res.status(401).json({ error: 'Unauthorized' });
    if (!token) return res.status(400).json({ error: 'Missing token' });

    const { data: invite, error } = await supabaseAdmin
      .from('client_invites')
      .select('id, client_id, email, role, token, expires_at, accepted_at, name')
      .eq('token', token)
      .maybeSingle();

    if (error) return res.status(400).json({ error: error.message });
    if (!invite) return res.status(400).json({ error: 'Invalid token' });
    if (invite.accepted_at) return res.status(400).json({ error: 'Already accepted' });
    if (invite.expires_at && new Date(invite.expires_at).getTime() < Date.now()) {
      return res.status(400).json({ error: 'Invite expired' });
    }

    // If user is already a member, keep existing OWNER
    const { data: existing, error: exErr } = await supabaseAdmin
      .from('client_members')
      .select('client_id, user_id, role, name')
      .eq('client_id', invite.client_id)
      .eq('user_id', uid)
      .maybeSingle();
    if (exErr) return res.status(400).json({ error: exErr.message });

    if (existing?.role === 'owner') {
      // preserve owner; just update name if provided
      if (invite.name && invite.name !== existing.name) {
        await supabaseAdmin
          .from('client_members')
          .update({ name: invite.name })
          .eq('client_id', invite.client_id)
          .eq('user_id', uid);
      }
    } else {
      // upsert as invited role
      const { error: upErr } = await supabaseAdmin
        .from('client_members')
        .upsert(
          { client_id: invite.client_id, user_id: uid, role: invite.role || 'member', name: invite.name || null },
          { onConflict: 'client_id,user_id' }
        );
      if (upErr) return res.status(400).json({ error: upErr.message });
    }

    // mark accepted
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

// POST /clients/members/revoke  { client_id, user_id }
router.post('/members/revoke', async (req, res) => {
  try {
    const { client_id, user_id } = req.body || {};
    if (!client_id || !user_id) return res.status(400).json({ error: 'Missing client_id or user_id' });
    if (!mustBeInScope(req, client_id)) return res.status(403).json({ error: 'Forbidden' });

    // prevent self-revoking an owner (safety)
    const { data: row, error } = await supabaseAdmin
      .from('client_members')
      .select('role')
      .eq('client_id', client_id)
      .eq('user_id', user_id)
      .maybeSingle();
    if (error) return res.status(400).json({ error: error.message });
    if (row?.role === 'owner') {
      return res.status(400).json({ error: 'Cannot revoke an owner' });
    }

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
