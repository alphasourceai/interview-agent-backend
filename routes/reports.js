// routes/reports.js
const router = require('express').Router();
const { requireAuth, withClientScope, supabase } = require('../middleware/auth');

/**
 * GET /reports/:id/download
 * Looks up report by id scoped to client, generates signed URL from private bucket, and redirects (302).
 * Falls back to streaming if sign fails.
 */
router.get('/:id/download', requireAuth, withClientScope, async (req, res) => {
  const id = req.params.id;

  const { data, error } = await supabase
    .from('reports')
    .select('id, client_id, storage_path, mime_type')
    .eq('id', id)
    .eq('client_id', req.client.id)
    .single();

  if (error || !data) return res.status(404).json({ error: 'Report not found' });

  const bucket = process.env.SUPABASE_REPORTS_BUCKET || 'reports';
  const ttl = Number(process.env.SIGNED_URL_TTL_SECONDS || 60);

  const { data: signed, error: signErr } =
    await supabase.storage.from(bucket).createSignedUrl(data.storage_path, ttl);

  if (!signErr && signed?.signedUrl) {
    return res.redirect(302, signed.signedUrl);
  }

  // Last resort: stream through server (avoid if large)
  const { data: dl, error: dlErr } =
    await supabase.storage.from(bucket).download(data.storage_path);
  if (dlErr || !dl) return res.status(500).json({ error: 'Unable to fetch report' });

  res.setHeader('Content-Type', data.mime_type || 'application/pdf');
  return dl.arrayBuffer().then(buf => res.send(Buffer.from(buf)));
});

module.exports = router;
