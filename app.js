// app.js
require('dotenv').config();
const express = require('express');
const cors = require('cors');

const { handleResumeUpload } = require('./handlers/resumeUpload');
const { handleTavusWebhook } = require('./handlers/tavusWebhook');
const createTavusInterviewHandler = require('./handlers/createTavusInterview');

const candidateRoutes = require('./routes/candidates');
const reportRoutes = require('./routes/reports');
const createRoleRoute = require('./routes/createRole');

// Candidate flow routes
const candidateSubmitRoute = require('./routes/candidateSubmit');
const verifyOtpRoute = require('./routes/verifyOtp');

// (Optional) fetch role info so Tavus gets a role-based script
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const app = express();

// Basic CORS; tighten with env if you like (CORS_ORIGINS)
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.get('/', (_req, res) => res.send('Interview Agent Backend Running'));
app.get('/health', (_req, res) => res.status(200).json({ ok: true }));

// Upload + Webhook
app.post('/upload-resume', handleResumeUpload);
app.post('/webhook/recording-ready', handleTavusWebhook);

// --- Tavus creation ---
// NOTE: Our handler now returns { conversation_url, conversation_id }.
// We normalize to a string URL so the frontend can redirect.
app.post('/create-tavus-interview', async (req, res) => {
  try {
    const { candidate_id, name, email, role_id } = req.body;

    if (!candidate_id || !email || !role_id) {
      return res.status(400).json({ error: 'Missing candidate_id, email, or role_id.' });
    }

    const candidate = { id: candidate_id, name, email, role_id };

    // (Optional) pull the role so createTavusInterview can build a role-based script
    let role = null;
    try {
      const { data: roleData, error: roleErr } = await supabase
        .from('roles')
        .select('id, title, description, interview_type, rubric')
        .eq('id', role_id)
        .single();
      if (!roleErr && roleData) role = roleData;
    } catch (_) {
      // non-fatal if role fetch fails; Tavus will still create with persona defaults
    }

    const result = await createTavusInterviewHandler(candidate, role);

    const conversation_url =
      (result && (result.conversation_url || result.url || result.link)) || null;

    if (!conversation_url) {
      // Graceful response so UI can retry without breaking flow
      return res.status(200).json({
        message: 'Tavus interview created but no link was returned yet.',
        conversation_id: result?.conversation_id || null
      });
    }

    // ✅ Return a string so the frontend can redirect safely
    return res.status(200).json({
      message: 'Tavus interview created',
      video_url: conversation_url
    });
  } catch (err) {
    console.error('Error creating Tavus interview:', err);
    return res.status(500).json({ error: 'Failed to create Tavus interview' });
  }
});

// Data routes
app.use('/candidates', candidateRoutes);
app.use('/reports', reportRoutes);
app.use('/create-role', createRoleRoute);

// Candidate flow routes
app.use('/api/candidate/submit', candidateSubmitRoute);
app.use('/api/candidate/verify-otp', verifyOtpRoute);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
