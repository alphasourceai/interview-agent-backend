'use strict';

const express = require('express');
const multer = require('multer');
const path = require('path');
const crypto = require('crypto');

const { supabase } = require('../src/lib/supabaseClient');
const { requireAuth, withClientScope } = require('../src/middleware/auth');
const { parseBufferToText } = require('../utils/jdParser');

const JD_BUCKET = process.env.SUPABASE_JD_BUCKET || 'job-descriptions';
const KB_BUCKET = process.env.SUPABASE_KB_BUCKET || 'kbs';

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

function makeId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return `${Date.now().toString(36)}-${crypto.randomBytes(8).toString('hex')}`;
}

function buildBaselineQuestions(text = '') {
  // Extremely light heuristic fallback; mirrors your prior "auto" style.
  const base = [
    "Can you describe a time when you collaborated cross-functionally to deliver a feature? What was your role and the outcome?",
    "How do you ensure code is clean, well-documented, and testable?",
    "Tell me about troubleshooting or optimizing performance. What steps did you take and what was the result?",
    "How have you contributed to continuous improvement of dev processes and tools?",
    "Describe a project using Python, Java, or C++. What did you build and what was your impact?",
    "How do you stay current with emerging technologies, and where have you proposed innovative solutions?"
  ];
  // If the text is long, we just stick with the standard set (keeps behavior predictable).
  return base.map(q => ({ text: q, category: 'auto' }));
}

/**
 * POST /roles-upload/upload-jd?client_id=...&role_id=...(optional)
 * FormData: file
 *
 * AuthZ: user must be authenticated and a member of client_id.
 * Side effects:
 *  - Uploads JD file to JD_BUCKET
 *  - Parses text (pdf/docx)
 *  - Creates a baseline rubric/questions JSON and uploads to KB_BUCKET
 *  - Updates role: job_description_url, description, rubric, kb_document_id
 * Returns: { ok, role, job_description_url, kb_document_id }
 */
router.post('/upload-jd', requireAuth, withClientScope, upload.single('file'), async (req, res) => {
  try {
    const uid = req.user?.id;
    if (!uid) return res.status(401).json({ error: 'Unauthorized' });

    const client_id = req.query.client_id || req.body.client_id || null;
    const role_id = req.query.role_id || req.body.role_id || null;
    if (!client_id) return res.status(400).json({ error: 'Missing client_id' });

    // Scope check: withClientScope (as used in app.js) sets req.clientIds
    const scopedIds = Array.isArray(req.clientIds) ? req.clientIds : [];
    if (!scopedIds.includes(client_id)) return res.status(403).json({ error: 'Forbidden' });

    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const { originalname, buffer } = req.file;
    const ext = path.extname(originalname || '').toLowerCase();
    const ctype = okContentType(originalname);

    // 1) Upload JD file to storage
    const rolePart = role_id ? `${role_id}/` : '';
    const key = `${client_id}/${rolePart}${Date.now()}_${crypto.randomBytes(4).toString('hex')}${ext}`;

    const up = await supabase.storage.from(JD_BUCKET).upload(key, buffer, {
      contentType: ctype,
      upsert: true
    });
    if (up.error) {
      console.error('[upload-jd] storage upload error:', up.error.message);
      return res.status(500).json({ error: 'JD upload failed', detail: up.error.message });
    }
    const jdStoragePath = `${JD_BUCKET}/${key}`;

    // 2) Parse JD text
    let parsedText = '';
    try {
      parsedText = await parseBufferToText(buffer, ctype, originalname);
    } catch (e) {
      // Non-fatal: we still save the JD and proceed with generic questions
      console.error('[upload-jd] parse failed:', e?.message || e);
    }

    // 3) Build a baseline questions rubric JSON
    const questions = makeBaselineQuestions(parsedText);
    const rubric = { questions };

    // 4) Save KB JSON into KB bucket; use a stable doc id
    const kbId = makeId();
    const kbObjectPath = `${kbId}.json`;
    const kbUpload = await supabase.storage.from(KB_BUCKET).upload(
      kbObjectPath,
      Buffer.from(JSON.stringify(rubric, null, 2)),
      { contentType: 'application/json', upsert: true }
    );
    if (kbUpload.error) {
      console.error('[upload-jd] KB upload error:', kbUpload.error.message);
      // Non-fatal; continue without kb_document_id
    }

    // 5) Update the role if provided
    let updatedRole = null;
    if (role_id) {
      const updates = {
        job_description_url: jdStoragePath
      };
      if (parsedText) updates.description = parsedText.slice(0, 15000);
      if (questions?.length) updates.rubric = rubric;
      if (!kbUpload.error) updates.kb_document_id = kbId;

      const u = await supabase
        .from('roles')
        .update(updates)
        .eq('id', role_id)
        .select('id,title,client_id,slug_or_token,interview_type,job_description_url,description,rubric,kb_document_id,created_at')
        .single();

      if (u.error) {
        console.error('[upload-jd] role update error:', u.error.message);
      } else {
        updatedRole = u.data;
      }
    }

    return res.json({
      ok: true,
      role: updatedRole,
      job_description_url: jdStoragePath,
      kb_document_id: !kbUpload.error ? kbId : null
    });
  } catch (e) {
    console.error('[upload-jd] unexpected:', e?.message || e);
    return res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
