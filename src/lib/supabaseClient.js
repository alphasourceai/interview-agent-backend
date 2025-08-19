const { createClient } = require('@supabase/supabase-js')

const SUPABASE_URL = process.env.SUPABASE_URL || ''
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || ''
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || ''

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY')
}

const clientOptions = {
  auth: { persistSession: false, autoRefreshToken: false },
  global: { headers: { 'X-Client-Info': 'interview-agent-server' } }
}

const adminKey = SUPABASE_SERVICE_ROLE_KEY
const anonKey = SUPABASE_ANON_KEY || SUPABASE_SERVICE_ROLE_KEY

if (!SUPABASE_ANON_KEY) {
  console.warn('[supabase] SUPABASE_ANON_KEY not set; temporarily using SERVICE_ROLE for anon client')
}

const supabaseAdmin = createClient(SUPABASE_URL, adminKey, clientOptions)
const supabaseAnon = createClient(SUPABASE_URL, anonKey, clientOptions)

module.exports = { supabase: supabaseAdmin, supabaseAdmin, supabaseAnon }
