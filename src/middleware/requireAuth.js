import { supabaseAnon } from '../lib/supabaseClient.js'

export async function requireAuth(req, res, next) {
  const h = req.headers.authorization || ''
  const token = h.startsWith('Bearer ') ? h.slice(7) : null
  if (!token) return res.status(401).json({ error: 'Missing bearer token' })
  const { data, error } = await supabaseAnon.auth.getUser(token)
  if (error || !data?.user) return res.status(401).json({ error: 'Invalid token' })
  req.user = data.user
  req.jwt = token
  next()
}
