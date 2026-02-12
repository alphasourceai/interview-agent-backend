// src/middleware/auth.js
const jwt = require('jsonwebtoken');
const { supabaseAdmin } = require('../lib/supabaseClient');

const supabase = supabaseAdmin;

/**
 * Extract a bearer token from:
 *  - Authorization: Bearer <token>
 *  - Cookie: sb-access-token=<token> (or sb:token)
 */
function getToken(req) {
  const hdr = req.header('authorization') || req.header('Authorization') || '';
  if (hdr.startsWith('Bearer ')) return hdr.slice(7).trim();

  // Very light cookie parse to avoid bringing a dependency
  const rawCookie = req.headers.cookie || '';
  if (rawCookie) {
    for (const part of rawCookie.split(';')) {
      const [k, v] = part.split('=').map(s => (s || '').trim());
      if (!k) continue;
      if (k === 'sb-access-token' || k === 'sb:token') return decodeURIComponent(v || '');
    }
  }
  return null;
}

async function lookupGlobalAdmin(userEmail, userId) {
  if (!supabase) return false;
  try {
    if (userEmail) {
      const { data, error } = await supabase
        .from('admins')
        .select('id')
        .eq('email', userEmail)
        .eq('is_active', true)
        .maybeSingle();
      if (!error && data) return true;
    }
    if (userId) {
      const { data, error } = await supabase
        .from('admins')
        .select('id')
        .eq('user_id', userId)
        .eq('is_active', true)
        .maybeSingle();
      if (!error && data) return true;
    }
  } catch (err) {
    console.error('[requireAuth] admin lookup error', err);
  }
  return false;
}

/**
 * Auth middleware
 * - Decodes the Supabase JWT (no verification here; Supabase will verify on DB calls via RLS)
 * - Attaches req.user and req.userToken
 */
async function requireAuth(req, res, next) {
  try {
    const token = getToken(req);
    if (!token) return res.status(401).json({ error: 'Missing bearer token' });

    const decoded = jwt.decode(token);
    // Supabase JWT normally includes `sub` as the user id
    const sub = decoded && (decoded.sub || decoded.user_id);
    if (!decoded || !sub) return res.status(401).json({ error: 'Invalid token' });

    req.user = { id: sub, email: decoded.email || decoded.user_email || null };
    req.userToken = token;
    req.isGlobalAdmin = await lookupGlobalAdmin(req.user.email, req.user.id);
    req.isAdmin = req.isGlobalAdmin;
    return next();
  } catch (err) {
    console.error('[requireAuth] error', err);
    return res.status(401).json({ error: 'Unauthorized' });
  }
}

/**
 * Client scope middleware
 * - Works with client_members.user_id_uuid (new) OR client_members.user_id (legacy)
 * - Attaches:
 *     req.client_memberships: string[] of client_ids
 *     req.clientScope: { user, memberships, defaultClientId? }
 *     req.client: { id, name? }
 */
async function withClientScope(req, res, next) {
  try {
    if (!supabase) {
      console.error('[withClientScope] Supabase client not configured.');
      return res.status(500).json({ error: 'Server not configured' });
    }
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const explicit = req.query.client_id || req.body?.client_id || null;

    if (req.isGlobalAdmin === true) {
      if (explicit) {
        req.client_memberships = [explicit];
        req.clientIds = [explicit];
        req.memberships = [{ client_id: explicit, role: 'admin', name: null }];
        req.clientScope = { user: req.user, memberships: req.memberships, defaultClientId: explicit };
        req.client = { id: explicit, name: null };
        req.membership = { role: 'admin' };
        return next();
      }

      const { data: clients, error: clientsErr } = await supabase
        .from('clients')
        .select('id, name')
        .limit(5000);
      if (clientsErr) {
        console.error('[withClientScope] admin clients lookup error', clientsErr);
        req.client_memberships = [];
        req.clientIds = [];
        req.memberships = [];
        req.clientScope = { user: req.user, memberships: [] };
        return next();
      }

      const memberships = (clients || []).map(c => ({
        client_id: c.id,
        role: 'admin',
        name: c.name || null,
      }));
      const ids = memberships.map(m => m.client_id).filter(Boolean);
      req.client_memberships = ids;
      req.clientIds = ids;
      req.memberships = memberships;
      const defaultClientId = ids.length ? ids[0] : null;
      req.clientScope = { user: req.user, memberships, defaultClientId };
      if (defaultClientId) {
        const m = memberships.find(x => x.client_id === defaultClientId) || null;
        req.client = { id: defaultClientId, name: m?.name || null };
        req.membership = { role: 'admin' };
      }
      return next();
    }

    // Try modern column first
    let rows = [];
    let { data, error } = await supabase
      .from('client_members')
      .select('client_id, role, user_id_uuid, clients ( id, name )')
      .eq('user_id_uuid', userId)
      .limit(50);

    // Retry with legacy column if schema differs
    if (error && error.code === '42703') {
      const retry = await supabase
        .from('client_members')
        .select('client_id, role, user_id, clients ( id, name )')
        .eq('user_id', userId)
        .limit(50);
      data = retry.data;
      error = retry.error;
    }

    if (error) {
      console.error('[withClientScope] lookup error', error);
      // Don’t block every request due to a read failure; attach empty context
      req.client_memberships = [];
      req.clientIds = [];
      req.memberships = [];
      req.clientScope = { user: req.user, memberships: [] };
      return next();
    }

    rows = Array.isArray(data) ? data : [];
    const memberships = rows.map(r => ({
      client_id: r.client_id,
      role: r.role || 'member',
      name: r.clients?.name || null,
    }));

    const ids = memberships.map(m => m.client_id).filter(Boolean);
    req.client_memberships = ids;
    req.clientIds = ids;
    req.memberships = memberships;

    // Decide default
    let defaultClientId = null;
    if (explicit && ids.includes(explicit)) {
      defaultClientId = explicit;
    } else if (ids.length) {
      defaultClientId = ids[0];
    }

    // Attach helpers for routes that expect them
    req.clientScope = { user: req.user, memberships, defaultClientId };
    if (defaultClientId) {
      const m = memberships.find(x => x.client_id === defaultClientId) || memberships[0] || null;
      req.client = { id: defaultClientId, name: m?.name || null };
      req.membership = m ? { role: m.role } : null;
    }

    // IMPORTANT: we no longer hard-403 when user has zero memberships here.
    // Let routes decide whether to 403 or show an empty state.
    return next();
  } catch (err) {
    console.error('[withClientScope] error', err);
    req.client_memberships = [];
    req.clientIds = [];
    req.memberships = [];
    req.clientScope = { user: req.user, memberships: [] };
    return next();
  }
}

module.exports = { requireAuth, withClientScope, supabase };
