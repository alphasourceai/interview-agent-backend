const { createClient } = require('@supabase/supabase-js')

const SUPABASE_URL = process.env.SUPABASE_URL || ''
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || ''
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || ''

const clientOptions = {
  auth: { persistSession: false, autoRefreshToken: false },
  global: { headers: { 'X-Client-Info': 'interview-agent-server' } }
}

const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, clientOptions)
const supabaseAnon = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, clientOptions)

async function getUserFromToken(token) {
  if (!token) return { data: null, error: new Error('Missing token') }
  return await supabaseAnon.auth.getUser(token)
}

module.exports = { supabase: supabaseAdmin, supabaseAdmin, supabaseAnon, getUserFromToken }
