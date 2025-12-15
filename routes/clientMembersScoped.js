'use strict';

const express = require('express');
const { requireAuth, withClientScope } = require('../src/middleware/auth');
const { supabaseAdmin } = require('../src/lib/supabaseClient');
const crypto = require('crypto');

const FRONTEND_BASE = ((process.env.FRONTEND_URL || 'https://www.alphasourceai.com')).replace(/\/+$/, '');
const redactEmail = (email) => {
  try {
    if (!email) return '';
    const [user, domain] = String(email).split('@');
    if (!domain) return email;
    if (user.length <= 3) return `${user[0] || ''}***@${domain}`;
    return `${user.slice(0, 2)}***@${domain}`;
  } catch (_) {
    return email;
  }
};

const router = express.Router();

// Helper copied from app.js helper logic
async function ensureUserIdAndInvite({ email, fullName, role, redirectTo }) {
  let userId = null;
  let actionLink = null;
  let method = null;
  const effectiveRedirect = redirectTo || `${FRONTEND_BASE}/accept-invite`;

  try {
    const existing = await supabaseAdmin.auth.admin.getUserByEmail(email);
    if (existing?.data?.user) {
      const err = new Error('This email is already in use for another user.');
      err.code = 'email_in_use';
      throw err;
    }
  } catch (e) {
    if (e?.code === 'email_in_use') throw e;
  }

  try {
    const invited = await supabaseAdmin.auth.admin.inviteUserByEmail(email, { redirectTo: effectiveRedirect });
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
        options: { redirectTo: effectiveRedirect, data: { role, full_name: fullName || email } }
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
        email_confirm: true,
        user_metadata: { role, full_name: fullName || email }
      });
      userId = created?.data?.user?.id || null;
      method = method || 'createUser';
    } catch (e) {
      console.error('createUser failed:', e?.message || e);
    }
    if (userId) {
      try {
        await supabaseAdmin.auth.admin.inviteUserByEmail(email, { redirectTo: effectiveRedirect });
        method = 'createUser+invite';
      } catch (e) {
        console.error('second invite after createUser failed:', e?.message || e);
      }
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
      .select('client_id,user_id,email,name,role,created_at,tester_acknowledged_at,tester_acknowledged_ip')
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
    const request_id = req.request_id || crypto.randomUUID?.() || String(Date.now());

    if (!clientId || !email || !name) return res.status(400).json({ error: 'client_id_email_name_required', request_id });

    const membership = (req.clientScope?.memberships || []).find((m) => m.client_id === clientId);
    const userRole = (membership?.role || '').toLowerCase();
    if (!membership || !['manager', 'admin', 'tester'].includes(userRole)) {
      return res.status(403).json({ error: 'forbidden', request_id });
    }
    if (!['member', 'manager'].includes(role)) {
      return res.status(400).json({ error: 'invalid_role', request_id });
    }

    console.log('[client-members/scoped-add] start', { request_id, client_id: clientId, role, email: redactEmail(email), by_role: userRole, redirectTo: `${FRONTEND_BASE}/accept-invite` });

    const { userId, actionLink, method, inviteActionLink } = await ensureUserIdAndInvite({
      email,
      fullName: name,
      role,
      redirectTo: `${FRONTEND_BASE}/accept-invite`
    });
    console.log('[client-members/scoped-add] invite-result', { request_id, email: redactEmail(email), method, userIdPresent: !!userId, hasInviteActionLink: !!inviteActionLink, redirectTo: `${FRONTEND_BASE}/accept-invite` });
    if (!userId) {
      console.error('[client-members/scoped-add] add_member_no_user_id', { request_id, email: redactEmail(email), method });
      return res.status(400).json({
        error: 'add_member_failed',
        detail: 'Could not create or locate user for this email.',
        hint: 'Try again or send the magic link manually.',
        action_link: actionLink || null,
        request_id
      });
    }

    const payload = { client_id: clientId, email, name, role, user_id: userId };
    const { data, error } = await supabaseAdmin
      .from('client_members')
      .insert(payload)
      .select('client_id,user_id,email,name,role,created_at')
      .single();

    if (error) {
      console.error('[client-members/scoped-add] add_member_insert_failed', { request_id, error: error.message, code: error.code, hint: error.hint });
      return res.status(500).json({ error: 'add_member_failed', detail: error.message, hint: error.hint, code: error.code, request_id });
    }

    const m = data;
    console.log('[client-members/scoped-add] success', { request_id, client_id: clientId, role, email: redactEmail(email), method });
    res.json({ item: { ...m, id: m.user_id || m.email }, request_id, invite_action_link: inviteActionLink || null });
  } catch (e) {
    if (e?.code === 'email_in_use') {
      console.warn('[client-members/scoped-add] email_in_use', { email: redactEmail(req.body?.email), request_id: req.request_id || null });
      return res.status(409).json({ error: 'email_in_use', code: 'email_in_use', detail: 'Email address already exists', request_id: req.request_id || null });
    }
    console.error('[client-members/add] unexpected', { request_id: req.request_id || null, error: e?.message || e });
    res.status(500).json({ error: 'server_error', request_id: req.request_id || null, code: 'server_error' });
  }
});

router.delete('/:id', requireAuth, withClientScope, async (req, res) => {
  try {
    const key = req.params.id;
    const client_id = req.query.client_id || req.client?.id || req.clientScope?.defaultClientId || null;
    if (!client_id) return res.status(400).json({ error: 'client_id_required' });

    const membership = (req.clientScope?.memberships || []).find((m) => m.client_id === client_id);
    const userRole = (membership?.role || '').toLowerCase();
    if (!membership || !['manager', 'admin', 'tester'].includes(userRole)) {
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

// Tester NDA acknowledgement
router.post('/tester-ack', requireAuth, withClientScope, async (req, res) => {
  try {
    const clientId = req.body?.client_id || req.query.client_id || req.client?.id || req.clientScope?.defaultClientId || null;
    if (!clientId) return res.status(400).json({ error: 'client_id_required' });

    const membership = (req.clientScope?.memberships || []).find((m) => m.client_id === clientId);
    if (!membership) return res.status(403).json({ error: 'forbidden' });
    if ((membership.role || '').toLowerCase() !== 'tester') {
      return res.status(403).json({ error: 'forbidden' });
    }
    if (membership.tester_acknowledged_at) {
      return res.json({ ok: true, tester_acknowledged_at: membership.tester_acknowledged_at, tester_acknowledged_ip: membership.tester_acknowledged_ip || null });
    }

    const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip || null;
    let q = supabaseAdmin
      .from('client_members')
      .update({ tester_acknowledged_at: new Date().toISOString(), tester_acknowledged_ip: ip || null })
      .eq('client_id', clientId);
    // prefer user_id_uuid but fall back to legacy user_id
    q = q.or(`user_id_uuid.eq.${req.user.id},user_id.eq.${req.user.id}`);

    const { data, error } = await q
      .select('tester_acknowledged_at,tester_acknowledged_ip')
      .maybeSingle();
    if (error) {
      console.error('[tester-ack] update failed', error.message);
      return res.status(500).json({ error: 'tester_ack_failed', detail: error.message });
    }
    return res.json({ ok: true, tester_acknowledged_at: data?.tester_acknowledged_at || null, tester_acknowledged_ip: data?.tester_acknowledged_ip || ip || null });
  } catch (e) {
    console.error('[tester-ack] unexpected', e?.message || e);
    return res.status(500).json({ error: 'server_error' });
  }
});

module.exports = router;
