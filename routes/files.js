// routes/files.js
const express = require('express')
const { createClient } = require('@supabase/supabase-js')

const router = express.Router()
const supabaseAdmin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)

function parseBucketPathFromUrl(input) {
  if (!input) return null
  try {
    if (input.startsWith('http')) {
      const u = new URL(input)
      // supports /object/public/<bucket>/<path> and /object/sign/<bucket>/<path>
      const m = u.pathname.match(/\/object\/(?:public|sign)\/([^/]+)\/(.+)$/)
      if (m) return { bucket: m[1], path: decodeURIComponent(m[2]) }
    }
  } catch (_) {}
  const firstSlash = input.indexOf('/')
  if (firstSlash === -1) return null
  return { bucket: input.slice(0, firstSlash), path: input.slice(firstSlash + 1) }
}

async function getInterviewForAuth(id) {
  return supabaseAdmin
    .from('interviews')
    .select('id, client_id, transcript_url, analysis_url')
    .eq('id', id)
    .single()
}

function ensureMembershipOrThrow(memberships, clientId) {
  const ids = Array.isArray(memberships)
    ? memberships.map(m => (typeof m === 'string' ? m : m?.client_id)).filter(Boolean)
    : []
  if (!ids.includes(clientId)) {
    const err = new Error('Forbidden')
    err.status = 403
    throw err
  }
}

router.get('/files/signed-url', async (req, res) => {
  try {
    const user = req.user
    const memberships = req.client_memberships || req.memberships || []
    if (!user) return res.status(401).json({ error: 'Unauthorized' })

    const interviewId = req.query.interview_id
    const kind = req.query.kind
    const expiresIn = Math.min(Math.max(parseInt(req.query.expires_in || '3600', 10), 60), 86400)

    if (!interviewId || !['transcript', 'analysis'].includes(kind)) {
      return res.status(400).json({ error: 'interview_id and kind=transcript|analysis are required' })
    }

    const { data: interview, error } = await getInterviewForAuth(interviewId)
    if (error || !interview) return res.status(404).json({ error: 'Interview not found' })

    ensureMembershipOrThrow(memberships, interview.client_id)

    const source = kind === 'transcript' ? interview.transcript_url : interview.analysis_url
    if (!source) {
      return res.status(404).json({ error: `No ${kind} available yet for this interview` })
    }

    const bp = parseBucketPathFromUrl(source)
    if (!bp) return res.status(400).json({ error: 'Invalid stored path/URL' })

    const { data: signed, error: signErr } = await supabaseAdmin
      .storage
      .from(bp.bucket)
      .createSignedUrl(bp.path, expiresIn)

    if (signErr) return res.status(500).json({ error: signErr.message })
    return res.json({ url: signed.signedUrl })
  } catch (e) {
    return res.status(e.status || 500).json({ error: e.message || 'Server error' })
  }
})

module.exports = router
