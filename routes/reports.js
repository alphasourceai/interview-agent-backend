// routes/reports.js
// Direct-export Express router

const express = require('express');
const { supabase } = require('../src/lib/supabaseClient');
const { requireAuth, withClientScope } = require('../src/middleware/auth');

const router = express.Router();

const REPORTS_BUCKET = process.env.SUPABASE_REPORTS_BUCKET || 'reports';
const URL_TTL_SECONDS = Number(process.env.REPORTS_SIGNED_URL_TTL_SECONDS || 300);

// Helper: collect client IDs from scope (and legacy hints)
function getScopedClientIds(req) {
  const idsFromScope = Array.isArray(req?.clientScope?.memberships)
    ? req.clientScope.memberships.map(m => m.client_id).filter(Boolean)
    : [];
  const legacy = req.client?.id ? [req.client.id] : [];
  return Array.from(new Set([...idsFromScope, ...legacy]));
}

/**
 * GET /reports/:id/download
 * Finds the report's storage path (DB or fallback), verifies scope to its client,
 * and redirects to a short-lived signed URL.
 */
router.get('/:id/download', requireAuth, withClientScope, async (req, res) => {
  try {
    const id = req.params.id;
    if (!id) return res.status(400).send('Missing id');

    // 1) Try DB lookup first (be tolerant if table doesn’t exist)
    let storagePath = null;
    let reportClientId = null;

    try {
      const { data, error } = await supabase
        .from('reports')
        .select('storage_path, path, file_path, client_id')
        .eq('id', id)
        .maybeSingle(); // don't throw if not found

      if (error) {
        // If this env doesn't have the table, just fall through to fallback path
        console.warn('[reports] DB lookup error (continuing with fallback):', error.message);
      } else if (data) {
        storagePath = data.storage_path || data.path || data.file_path || null;
        reportClientId = data.client_id || null;
      }
    } catch (e) {
      // Keep going with fallback
      console.warn('[reports] DB lookup exception (continuing with fallback):', e.message);
    }

    // 2) Fallback storage path if needed
    if (!storagePath) {
      const hintedClient =
        reportClientId ||
        req.query.client_id ||
        req.clientScope?.defaultClientId ||
        req.client?.id ||
        null;

      storagePath = hintedClient
        ? `${hintedClient}/reports/${id}.pdf`
        : `reports/${id}.pdf`;
    }

    // 3) Enforce scope
    const scopedIds = getScopedClientIds(req);
    // Try to infer a client_id from the path if DB didn’t have one
    const inferredClient = storagePath.includes('/') ? storagePath.split('/')[0] : null;
    const targetClientId = reportClientId || req.query.client_id || inferredClient;

    const allowed = targetClientId
      ? scopedIds.includes(targetClientId)
      : scopedIds.length > 0; // if we truly cannot infer, allow if user has *some* scope (legacy behavior)

    if (!allowed) return res.status(403).send('Forbidden');

    // 4) Create signed URL & redirect
    const { data: signed, error: signErr } = await supabase
      .storage
      .from(REPORTS_BUCKET)
      .createSignedUrl(storagePath, URL_TTL_SECONDS);

    if (signErr || !signed?.signedUrl) {
      console.error('[GET /reports/:id/download] storage error', signErr || 'no url');
      return res.status(404).send('Report not found');
    }

    return res.redirect(302, signed.signedUrl);
  } catch (e) {
    console.error('[GET /reports/:id/download] unexpected', e);
    return res.status(500).send('Server error');
  }
});

module.exports = router;
