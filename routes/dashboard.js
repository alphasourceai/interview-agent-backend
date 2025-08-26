// routes/dashboard.js
const express = require('express');
const { createClient } = require('@supabase/supabase-js');

const router = express.Router();
router.use(express.json());

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

// GET /dashboard/interviews?client_id=...
router.get('/interviews', async (req, res) => {
  try {
    const cid = req.query.client_id;
    if (!cid) return res.status(400).json({ error: 'client_id required' });

    // Require client scope derived by middleware in app.js
    if (!Array.isArray(req.clientIds) || !req.clientIds.includes(cid)) {
      return res.status(403).json({ error: 'No client scope' });
    }

    // Be robust to schema drift: select * and filter client_id/client_id_uuid in code
    const { data, error } = await supabase.from('candidates').select('*');
    if (error) return res.status(400).json({ error: error.message });

    const list = (data || []).filter(
      (r) => (r.client_id ?? r.client_id_uuid) === cid
    );

    // Shape for FE table (gracefully handle missing fields)
    const rows = list.map(r => ({
      id: r.id,
      name: r.name || r.full_name || '—',
      email: r.email || '—',
      role: r.role_title || r.role || '—',
      resume: r.resume_path || r.resume_url || null,
      interview: r.interview_status || r.interview || null,
      overall: r.overall_score ?? r.score ?? null,
      created_at: r.created_at || null,
    }));

    res.json({ candidates: rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
