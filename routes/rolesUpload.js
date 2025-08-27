// routes/rolesUpload.js
'use strict';

const express = require('express');
const multer = require('multer');
const path = require('path');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
}
const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const KB_BUCKET = process.env.SUPABASE_KB_BUCKET || 'kbs';

const router = express.Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 }, // 20MB
  fileFilter: (_req, file, cb) => {
    const okExt = ['.pdf', '.doc', '.docx'];
    const ext = path.extname(file.originalname || '').toLowerCase();
    if (!okExt.includes(ext)) return cb(new Error('Only pdf/doc/docx allowed'));
    cb(null, true);
  },
});

function okContentType(filename) {
  const ext = path.extname(filename || '').toLowerCase();
  if (ext === '.pdf') return 'application/pdf';
  if (ext === '.doc') return 'application/msword';
  if (ext === '.docx') {
    return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  }
  return 'application/octet-stream';
}

function slug(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9\-_.]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * POST /roles/upload-jd?client_id=...&role_id=...(optional)
 * FormData: file
 */
router.post('/upload-jd', upload.single('file'), async (req, res) => {
  try {
    // auth + scope middlewares mounted at app level
    const uid = req.user?.id;
    if (!uid) return res.status(401).json({ error: 'Unauthorized' });

    const client_id = req.query.client_id || req.body.client_id;
    if (!client_id) return res.status(400).json({ error: 'Missing client_id' });

    const scope = Array.isArray(req.client_memberships) ? req.client_memberships : (req.clientIds || []);
    if (!scope.includes(client_id)) return res.status(403).json({ error: 'Forbidden' });

    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const { originalname, buffer } = req.file;
    const ext = path.extname(originalname || '').toLowerCase();
    const ctype = okContentType(originalname);
    const rolePart = req.query.role_id ? `${req.query.role_id}/` : '';
    const namePart = slug(path.basename(originalname, ext));
    const key = `${client_id}/${rolePart}${Date.now()}_${crypto.randomBytes(4).toString('hex')}_${namePart}${ext}`;

    const { data, error } = await supabaseAdmin
      .storage
      .from(KB_BUCKET)
      .upload(key, buffer, { contentType: ctype, upsert: true });

    if (error) return res.status(500).json({ error: error.message });

    // Return a stable "bucket/path" string for storing on roles.meta
    return res.json({
      ok: true,
      bucket: KB_BUCKET,
      path_in_bucket: key,
      storage_path: `${KB_BUCKET}/${key}`,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
