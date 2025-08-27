// middleware/withClientScope.js
const { isPostgrestError } = require('../util/pg');

async function trySelect(supabase, table, select, eqCol, eqVal) {
  const { data, error } = await supabase.from(table).select(select).eq(eqCol, eqVal);
  if (error) throw error;
  return data;
}

// Fallback across schema variants and an optional consolidated view.
async function fetchMemberships(supabase, userId) {
  const attempts = [
    // canonical (most deployments)
    { table: 'client_members', select: 'client_id_uuid as client_id, role, name', eqCol: 'user_id_uuid' },
    // alt names we’ve seen in older repos
    { table: 'client_members', select: 'client_id_uuid as client_id, role, name', eqCol: 'user_uuid' },
    { table: 'client_members', select: 'client_id as client_id, role, name',       eqCol: 'user_id' },
    // consolidated view (if you created it)
    { table: 'user_clients',   select: 'client_id, role, name',                    eqCol: 'user_id' },
  ];

  let lastErr = null;
  for (const a of attempts) {
    try {
      return await trySelect(supabase, a.table, a.select, a.eqCol, userId);
    } catch (err) {
      // Column missing? Try next variant.
      if (isPostgrestError(err, '42703')) { lastErr = err; continue; }
      // Other errors are real
      throw err;
    }
  }
  if (lastErr) throw lastErr;
  return [];
}

// Express middleware: attaches req.clientScope
module.exports = function withClientScope(supabase) {
  return async function (req, res, next) {
    try {
      const user = req.user;
      if (!user?.id) return res.status(401).json({ error: 'unauthorized' });

      const memberships = await fetchMemberships(supabase, user.id);

      if (!Array.isArray(memberships) || memberships.length === 0) {
        return res.status(403).json({ error: 'no client scope' });
      }
      // Prefer the first as default
      req.clientScope = {
        user,
        memberships,
        defaultClientId: memberships[0]?.client_id || null,
      };
      next();
    } catch (err) {
      console.error('[withClientScope]', err);
      return res.status(500).json({ error: 'server_error' });
    }
  };
};
