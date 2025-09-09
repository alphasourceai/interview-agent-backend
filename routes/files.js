// routes/files.js
const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const { requireAuth, withClientScope } = require('../src/middleware/auth');

const router = express.Router();

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
}
const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

// Accepts either "bucket/path" or a Supabase Storage URL
function parseBucketPath(v) {
  if (!v || typeof v !== 'string') return null;
  const s = v.trim();
  if (!/^https?:\/\//i.test(s)) {
    const i = s.indexOf('/');
    return i > 0 ? { bucket: s.slice(0, i), path: s.slice(i + 1) } : null;
  }
  try {
    const u = new URL(s);
    const parts = u.pathname.split('/').filter(Boolean);
    const idx = parts.findIndex(p => p === 'public' || p === 'sign');
    if (idx >= 0 && parts[idx + 1]) {
      const bucket = parts[idx + 1];
      const path = parts.slice(idx + 2).join('/');
      if (bucket && path) return { bucket, path };
    }
  } catch {}
  return null;
}

router.get('/signed-url', requireAuth, withClientScope, async (req, res) => {
  try {
    const { interview_id, kind } = req.query;
    if (!interview_id || !kind) return res.status(400).json({ error: 'interview_id and kind are required' });
    if (!['transcript', 'analysis'].includes(kind)) return res.status(400).json({ error: 'kind must be transcript|analysis' });

    const scopedIds = Array.isArray(req?.clientScope?.memberships)
      ? req.clientScope.memberships.map(m => m.client_id)
      : [];
    if (!scopedIds.length) return res.status(403).json({ error: 'No client scope' });

    const { data: interview, error } = await supabaseAdmin
      .from('interviews')
      .select('id, client_id, transcript_url, analysis_url')
      .eq('id', interview_id)
      .maybeSingle();

    if (error) return res.status(400).json({ error: error.message });
    if (!interview) return res.status(404).json({ error: 'Interview not found' });
    if (!scopedIds.includes(interview.client_id)) return res.status(403).json({ error: 'Forbidden' });

    const raw = kind === 'transcript' ? interview.transcript_url : interview.analysis_url;
    if (!raw) return res.status(404).json({ error: `${kind} not available` });

    const parsed = parseBucketPath(raw);
    if (!parsed) {
      if (/^https?:\/\//i.test(raw)) return res.json({ ok: true, url: raw, mode: 'legacy_url' });
      return res.status(400).json({ error: 'Unrecognized storage path/URL' });
    }

    const EXPIRES = Number(process.env.SIGNED_URL_TTL_SECONDS || 300);
    const { data: signed, error: signErr } = await supabaseAdmin
      .storage
      .from(parsed.bucket)
      .createSignedUrl(parsed.path, EXPIRES);

    if (signErr) return res.status(400).json({ error: signErr.message });
    return res.json({ ok: true, url: signed?.signedUrl, mode: 'signed', bucket: parsed.bucket });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
