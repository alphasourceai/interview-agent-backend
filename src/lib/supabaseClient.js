// src/lib/supabaseClient.js
const { createClient } = require('@supabase/supabase-js');

// MUST be the service role key on the server
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  // Fail fast in dev to avoid RLS surprises
  // (Render logs will show this if misconfigured)
  console.error("Supabase service env missing. Check SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.");
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
  global: { headers: { 'X-Client-Info': 'interview-agent-server' } }
});

module.exports = { supabase };
