// routes/roles.js
const router = require('express').Router();
const multer = require('multer');
const { requireAuth, withClientScope, supabase } = require('../middleware/auth');
const { parseBufferToText } = require('../utils/jdParser');

const upload = multer({
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
});

const JD_MIME_ALLOW = new Set([
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
]);

// List roles (stable)
router.get('/', requireAuth, withClientScope, async (req, res) => {
  const { data, error } = await supabase
    .from('roles')
    .select('id, title, interview_type, created_at')
    .eq('client_id', req.client.id)
    .order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: 'Failed to load roles' });
  res.json(data);
});

// Create role (stable)
router.post('/', requireAuth, withClientScope, async (req, res) => {
  const { title, interview_type } = req.body || {};
  if (!title) return res.status(400).json({ error: 'title required' });

  const { data, error } = await supabase
    .from('roles')
    .insert({ client_id: req.client.id, title, interview_type })
    .select('id')
    .single();

  if (error) return res.status(500).json({ error: 'Failed to create role' });
  res.json({ id: data.id });
});

/**
 * POST /roles/upload-jd?client_id=...&role_id=...
 * multipart/form-data: file
 * Parses PDF/DOCX → saves original file to kbs/, saves a .txt next to it. Returns paths + parsed text.
 */
router.post('/upload-jd', requireAuth, withClientScope, upload.single('file'), async (req, res) => {
  try {
    const roleId = req.query.role_id || req.body?.role_id;
    if (!roleId) return res.status(400).json({ error: 'role_id is required' });
    if (!req.file) return res.status(400).json({ error: 'file is required' });

    const { originalname, mimetype, buffer } = req.file;
    if (!JD_MIME_ALLOW.has(mimetype)) {
      return res.status(415).json({ error: 'Only PDF or DOCX are supported for now' });
    }

    // Parse to text
    const text = await parseBufferToText(buffer, mimetype, originalname);

    // Store original
    const base = `kbs/${req.client.id}/${roleId}/jd/${Date.now()}-${originalname}`;
    const { error: upErr1 } = await supabase.storage.from(process.env.SUPABASE_KB_BUCKET || 'kbs').upload(base, buffer, {
      contentType: mimetype,
      upsert: false
    });
    if (upErr1) return res.status(500).json({ error: 'Failed to store JD file' });

    // Store .txt alongside
    const txtPath = base.replace(/\.[^.]+$/, '') + '.txt';
    const { error: upErr2 } = await supabase.storage.from(process.env.SUPABASE_KB_BUCKET || 'kbs')
      .upload(txtPath, Buffer.from(text, 'utf8'), { contentType: 'text/plain', upsert: true });
    if (upErr2) return res.status(500).json({ error: 'Failed to store JD text' });

    // Persist reference on role if jd_path column exists, otherwise just return payload.
    let jdSaved = false;
    try {
      const upd = await supabase.from('roles').update({ jd_path: base }).eq('id', roleId);
      if (!upd.error) jdSaved = true;
    } catch (_) {}

    // Try to persist jd_text if column exists
    try {
      const upd2 = await supabase.from('roles').update({ jd_text: text }).eq('id', roleId);
      if (!upd2.error) jdSaved = true;
    } catch (_) {}

    return res.json({
      ok: true,
      role_id: roleId,
      path: base,
      text_path: txtPath,
      mime: mimetype,
      size_bytes: buffer.length,
      parsed_text_preview: text.slice(0, 1200)
    });
  } catch (e) {
    const status = e.status || 500;
    return res.status(status).json({ error: e.message || 'JD upload failed' });
  }
});

module.exports = router;
