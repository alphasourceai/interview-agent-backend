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

function ensureScope(req, res, next) {
  if (!Array.isArray(req.client_memberships)) req.client_memberships = [];
  next();
}

// GET /roles?client_id=...
router.get('/', ensureScope, async (req, res) => {
  const cid = req.query.client_id;
  if (!cid) return res.status(400).json({ error: 'client_id required' });
  if (!req.client_memberships.includes(cid)) return res.status(403).json({ error: 'No client scope' });

  const { data, error } = await supabase
    .from('roles')
    .select('id, title, interview_type, created_at')
    .eq('client_id', cid)
    .order('created_at', { ascending: false });

  if (error) return res.status(400).json({ error: error.message });
  res.json({ roles: data || [] });
});

// POST /roles
router.post('/', ensureScope, async (req, res) => {
  const { client_id, title, interview_type, jd_bucket, jd_path, manual_questions } = req.body || {};
  if (!client_id || !title || !interview_type) {
    return res.status(400).json({ error: 'client_id, title, interview_type required' });
  }
  if (!req.client_memberships.includes(client_id)) return res.status(403).json({ error: 'No client scope' });

  const { data, error } = await supabase
    .from('roles')
    .insert({
      client_id,
      title,
      interview_type,
      jd_bucket: jd_bucket || null,
      jd_path: jd_path || null,
      manual_questions: manual_questions || null,
    })
    .select('*')
    .single();

  if (error) return res.status(400).json({ error: error.message });
  res.json({ role: data });
});

module.exports = router;
