// routes/adminRoles.js
const express = require('express');
const router = express.Router();

// If your project exports a middleware like this (it does in src/middleware)
const requireAuth = require('../src/middleware/requireAuth');

// Small helper so we can share logic for POST/DELETE variants
async function deleteRoleForClient(pg, roleId, clientId) {
  // If you have dependent tables, add deletes here or rely on FK ON DELETE CASCADE.
  const { rows } = await pg.query(
    'DELETE FROM roles WHERE id = $1 AND client_id = $2 RETURNING id',
    [roleId, clientId]
  );
  return rows[0]?.id || null;
}

/**
 * DELETE /admin/roles?id=...&client_id=...
 * Matches the FE call in your screenshots.
 */
router.delete('/admin/roles', requireAuth({ admin: true }), async (req, res) => {
  try {
    const roleId = req.query.id || req.body?.id;
    const clientId = req.query.client_id || req.body?.client_id;

    if (!roleId || !clientId) {
      return res.status(400).json({ error: 'Missing id or client_id' });
    }

    const deleted = await deleteRoleForClient(req.pg, roleId, clientId);
    if (!deleted) return res.status(404).json({ error: 'Not found' });

    return res.json({ ok: true, id: deleted });
  } catch (err) {
    console.error('DELETE /admin/roles failed', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

/**
 * POST /admin/roles/delete
 * JSON body: { id, client_id }
 * Also supported because we tried this path from FE as well.
 */
router.post('/admin/roles/delete', requireAuth({ admin: true }), async (req, res) => {
  try {
    const roleId = req.body?.id;
    const clientId = req.body?.client_id;

    if (!roleId || !clientId) {
      return res.status(400).json({ error: 'Missing id or client_id' });
    }

    const deleted = await deleteRoleForClient(req.pg, roleId, clientId);
    if (!deleted) return res.status(404).json({ error: 'Not found' });

    return res.json({ ok: true, id: deleted });
  } catch (err) {
    console.error('POST /admin/roles/delete failed', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;