// routes/reports.js
// Factory router. ctx: { supabase, auth, withClientScope, buckets }

const express = require('express');

module.exports = function makeReportsRouter({ supabase, auth, withClientScope, buckets }) {
  const router = express.Router();
  const bucket = (buckets && buckets.reports) || 'reports';

  // GET /reports/:id/download
  // Try to find report path in DB; if absent, fall back to a conventional path.
  router.get('/:id/download', auth, withClientScope, async (req, res) => {
    try {
      const id = req.params.id;
      if (!id) return res.status(400).send('Missing id');

      // Try DB lookup first
      let storagePath = null;
      try {
        const { data } = await supabase
          .from('reports')
          .select('storage_path, path, file_path, client_id')
          .eq('id', id)
          .limit(1)
          .single();

        storagePath =
          data?.storage_path || data?.path || data?.file_path || null;

        // If still unknown, fall back to a conventional path with client
        if (!storagePath) {
          const clientId =
            req.query.client_id || req.client?.id || data?.client_id || null;
          storagePath = clientId
            ? `${clientId}/reports/${id}.pdf`
            : `reports/${id}.pdf`;
        }
      } catch {
        // If the table doesn’t exist in this env, use generic fallback path
        storagePath = `reports/${id}.pdf`;
      }

      // Generate a short-lived signed URL and redirect
      const { data: signed, error } = await supabase.storage
        .from(bucket)
        .createSignedUrl(storagePath, 60);

      if (error || !signed?.signedUrl) {
        console.error('[GET /reports/:id/download] storage error', error || 'no url');
        return res.status(404).send('Report not found');
      }

      return res.redirect(302, signed.signedUrl);
    } catch (e) {
      console.error('[GET /reports/:id/download] unexpected', e);
      return res.status(500).send('Server error');
    }
  });

  return router;
};
