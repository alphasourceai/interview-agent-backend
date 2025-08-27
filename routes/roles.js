// routes/roles.js
const express = require('express');
const multer = require('multer');
const { createClient } = require('@supabase/supabase-js');

const router = express.Router();

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const BUCKET = process.env.SUPABASE_KB_BUCKET || 'jd';

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

// -------------------------------
// helpers
// -------------------------------
function ensureClientScope(req, res) {
  const clientId = req.query.client_id || req.body.client_id;
  if (!clientId) {
    res.status(400).json({ error: 'client_id required' });
    return null;
  }
  const allowed = (req.clientIds || []).includes(clientId);
  if (!allowed) {
    res.status(403).json({ error: 'No client scope' });
    return null;
  }
  return clientId;
}

function sanitizeFilename(name) {
  return (name || 'file')
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .slice(0, 120);
}

const ALLOWED_MIME = new Set([
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
]);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
  fileFilter: (_req, file, cb) => {
    if (ALLOWED_MIME.has(file.mimetype)) return cb(null, true);
    cb(new Error(`Upload failed: mime type ${file.mimetype} is not supported`));
  },
});

// -------------------------------
// GET /roles?client_id=...
// -------------------------------
router.get('/', async (req, res) => {
  const clientId = ensureClientScope(req, res);
  if (!clientId) return;

  const { data, error } = await supabase
    .from('roles')
    .select('id, title, interview_type, created_at')
    .eq('client_id', clientId)
    .order('created_at', { ascending: false });

  if (error) {
    console.error('[roles] list error', error);
    return res.status(500).json({ error: 'query failed' });
  }
  res.json({ items: data || [] });
});

// -------------------------------
// POST /roles  (create role)
// body: { client_id, title, interview_type, jd_url?, manual_questions? }
// NOTE: we insert defensively and retry with a minimal column set if schema differs
// -------------------------------
router.post('/', express.json(), async (req, res) => {
  const clientId = ensureClientScope(req, res);
  if (!clientId) return;

  const { title, interview_type, jd_url, manual_questions } = req.body || {};
  if (!title) return res.status(400).json({ error: 'title required' });

  // try with richer columns first
  const attempts = [
    { client_id: clientId, title, interview_type, jd_url, manual_questions },
    { client_id: clientId, title, interview_type, jd_url },
    { client_id: clientId, title, interview_type },
    { client_id: clientId, title },
  ];

  for (const row of attempts) {
    // remove undefined keys
    Object.keys(row).forEach(k => row[k] === undefined && delete row[k]);

    const { data, error } = await supabase.from('roles').insert(row).select().limit(1).maybeSingle();
    if (!error && data) return res.status(201).json({ role: data });

    // if the error is a column-not-found, continue to next attempt
    const msg = (error && (error.message || error.toString())) || '';
    const isSchemaMismatch = /column .* does not exist|invalid input/i.test(msg);
    if (!isSchemaMismatch) {
      console.error('[roles] create error', error);
      return res.status(500).json({ error: 'create failed' });
    }
  }

  // if we got here, we could not find a compatible column set
  return res.status(500).json({ error: 'create failed (schema mismatch)' });
});

// -------------------------------
// POST /roles/upload-jd?client_id=...  (multipart, field: file)
// returns: { path, signed_url, mime, size }
// -------------------------------
router.post('/upload-jd', upload.single('file'), async (req, res) => {
  const clientId = ensureClientScope(req, res);
  if (!clientId) return;

  if (!req.file) return res.status(400).json({ error: 'file required' });

  const { originalname, mimetype, buffer, size } = req.file;
  const ts = Date.now();
  const fname = sanitizeFilename(originalname);
  const path = `roles/${clientId}/${ts}-${fname}`;

  // upload to Supabase Storage
  const { error: upErr } = await supabase
    .storage
    .from(BUCKET)
    .upload(path, buffer, { contentType: mimetype, upsert: true });

  if (upErr) {
    console.error('[roles] upload error', upErr);
    return res.status(500).json({ error: upErr.message || 'upload failed' });
  }

  // create a 7-day signed URL (works even if bucket is private)
  const { data: signed, error: signErr } = await supabase
    .storage
    .from(BUCKET)
    .createSignedUrl(path, 60 * 60 * 24 * 7);

  if (signErr) {
    console.error('[roles] signed url error', signErr);
    return res.status(500).json({ error: 'could not sign url', path });
  }

  res.json({
    path,
    signed_url: signed?.signedUrl,
    mime: mimetype,
    size,
  });
});

module.exports = router;
