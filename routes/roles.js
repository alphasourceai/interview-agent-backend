const express = require('express');
const router = express.Router();
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');

const auth = require('../middleware/auth');
const { supabase } = require('../supabase');

const KB_BUCKET = process.env.SUPABASE_KB_BUCKET || 'kbs';

// --- list roles (unchanged behavior) ---
router.get('/', auth, async (req, res) => {
  const clientId = req.query.client_id;
  if (!clientId) return res.status(400).json({ error: 'client_id is required' });

  const { data, error } = await supabase
    .from('roles')
    .select('*')
    .eq('client_id', clientId)
    .order('created_at', { ascending: false });

  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

// --- create role (reuses jd_path if you pass it from the FE) ---
router.post('/', auth, express.json(), async (req, res) => {
  const { client_id, title, interview_type, manual_questions, jd_path } = req.body;
  if (!client_id || !title) return res.status(400).json({ error: 'client_id and title are required' });

  const insert = {
    client_id,
    title,
    interview_type: interview_type || 'basic',
    manual_questions: manual_questions || null,
    jd_path: jd_path || null
  };

  const { data, error } = await supabase.from('roles').insert(insert).select('*').single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// --- JD upload: now allows PDF/DOC/DOCX/TXT ---
const storage = multer.memoryStorage();
const ALLOW = new Set([
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'text/plain'
]);
const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
  fileFilter: (req, file, cb) => {
    if (ALLOW.has(file.mimetype)) return cb(null, true);
    return cb(new Error(`Upload failed: mime type ${file.mimetype} is not supported`));
  }
});

router.post('/upload-jd', auth, upload.single('jd'), async (req, res) => {
  try {
    const clientId = req.query.client_id;
    if (!clientId) return res.status(400).json({ error: 'client_id is required' });
    if (!req.file) return res.status(400).json({ error: 'file is required' });

    // keep original extension if present
    const original = req.file.originalname || 'job-description';
    const ext = (original.includes('.') ? original.split('.').pop() : 'bin').toLowerCase();
    const key = `roles/${clientId}/${uuidv4()}.${ext}`;

    const { error: upErr } = await supabase
      .storage
      .from(KB_BUCKET)
      .upload(key, req.file.buffer, { contentType: req.file.mimetype, upsert: true });

    if (upErr) return res.status(500).json({ error: upErr.message });

    // respond with the storage location so FE can set jd_path on /roles POST
    res.json({ bucket: KB_BUCKET, path: key, mime: req.file.mimetype, size: req.file.size });
  } catch (e) {
    return res.status(500).json({ error: e.message || 'Upload failed' });
  }
});

module.exports = router;
