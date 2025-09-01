// routes/files.js
// Factory-style router; ctx provided by app.js
// ctx: { supabase, auth, withClientScope }

const express = require('express');

function parseBucketPath(value) {
  if (!value || typeof value !== 'string') return null;
  const v = value.trim();

  // New/desired format: "bucket/path..."
  if (!/^https?:\/\//i.test(v)) {
    const firstSlash = v.indexOf('/');
    if (firstSlash > 0) {
      return { bucket: v.slice(0, firstSlash), path: v.slice(firstSlash + 1) };
    }
    return null;
  }

  // Old format: public or signed URL
  try {
    const u = new URL(v);
    const parts = u.pathname.split('/').filter(Boolean);
    // ["storage","v1","object","public|sign", "<bucket>", "...path..."]
    const idx = parts.findIndex(p => p === 'public' || p === 'sign');
    if (idx >= 0 && parts[idx + 1]) {
      const bucket = parts[idx + 1];
      const path = parts.slice(idx + 2).join('/');
      if (bucket && path) return { bucket, path };
    }
  } catch (_) {
    // ignore
  }
  return null;
}

module.exports = function makeFilesRouter({ supabase, auth, withClientScope }) {
  const router = express.Router();

  /**
   * GET /files/signed-url?interview_id=...&kind=transcript|analysis
   *
   * Returns a signed URL for the requested storage object, after enforcing:
   *  - caller is authenticated
   *  - caller has scope for the interview's client_id
   */
  router.get('/signed-url', auth, withClientScope, async (req, res) => {
    try {
      const { interview_id, kind } = req.query;
      if (!interview_id || !kind) {
        return res.status(400).json({ error: 'interview_id and kind are required' });
      }
      if (!['transcript', 'analysis'].includes(kind)) {
        return res.status(400).json({ error: 'kind must be transcript|analysis' });
      }

      // Load interview
      const { data: interview, error } = await supabase
        .from('interviews')
        .select('id, client_id, transcript_url, analysis_url')
        .eq('id', interview_id)
        .maybeSingle();

      if (error) return res.status(400).json({ error: error.message });
      if (!interview) return res.status(404).json({ error: 'Interview not found' });

      // Enforce scope:
      // Prefer explicit membership array if present; else allow if the single scoped client matches.
      const scopeIds = Array.isArray(req.clientIds) ? req.clientIds : [];
      const scopedClientId = req.client?.id || null;
      const allowed =
        (scopeIds.length && scopeIds.includes(interview.client_id)) ||
        (scopedClientId && scopedClientId === interview.client_id);

      if (!allowed) return res.status(403).json({ error: 'Forbidden' });

      // Grab the storage location from the interview
      const raw = kind === 'transcript' ? interview.transcript_url : interview.analysis_url;
      if (!raw) return res.status(404).json({ error: `${kind} not available` });

      const parsed = parseBucketPath(raw);
      if (!parsed) {
        // If it already looks like a full URL (legacy public/signed), return it
        if (/^https?:\/\//i.test(raw)) return res.json({ ok: true, url: raw, mode: 'legacy_url' });
        return res.status(400).json({ error: 'Unrecognized storage path/URL' });
      }

      const EXPIRES = Number(process.env.SIGNED_URL_TTL_SECONDS || 300);

      // Use the shared server-side Supabase client from app.js (service role)
      const { data: signed, error: signErr } = await supabase
        .storage
        .from(parsed.bucket)
        .createSignedUrl(parsed.path, EXPIRES);

      if (signErr) return res.status(400).json({ error: signErr.message });

      return res.json({
        ok: true,
        url: signed?.signedUrl,
        mode: 'signed',
        bucket: parsed.bucket,
      });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  });

  return router;
};
