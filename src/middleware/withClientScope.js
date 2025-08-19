import { supabaseAdmin } from '../lib/supabaseClient.js'

export async function withClientScope(req, res, next) {
  if (!req.user) return res.status(500).json({ error: 'User not loaded' })
  const { data, error } = await supabaseAdmin
    .from('client_members')
    .select('client_id, role')
    .eq('user_id', req.user.id)
  if (error) return res.status(500).json({ error: 'Failed to load memberships' })
  req.clientIds = data.map(r => r.client_id)
  req.memberships = data
  next()
}
