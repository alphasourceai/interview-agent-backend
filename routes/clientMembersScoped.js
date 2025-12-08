'use strict';

const express = require('express');
const { requireAuth, withClientScope } = require('../src/middleware/auth');
const { supabaseAdmin } = require('../src/lib/supabaseClient');
const crypto = require('crypto');

const router = express.Router();

// Helper copied from app.js helper logic
async function ensureUserIdAndInvite(email, redirectTo) {
  let userId = null;
  let actionLink = null;
  let method = null;

  try {
    const invited = await supabaseAdmin.auth.admin.inviteUserByEmail(email, { redirectTo });
    userId = invited?.data?.user?.id || null;
    method = 'invite';
  } catch (e) {
    console.error('inviteUserByEmail failed:', e?.message || e);
  }

  if (!userId) {
    try {
      const link = await supabaseAdmin.auth.admin.generateLink({
        type: 'magiclink',
        email,
        options: { redirectTo }
      });
      userId = link?.data?.user?.id || null;
      actionLink = link?.data?.action_link || null;
      method = method || 'magiclink';
    } catch (e) {
      console.error('generateLink(magiclink) failed:', e?.message || e);
    }
  }

  if (!userId) {
    try {
      const created = await supabaseAdmin.auth.admin.createUser({
        email,
        email_confirm: true
      });
      userId = created?.data?.user?.id || null;
      method = method || 'createUser';
    } catch (e) {
      console.error('createUser failed:', e?.message || e);
    }
  }

  return { userId, actionLink, method };
}

router.get('/', requireAuth, withClientScope, async (req, res) => {
  try {
    const clientId = req.query.client_id || req.client?.id || req.clientScope?.defaultClientId || null;
    if (!clientId) return res.status(400).json({ error: 'client_id_required' });

    const membership = (req.clientScope?.memberships || []).find((m) => m.client_id === clientId);
    if (!membership) return res.status(403).json({ error: 'forbidden' });

    const { data, error } = await supabaseAdmin
      .from('client_members')
      .select('client_id,user_id,email,name,role,created_at')
      .eq('client_id', clientId)
      .order('created_at', { ascending: false });

    if (error) {
      console.error('[client-members] list error', error.message);
      return res.status(500).json({ error: 'list_members_failed', detail: error.message });
    }

    const items = (data || []).map((m) => ({ ...m, id: m.user_id || m.email }));
    res.json({ items });
  } catch (e) {
    console.error('[client-members] unexpected', e?.message || e);
    res.status(500).json({ error: 'server_error' });
  }
});

router.post('/', requireAuth, withClientScope, async (req, res) => {
  try {
    const { client_id, email, name } = req.body || {};
    const role = (req.body?.role || 'member').toLowerCase();
    const clientId = client_id || req.client?.id || req.clientScope?.defaultClientId || null;

    if (!clientId || !email || !name) return res.status(400).json({ error: 'client_id_email_name_required' });

    const membership = (req.clientScope?.memberships || []).find((m) => m.client_id === clientId);
    const userRole = (membership?.role || '').toLowerCase();
    if (!membership || (userRole !== 'manager' && userRole !== 'admin')) {
      return res.status(403).json({ error: 'forbidden' });
    }
    if (!['member', 'manager'].includes(role)) {
      return res.status(400).json({ error: 'invalid_role' });
    }

    const redirectTo = 'https://www.alphasourceai.com/account?auth_callback=1';
    const { userId, actionLink, method } = await ensureUserIdAndInvite(email, redirectTo);
    if (!userId) {
      console.error('add_member_no_user_id', { email, method });
      return res.status(400).json({
        error: 'add_member_failed',
        detail: 'Could not create or locate user for this email.',
        hint: 'Try again or send the magic link manually.',
        action_link: actionLink || null
      });
    }

    const payload = { client_id: clientId, email, name, role, user_id: userId };
    const { data, error } = await supabaseAdmin
      .from('client_members')
      .insert(payload)
      .select('client_id,user_id,email,name,role,created_at')
      .single();

    if (error) {
      console.error('add_member_insert_failed:', error.message);
      return res.status(500).json({ error: 'add_member_failed', detail: error.message });
    }

    const m = data;
    res.json({ item: { ...m, id: m.user_id || m.email } });
  } catch (e) {
    console.error('[client-members/add] unexpected', e?.message || e);
    res.status(500).json({ error: 'server_error' });
  }
});

router.delete('/:id', requireAuth, withClientScope, async (req, res) => {
  try {
    const key = req.params.id;
    const client_id = req.query.client_id || req.client?.id || req.clientScope?.defaultClientId || null;
    if (!client_id) return res.status(400).json({ error: 'client_id_required' });

    const membership = (req.clientScope?.memberships || []).find((m) => m.client_id === client_id);
    const userRole = (membership?.role || '').toLowerCase();
    if (!membership || (userRole !== 'manager' && userRole !== 'admin')) {
      return res.status(403).json({ error: 'forbidden' });
    }

    let q = supabaseAdmin.from('client_members').delete();
    if (key.includes('@')) q = q.eq('email', key);
    else q = q.eq('user_id', key);
    q = q.eq('client_id', client_id);

    const { error } = await q;
    if (error) return res.status(500).json({ error: 'remove_member_failed', detail: error.message });
    res.json({ ok: true });
  } catch (e) {
    console.error('[client-members/delete] unexpected', e?.message || e);
    res.status(500).json({ error: 'server_error' });
  }
});

module.exports = router;
