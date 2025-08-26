// routes/rolesUpload.js
const express = require('express');
const multer = require('multer');
const path = require('path');
const { randomUUID } = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

function sanitize(name) { return String(name || 'file').replace(/[^\w.\-]+/g, '_'); }

router.post('/upload-jd', upload.single('file'), async (req, res) => {
  try {
    const clientId = req.query.client_id;
    if (!clientId) return res.status(400).json({ error: 'client_id required' });
    if (!Array.isArray(req.clientIds) || !req.clientIds.includes(clientId)) {
      return res.status(403).json({ error: 'No client scope' });
    }
    if (!req.file) return res.status(400).json({ error: 'file required' });

    const bucket = process.env.SUPABASE_KB_BUCKET || 'kbs';
    const ext = path.extname(req.file.originalname || '').toLowerCase();
    const base = sanitize(path.basename(req.file.originalname || `jd${ext || ''}`));
    const key = `jd/${clientId}/${Date.now()}_${randomUUID()}_${base}`;

    const { error } = await supabase.storage.from(bucket).upload(key, req.file.buffer, {
      contentType: req.file.mimetype || 'application/octet-stream',
      upsert: true,
    });
    if (error) {
      console.error('JD upload error:', error.message);
      const msg = /Bucket not found/i.test(error.message) ? 'Bucket not found. Check SUPABASE_KB_BUCKET.' : error.message;
      return res.status(500).json({ error: `Upload failed: ${msg}` });
    }

    res.json({ bucket, path: key, original_name: req.file.originalname, mime_type: req.file.mimetype, size: req.file.size });
  } catch (e) {
    console.error('JD upload exception:', e);
    res.status(500).json({ error: 'Upload failed' });
  }
});

module.exports = router;
