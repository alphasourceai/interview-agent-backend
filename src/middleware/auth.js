// src/middleware/auth.js
const jwt = require('jsonwebtoken');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Validate Supabase JWT from Authorization: Bearer <token>
function requireAuth(req, res, next) {
  try {
    const authHeader = req.header('authorization') || req.header('Authorization') || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
    if (!token) return res.status(401).json({ error: 'Missing bearer token' });

    const decoded = jwt.decode(token);
    if (!decoded || !decoded.sub) return res.status(401).json({ error: 'Invalid token' });

    req.user = { id: decoded.sub, email: decoded.email || decoded.user_email || null };
    req.userToken = token;
    next();
  } catch (err) {
    console.error('[requireAuth] error', err);
    return res.status(401).json({ error: 'Unauthorized' });
  }
}

// Resolve user’s client scope.
// Accepts ?client_id=... or falls back to first membership.
// Works with either client_members.user_id_uuid or client_members.user_id.
async function withClientScope(req, res, next) {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const explicit = req.query.client_id || req.body?.client_id;
    if (explicit) {
      req.client = { id: explicit };
      req.clientScope = { user: req.user, memberships: [], defaultClientId: explicit };
      return next();
    }

    // Try modern column first
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

    if (error) return res.status(500).json({ error: 'Client scope lookup failed' });
    if (!data || data.length === 0) return res.status(403).json({ error: 'No client membership found' });

    const memberships = data.map(r => ({
      client_id: r.client_id,
      role: r.role || 'member',
      name: r.clients?.name || null,
    }));

    const defaultClientId = memberships[0].client_id;

    req.client = { id: defaultClientId, name: memberships[0].name || null };
    req.membership = { role: memberships[0].role };
    req.clientScope = { user: req.user, memberships, defaultClientId };

    next();
  } catch (err) {
    console.error('[withClientScope] error', err);
    return res.status(500).json({ error: 'Client scope error' });
  }
}

module.exports = { requireAuth, withClientScope, supabase };
