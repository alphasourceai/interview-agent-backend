// routes/clients.js
const express = require('express');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const sgMail = require('@sendgrid/mail');

const router = express.Router();
router.use(express.json());

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

if (process.env.SENDGRID_API_KEY) sgMail.setApiKey(process.env.SENDGRID_API_KEY);

const FRONTEND_URL = (process.env.FRONTEND_URL || '').replace(/\/+$/, '');
const FROM_EMAIL = process.env.SENDGRID_FROM || process.env.SENDER_EMAIL;

function pick(row, keys) { for (const k of keys) if (k in row && row[k] != null) return row[k]; }
function ensureScope(req, _res, next) { if (!Array.isArray(req.client_memberships)) req.client_memberships = []; next(); }

// ---------- GET /clients/my ----------
router.get('/my', ensureScope, async (req, res) => {
  try {
    const uid = req.user?.id;
    if (!uid) return res.status(401).json({ error: 'Unauthorized' });

    const { data: rows, error } = await supabase.from('client_members').select('*');
    if (error) return res.status(400).json({ error: error.message });

    const mine = (rows || []).filter(r => pick(r, ['user_id', 'user_id_uuid']) === uid);
    const clientIds = mine.map(r => pick(r, ['client_id', 'client_id_uuid'])).filter(Boolean);

    const { data: clientsRows, error: cErr } = await supabase
      .from('clients')
      .select('id,name')
      .in('id', clientIds);
    if (cErr) return res.status(400).json({ error: cErr.message });

    const nameById = Object.fromEntries((clientsRows || []).map(c => [c.id, c.name]));
    const clients = clientIds.map(id => ({
      id,
      name: nameById[id] || id,
      role: (mine.find(m => pick(m, ['client_id', 'client_id_uuid']) === id)?.role) || 'member',
    }));

    res.json({ clients });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------- GET /clients/members?client_id=... ----------
router.get('/members', ensureScope, async (req, res) => {
  try {
    const cid = req.query.client_id;
    if (!cid) return res.status(400).json({ error: 'client_id required' });
    if (!req.client_memberships.includes(cid)) return res.status(403).json({ error: 'No client scope' });

    const { data: rows, error } = await supabase.from('client_members').select('*');
    if (error) return res.status(400).json({ error: error.message });

    const list = (rows || []).filter(r => pick(r, ['client_id', 'client_id_uuid']) === cid);

    const members = [];
    for (const r of list) {
      const userId = pick(r, ['user_id', 'user_id_uuid']);
      let email = null;
      if (userId) {
        try { const u = await supabase.auth.admin.getUserById(userId); email = u.data?.user?.email || null; } catch {}
      }
      members.push({ user_id: userId, role: r.role || 'member', name: r.name ?? r['Name'] ?? null, email });
    }
    res.json({ members });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------- POST /clients/invite ----------
router.post('/invite', ensureScope, async (req, res) => {
  try {
    const { client_id, email, name, role } = req.body || {};
    if (!client_id || !email) return res.status(400).json({ error: 'client_id and email required' });
    if (!req.client_memberships.includes(client_id)) return res.status(403).json({ error: 'No client scope' });

    const token = crypto.randomBytes(24).toString('hex');
    const expires_at = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString();

    const { error } = await supabase.from('client_invites').insert({
      client_id, email: email.toLowerCase(), role: role || 'member',
      token, expires_at, name: name || null,
    });
    if (error) return res.status(400).json({ error: error.message });

    const accept_url = `${FRONTEND_URL}/accept-invite?token=${encodeURIComponent(token)}`;

    if (FROM_EMAIL && process.env.SENDGRID_API_KEY) {
      try {
        await sgMail.send({
          to: email, from: FROM_EMAIL,
          subject: 'You’ve been invited to Interview Agent',
          html: `<p>Hello${name ? ' ' + name : ''},</p>
                 <p>You’ve been invited to join the client workspace.</p>
                 <p><a href="${accept_url}">${accept_url}</a></p>
                 <p>This link expires in 7 days.</p>`,
        });
      } catch (e) { console.error('SendGrid error:', e.message); }
    }
    res.json({ ok: true, accept_url, emailed: !!(FROM_EMAIL && process.env.SENDGRID_API_KEY) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------- POST /clients/accept-invite ----------
router.post('/accept-invite', ensureScope, async (req, res) => {
  try {
    const uid = req.user?.id;
    const { token } = req.body || {};
    if (!uid) return res.status(401).json({ error: 'Unauthorized' });
    if (!token) return res.status(400).json({ error: 'token required' });

    const { data: invite, error } = await supabase
      .from('client_invites').select('*').eq('token', token).single();
    if (error || !invite) return res.status(400).json({ error: 'invalid token' });
    if (invite.accepted_at) return res.json({ ok: true, alreadyAccepted: true });
    if (new Date(invite.expires_at) < new Date()) return res.status(400).json({ error: 'expired' });

    // upsert basic membership
    const base = { client_id: invite.client_id, user_id: uid, role: invite.role || 'member' };
    const up1 = await supabase.from('client_members').upsert(base, { onConflict: 'client_id,user_id' });
    if (up1.error) return res.status(400).json({ error: up1.error.message });

    // best-effort update of name, supporting either name or "Name"
    if (invite.name) {
      const tryLower = await supabase.from('client_members')
        .update({ name: invite.name })
        .eq('client_id', invite.client_id)
        .eq('user_id', uid);

      if (tryLower.error) {
        // Try quoted "Name" key
        const payload = {}; payload['Name'] = invite.name;
        const tryUpper = await supabase.from('client_members')
          .update(payload)
          .eq('client_id', invite.client_id)
          .eq('user_id', uid);

        // If both fail, keep going without blocking
        if (tryUpper.error) console.warn('Name update failed:', tryLower.error.message, ' / ', tryUpper.error.message);
      }
    }

    await supabase.from('client_invites')
      .update({ accepted_at: new Date().toISOString() })
      .eq('id', invite.id);

    res.json({ ok: true, client_id: invite.client_id, role: invite.role, name: invite.name || null });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------- POST /clients/members/revoke ----------
router.post('/members/revoke', ensureScope, async (req, res) => {
  try {
    const { client_id, user_id } = req.body || {};
    if (!client_id || !user_id) return res.status(400).json({ error: 'client_id and user_id required' });
    if (!req.client_memberships.includes(client_id)) return res.status(403).json({ error: 'No client scope' });

    const { error } = await supabase.from('client_members')
      .delete().eq('client_id', client_id).eq('user_id', user_id);
    if (error) return res.status(400).json({ error: error.message });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
