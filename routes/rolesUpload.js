// routes/rolesUpload.js
'use strict';

const express = require('express');
const multer = require('multer');
const path = require('path');
const crypto = require('crypto');

const { supabaseAdmin } = require('../src/lib/supabaseClient');
const { parseBufferToText } = require('../utils/jdParser');

const JD_BUCKET = process.env.SUPABASE_JD_BUCKET || 'job-descriptions';

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 }, // 20MB
  fileFilter: (_req, file, cb) => {
    const okExt = ['.pdf', '.docx']; // parser supports pdf/docx
    const ext = path.extname(file.originalname || '').toLowerCase();
    if (!okExt.includes(ext)) return cb(new Error('Only PDF or DOCX allowed'));
    cb(null, true);
  },
});

function okContentType(filename) {
  const ext = path.extname(filename || '').toLowerCase();
  if (ext === '.pdf') return 'application/pdf';
  if (ext === '.docx') return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  return 'application/octet-stream';
}

/**
 * POST /roles-upload/upload-jd?client_id=...&role_id=...
 * FormData: file
 *
 * NOTE: app.js wraps this router with requireAuth + withClientScope.
 * Side effects:
 *  - Uploads JD file to JD_BUCKET
 *  - Parses text (pdf/docx)
 *  - Updates role: job_description_url, description
 * Returns: { ok, role }
 */
router.post('/upload-jd', upload.single('file'), async (req, res) => {
  try {
    const client_id = req.query.client_id || req.body.client_id || null;
    const role_id = req.query.role_id || req.body.role_id || null;
    if (!client_id) return res.status(400).json({ error: 'Missing client_id' });
    if (!role_id) return res.status(400).json({ error: 'Missing role_id' });

    // Scope check: withClientScope added by app.js sets req.clientIds
    const scopedIds = Array.isArray(req.clientIds) ? req.clientIds : [];
    if (!scopedIds.includes(client_id)) return res.status(403).json({ error: 'Forbidden' });

    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const { originalname, buffer } = req.file;
    const ext = path.extname(originalname || '').toLowerCase();
    const contentType = okContentType(originalname);

    // Upload JD file to storage (no bucket prefix in key)
    const objectKey = `${client_id}/${role_id}/${Date.now()}_${crypto.randomBytes(4).toString('hex')}${ext}`;
    const up = await supabaseAdmin.storage
      .from(JD_BUCKET)
      .upload(objectKey, buffer, { contentType, upsert: true });

    if (up.error) {
      console.error('[upload-jd] storage upload error:', up.error.message);
      return res.status(500).json({ error: 'JD upload failed', detail: up.error.message });
    }

    const job_description_url = `${JD_BUCKET}/${objectKey}`;

    // Parse JD text to populate roles.description (best-effort)
    let parsedText = '';
    try {
      parsedText = await parseBufferToText(buffer, contentType, originalname);
    } catch (e) {
      console.error('[upload-jd] parse failed:', e?.message || e);
    }

    const updates = { job_description_url };
    if (parsedText) updates.description = parsedText.slice(0, 15000);

    const { data: updated, error: updErr } = await supabaseAdmin
      .from('roles')
      .update(updates)
      .eq('id', role_id)
      .select('id,title,client_id,slug_or_token,interview_type,job_description_url,description,rubric,kb_document_id,created_at')
      .single();

    if (updErr) {
      console.error('[upload-jd] role update error:', updErr.message);
      return res.status(500).json({ error: 'Role update failed', detail: updErr.message });
    }

    return res.json({ ok: true, role: updated });
  } catch (e) {
    console.error('[upload-jd] unexpected:', e?.message || e);
    return res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
