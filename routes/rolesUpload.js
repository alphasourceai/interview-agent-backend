// routes/rolesUpload.js
'use strict';

const express = require('express');
const multer = require('multer');
const path = require('path');
const crypto = require('crypto');

const { supabase } = require('../src/lib/supabaseClient');
const { requireAuth, withClientScope } = require('../src/middleware/auth');

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
  if (ext === '.docx') return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  return 'application/octet-stream';
}

function slug(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9\-_.]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

// Collect scoped client IDs from our standardized middleware
function getScopedClientIds(req) {
  const fromScope = Array.isArray(req?.clientScope?.memberships)
    ? req.clientScope.memberships.map(m => m.client_id).filter(Boolean)
    : [];
  const legacy = req.client?.id ? [req.client.id] : [];
  return Array.from(new Set([...fromScope, ...legacy]));
}

/**
 * POST /roles-upload/upload-jd?client_id=...&role_id=...(optional)
 * FormData: file
 *
 * AuthZ: user must be authenticated and have scope to client_id.
 */
router.post('/upload-jd', requireAuth, withClientScope, upload.single('file'), async (req, res) => {
  try {
    const uid = req.user?.id;
    if (!uid) return res.status(401).json({ error: 'Unauthorized' });

    const client_id =
      req.query.client_id ||
      req.body.client_id ||
      req.clientScope?.defaultClientId ||
      req.client?.id ||
      null;

    if (!client_id) return res.status(400).json({ error: 'Missing client_id' });

    // Scope enforcement using standardized scope
    const scopedIds = getScopedClientIds(req);
    if (!scopedIds.includes(client_id)) return res.status(403).json({ error: 'Forbidden' });

    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const { originalname, buffer } = req.file;
    const ext = path.extname(originalname || '').toLowerCase();
    const ctype = okContentType(originalname);

    const rolePart = req.query.role_id ? `${req.query.role_id}/` : '';
    const namePart = slug(path.basename(originalname, ext));
    const key = `${client_id}/${rolePart}${Date.now()}_${crypto.randomBytes(4).toString('hex')}_${namePart}${ext}`;

    const { error } = await supabase
      .storage
      .from(KB_BUCKET)
      .upload(key, buffer, { contentType: ctype, upsert: true });

    if (error) return res.status(500).json({ error: error.message });

    // Return a stable "bucket/path" string to store on the role
    return res.json({
      ok: true,
      bucket: KB_BUCKET,
      path_in_bucket: key,
      storage_path: `${KB_BUCKET}/${key}`,
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

module.exports = router;
