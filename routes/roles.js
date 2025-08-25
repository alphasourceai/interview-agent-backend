// routes/roles.js
const express = require('express');
const { createClient } = require('@supabase/supabase-js');

const router = express.Router();
router.use(express.json());

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

function ensureScope(req, _res, next) {
  if (!Array.isArray(req.client_memberships)) {
    const ids = Array.isArray(req.memberships) ? req.memberships.map(m => m.client_id) : (req.clientIds || []);
    req.client_memberships = ids;
  }
  next();
}

// GET /roles?client_id=...
router.get('/', ensureScope, async (req, res) => {
  try {
    const clientId = req.query.client_id;
    if (!clientId) return res.status(400).json({ error: 'client_id required' });
    if (!req.client_memberships.includes(clientId)) return res.status(403).json({ error: 'No client scope' });

    const { data, error } = await supabase
      .from('roles')
      .select('id, title, interview_type, created_at')
      .eq('client_id', clientId)
      .order('created_at', { ascending: false });

    if (error) return res.status(400).json({ error: error.message });
    res.json({ roles: (data || []) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /roles
// body: { client_id, title, interview_type, jd_bucket?, jd_path?, manual_questions? }
router.post('/', ensureScope, async (req, res) => {
  try {
    const { client_id, title, interview_type, jd_bucket, jd_path, manual_questions } = req.body || {};
    if (!client_id || !title || !interview_type) {
      return res.status(400).json({ error: 'client_id, title, interview_type required' });
    }
    if (!req.client_memberships.includes(client_id)) return res.status(403).json({ error: 'No client scope' });

    const payload = {
      client_id,
      title: (title || '').toString().trim(),
      interview_type: (interview_type || '').toString().trim(),
      jd_bucket: jd_bucket || null,
      jd_path: jd_path || null,
      manual_questions: manual_questions || null,
    };

    const { data, error } = await supabase
      .from('roles')
      .insert(payload)
      .select('*')
      .single();

    if (error) return res.status(400).json({ error: error.message });
    res.json({ role: data });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
