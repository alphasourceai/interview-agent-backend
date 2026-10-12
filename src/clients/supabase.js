const { createClient } = require('@supabase/supabase-js')

const SUPABASE_URL = process.env.SUPABASE_URL || ''
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || ''
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || ''

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !SUPABASE_ANON_KEY) {
  throw new Error('Missing SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, or SUPABASE_ANON_KEY')
}

const clientOptions = {
  auth: { persistSession: false, autoRefreshToken: false },
  global: { headers: { 'X-Client-Info': 'interview-agent-server' } }
}

const adminKey = SUPABASE_SERVICE_ROLE_KEY
const anonKey = SUPABASE_ANON_KEY

const supabaseAdmin = createClient(SUPABASE_URL, adminKey, clientOptions)
const supabaseAnon = createClient(SUPABASE_URL, anonKey, clientOptions)

// Keep all runtime key reads here. Callers receive only the narrow immutable
// artifact methods, never the private key or a second general-purpose client.
function createEnterpriseAgreementArtifacts(db) {
  if (db !== supabaseAdmin) throw Object.assign(new Error(''), { code: 'enterprise_execution_configuration_invalid', status: 503 });
  const match = /^https:\/\/([a-z0-9]{20})\.supabase\.co\/?$/.exec(SUPABASE_URL);
  if (!match || ![SUPABASE_URL, SUPABASE_URL.replace(/\/$/, '')].includes(db.supabaseUrl)) {
    throw Object.assign(new Error(''), { code: 'enterprise_execution_configuration_invalid', status: 503 });
  }
  const { createMembershipPrivateArtifacts } = require('../services/membershipPrivateArtifacts');
  return createMembershipPrivateArtifacts({ configuration: {
    projectRef: match[1], bucket: process.env.SUPABASE_AGREEMENTS_BUCKET || 'agreements',
    namespace: 'enterprise-v2', serviceKey: SUPABASE_SERVICE_ROLE_KEY
  } });
}

module.exports = { supabase: supabaseAdmin, supabaseAdmin, supabaseAnon, createEnterpriseAgreementArtifacts }
