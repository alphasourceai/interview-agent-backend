'use strict';

const express = require('express');
const { requireAuth, withClientScope } = require('../src/middleware/auth');
const { supabaseAdmin } = require('../src/lib/supabaseClient');
const { ensureUserAndSendRecovery, redactEmail } = require('../src/lib/recoveryHelper');
const crypto = require('crypto');

const FRONTEND_BASE = ((process.env.FRONTEND_BASE || process.env.FRONTEND_URL || 'https://www.alphasourceai.com')).replace(/\/+$/, '');

const router = express.Router();

function parseAccepted(value) {
  if (value === undefined || value === null) return true;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value === 1;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    return normalized === 'true' || normalized === '1' || normalized === 'yes' || normalized === 'on';
  }
  return false;
}

function readTesterAckAt(row) {
  if (!row || typeof row !== 'object') return null;
  return row.tester_acknowledged_at || row.tester_ack_at || null;
}

function hasCol(row, col) {
  return !!row && Object.prototype.hasOwnProperty.call(row, col);
}

async function ensureMembershipRow(clientId, userId) {
  const { data: existing, error: existingError } = await supabaseAdmin
    .from('client_members')
    .select('*')
    .eq('client_id', clientId)
    .eq('user_id', userId)
    .maybeSingle();
  if (existingError) throw existingError;
  if (existing) return existing;

  let inserted = null;
  let insertError = null;

  ({ data: inserted, error: insertError } = await supabaseAdmin
    .from('client_members')
    .insert({ client_id: clientId, user_id: userId, role: 'tester' })
    .select('*')
    .single());

  if (insertError && insertError.code === '23514') {
    ({ data: inserted, error: insertError } = await supabaseAdmin
      .from('client_members')
      .insert({ client_id: clientId, user_id: userId, role: 'member' })
      .select('*')
      .single());
  }

  if (insertError) throw insertError;
  return inserted;
}

function getClientIp(req) {
  const cf = req.headers['cf-connecting-ip'];
  if (typeof cf === 'string' && cf.trim()) return cf.trim();

  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.trim()) {
    const first = xff.split(',')[0];
    if (first && first.trim()) return first.trim();
  }

  if (Array.isArray(xff) && xff.length > 0 && String(xff[0] || '').trim()) {
    return String(xff[0]).trim();
  }

  return req.ip || null;
}

async function applyTesterAck(clientId, userId, ipAddress) {
  const nowIso = new Date().toISOString();
  const row = await ensureMembershipRow(clientId, userId);

  const updatePayload = {};
  if (hasCol(row, 'tester_acknowledged_at')) updatePayload.tester_acknowledged_at = nowIso;
  if (hasCol(row, 'tester_acknowledged_ip')) updatePayload.tester_acknowledged_ip = ipAddress;
  if (hasCol(row, 'tester_ack')) updatePayload.tester_ack = true;
  if (hasCol(row, 'tester_ack_version')) updatePayload.tester_ack_version = 'v1';
  if (hasCol(row, 'tester_ack_at')) updatePayload.tester_ack_at = nowIso;

  if (Object.keys(updatePayload).length === 0) {
    return row;
  }

  const { data: updated, error: updateError } = await supabaseAdmin
    .from('client_members')
    .update(updatePayload)
    .eq('client_id', clientId)
    .eq('user_id', userId)
    .select('*')
    .single();

  if (updateError) throw updateError;
  return updated;
}

router.get('/', requireAuth, withClientScope, async (req, res) => {
  try {
    const request_id = req.request_id || crypto.randomUUID?.() || String(Date.now());
    const clientId = req.query.client_id || req.client?.id || req.clientScope?.defaultClientId || null;
    if (!clientId) return res.status(400).json({ error: 'client_id_required', request_id });

    const membership = (req.clientScope?.memberships || []).find((m) => m.client_id === clientId);
    const isGlobalAdmin = req.user?.role === 'admin' || req.user?.is_admin === true || req.isAdmin === true;
    if (!isGlobalAdmin && !membership) {
      return res.status(403).json({ error: 'forbidden', request_id });
    }

    const { data, error } = await supabaseAdmin
      .from('client_members')
      .select('client_id,user_id,email,name,role,created_at,tester_acknowledged_at,tester_acknowledged_ip')
      .eq('client_id', clientId)
      .order('created_at', { ascending: false });

    if (error) {
      console.error('[client-members] list error', error.message);
      return res.status(500).json({ error: 'list_members_failed', detail: error.message, request_id });
    }

    const items = (data || []).map((m) => ({ ...m, id: m.user_id || m.email }));
    res.json({ items, request_id });
  } catch (e) {
    const request_id = req.request_id || crypto.randomUUID?.() || String(Date.now());
    console.error('[client-members] unexpected', e?.message || e);
    res.status(500).json({ error: 'server_error', request_id });
  }
});

router.get('/me', requireAuth, withClientScope, async (req, res) => {
  const request_id = req.request_id || crypto.randomUUID?.() || String(Date.now());
  try {
    const clientId = req.client?.id || req.clientScope?.defaultClientId || req.query.client_id || null;
    const userId = req.user?.id || null;
    console.log('[client-members] me hit', {
      method: req.method,
      path: req.originalUrl || req.path,
      request_id,
      client_id: clientId,
      user_id: userId
    });
    if (!clientId) return res.status(400).json({ error: 'client_id_required', request_id });
    if (!userId) return res.status(401).json({ error: 'unauthorized', request_id });

    const membership = (req.clientScope?.memberships || []).find((m) => m.client_id === clientId);
    const isGlobalAdmin = req.user?.role === 'admin' || req.user?.is_admin === true || req.isAdmin === true;
    if (!isGlobalAdmin && !membership) {
      return res.status(403).json({ error: 'forbidden', request_id });
    }

    const { data, error } = await supabaseAdmin
      .from('client_members')
      .select('client_id,user_id,role,created_at,tester_acknowledged_at,tester_acknowledged_ip')
      .eq('client_id', clientId)
      .eq('user_id', userId)
      .maybeSingle();

    if (error) {
      console.error('[client-members/me] fetch_failed', { request_id, error: error.message, code: error.code });
      return res.status(500).json({ error: 'fetch_member_failed', detail: error.message, code: error.code, request_id });
    }
    const member = data || null;
    return res.json({
      ok: true,
      member,
      role: member?.role || null,
      tester_acknowledged_at: member?.tester_acknowledged_at || null,
      tester_acknowledged_ip: member?.tester_acknowledged_ip || null,
      request_id
    });
  } catch (e) {
    console.error('[client-members/me] unexpected', { request_id, error: e?.message || e });
    return res.status(500).json({ error: 'server_error', request_id });
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
    const isGlobalAdmin = req.user?.role === 'admin' || req.user?.is_admin === true || req.isAdmin === true;
    const userRole = (membership?.role || '').toLowerCase();
    if (!isGlobalAdmin && (!membership || !['manager', 'admin', 'tester'].includes(userRole))) {
      return res.status(403).json({ error: 'forbidden', request_id });
    }
    if (!['member', 'manager'].includes(role)) {
      return res.status(400).json({ error: 'invalid_role', request_id });
    }

    console.log('[client-members/scoped-add] start', { request_id, client_id: clientId, role, email: redactEmail(email), by_role: userRole, redirectTo: `${FRONTEND_BASE}/pwreset` });

    const { userId, method, inviteActionLink, recovery_sent } = await ensureUserAndSendRecovery({
      email,
      redirectTo: `${FRONTEND_BASE}/pwreset`,
      request_id,
      loggerPrefix: '[client-members/scoped-add]'
    });
    console.log('[client-members/scoped-add] invite-result', { request_id, email: redactEmail(email), method, userIdPresent: !!userId, hasInviteActionLink: !!inviteActionLink, redirectTo: `${FRONTEND_BASE}/pwreset`, recovery_sent: !!recovery_sent });
    if (!userId) {
      console.error('[client-members/scoped-add] add_member_no_user_id', { request_id, email: redactEmail(email), method });
      return res.status(400).json({
        error: 'add_member_failed',
        detail: 'Could not create or locate user for this email.',
        hint: 'Try again or send the magic link manually.',
        action_link: null,
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
      if (error.code === '23505' || error.code === 'PGRST116') {
        return res.status(409).json({ error: 'email_in_use', detail: 'Email address already exists', request_id });
      }
      return res.status(500).json({ error: 'add_member_failed', detail: error.message, hint: error.hint, code: error.code, request_id });
    }

    const m = data;
    console.log('[client-members/scoped-add] success', { request_id, client_id: clientId, role, email: redactEmail(email), method });
    res.json({ item: { ...m, id: m.user_id || m.email }, request_id, invite_action_link: inviteActionLink || null });
  } catch (e) {
    if (e?.code === 'misconfigured_supabase_auth') {
      return res.status(500).json({ error: 'misconfigured_supabase_auth', detail: e.detail || 'Missing SUPABASE_PUBLIC_ANON_KEY', request_id: req.request_id || request_id });
    }
    if (e?.code === 'email_in_use') {
      console.warn('[client-members/scoped-add] email_in_use', { email: redactEmail(req.body?.email), request_id: req.request_id || null });
      return res.status(409).json({ error: 'email_in_use', detail: 'Email address already exists', request_id: req.request_id || null });
    }
    console.error('[client-members/add] unexpected', { request_id: req.request_id || null, error: e?.message || e });
    res.status(500).json({ error: 'server_error', request_id: req.request_id || null, code: 'server_error' });
  }
});

router.delete('/:id', requireAuth, withClientScope, async (req, res) => {
  try {
    const request_id = req.request_id || crypto.randomUUID?.() || String(Date.now());
    const key = req.params.id;
    const client_id = req.query.client_id || req.client?.id || req.clientScope?.defaultClientId || null;
    if (!client_id) return res.status(400).json({ error: 'client_id_required', request_id });

    const membership = (req.clientScope?.memberships || []).find((m) => m.client_id === client_id);
    const isGlobalAdmin = req.user?.role === 'admin' || req.user?.is_admin === true || req.isAdmin === true;
    const userRole = (membership?.role || '').toLowerCase();
    if (!isGlobalAdmin && (!membership || !['manager', 'admin', 'tester'].includes(userRole))) {
      return res.status(403).json({ error: 'forbidden', request_id });
    }

    // Block self-delete
    const targetUserId = key.includes('@') ? null : key;
    if (targetUserId && targetUserId === req.user?.id) {
      console.error('[client/members/delete] self delete blocked', { request_id, user_id: req.user?.id, target_user_id: targetUserId });
      return res.status(403).json({
        error: 'not_allowed',
        code: 'self_delete_forbidden',
        detail: 'Not allowed to delete yourself',
        hint: 'A user cannot remove their own membership.',
        request_id
      });
    }

    let q = supabaseAdmin.from('client_members').delete();
    if (key.includes('@')) q = q.eq('email', key);
    else q = q.eq('user_id', key);
    q = q.eq('client_id', client_id);

    const { error } = await q;
    if (error) return res.status(500).json({ error: 'remove_member_failed', detail: error.message, request_id });
    res.json({ ok: true, request_id });
  } catch (e) {
    const request_id = req.request_id || crypto.randomUUID?.() || String(Date.now());
    console.error('[client-members/delete] unexpected', e?.message || e);
    res.status(500).json({ error: 'server_error', request_id });
  }
});

router.get('/tester-ack', requireAuth, withClientScope, async (req, res) => {
  try {
    const request_id = req.request_id || crypto.randomUUID?.() || String(Date.now());
    const clientId = req.client?.id || req.clientScope?.defaultClientId || req.query.client_id || req.body?.client_id || null;
    const userId = req.user?.id || null;

    console.log('[client-members] tester-ack hit', {
      method: req.method,
      path: req.originalUrl || req.path,
      request_id,
      client_id: clientId,
      user_id: userId
    });

    if (!clientId) return res.status(400).json({ error: 'client_id_required', request_id });
    if (!userId) return res.status(401).json({ error: 'unauthorized', request_id });

    const { data: row, error } = await supabaseAdmin
      .from('client_members')
      .select('tester_acknowledged_at,tester_acknowledged_ip,tester_ack,tester_ack_at')
      .eq('client_id', clientId)
      .eq('user_id', userId)
      .maybeSingle();
    if (error) {
      console.error('[tester-ack] get failed', error.message);
      return res.status(500).json({ error: 'tester_ack_fetch_failed', detail: error.message, request_id });
    }

    const testerAckAt = readTesterAckAt(row);
    const acknowledged = Boolean(testerAckAt);
    return res.json({
      ok: true,
      acknowledged,
      tester_acknowledged_at: testerAckAt || null,
      tester_acknowledged_ip: row?.tester_acknowledged_ip || null,
      tester_ack_at: testerAckAt || null,
      request_id
    });
  } catch (e) {
    const request_id = req.request_id || crypto.randomUUID?.() || String(Date.now());
    console.error('[tester-ack] unexpected', e?.message || e);
    return res.status(500).json({ error: 'server_error', request_id });
  }
});

// Tester NDA acknowledgement
router.post('/tester-ack', requireAuth, withClientScope, async (req, res) => {
  try {
    const request_id = req.request_id || crypto.randomUUID?.() || String(Date.now());
    const clientId = req.client?.id || req.clientScope?.defaultClientId || req.query.client_id || req.body?.client_id || null;
    const userId = req.user?.id || null;
    const accepted = parseAccepted(req.body?.accepted);
    const ipAddress = getClientIp(req);

    console.log('[client-members] tester-ack hit', {
      method: req.method,
      path: req.originalUrl || req.path,
      request_id,
      client_id: clientId,
      user_id: userId
    });

    if (!clientId) return res.status(400).json({ error: 'client_id_required', request_id });
    if (!userId) return res.status(401).json({ error: 'unauthorized', request_id });
    if (!accepted) return res.status(400).json({ error: 'accepted_required', request_id });

    const updateRow = await applyTesterAck(clientId, userId, ipAddress);
    if (!updateRow) {
      return res.status(500).json({ error: 'tester_ack_failed', request_id });
    }
    return res.json({ ok: true });
  } catch (e) {
    const request_id = req.request_id || crypto.randomUUID?.() || String(Date.now());
    if (e?.message) {
      console.error('[tester-ack] update failed', e.message);
      return res.status(500).json({ error: 'tester_ack_failed', detail: e.message, request_id });
    }
    console.error('[tester-ack] unexpected', e?.message || e);
    return res.status(500).json({ error: 'server_error', request_id });
  }
});

module.exports = router;
