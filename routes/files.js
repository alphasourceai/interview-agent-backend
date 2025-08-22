// routes/files.js
const express = require('express')
const router = express.Router()
const { createClient } = require('@supabase/supabase-js')

const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY')
}
const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
})

// Helper: parse the DB value into { bucket, path } if possible.
// Accepts either "bucket/path/to/file.json" or any Supabase Storage URL (public/sign).
function parseBucketPath(value) {
  if (!value || typeof value !== 'string') return null
  const v = value.trim()

  // New/desired format: "bucket/path..."
  if (!/^https?:\/\//i.test(v)) {
    const firstSlash = v.indexOf('/')
    if (firstSlash > 0) {
      return { bucket: v.slice(0, firstSlash), path: v.slice(firstSlash + 1) }
    }
    return null
  }

  // Old format: public or signed URL
  // Examples:
  //  - https://<proj>.supabase.co/storage/v1/object/public/transcripts/foo.json
  //  - https://<proj>.supabase.co/storage/v1/object/sign/analysis/bar.json?token=...
  try {
    const u = new URL(v)
    const parts = u.pathname.split('/').filter(Boolean) // ["storage","v1","object","public|sign", "<bucket>", "...path..."]
    const idx = parts.findIndex(p => p === 'public' || p === 'sign')
    if (idx >= 0 && parts[idx + 1]) {
      const bucket = parts[idx + 1]
      const path = parts.slice(idx + 2).join('/')
      if (bucket && path) return { bucket, path }
    }
  } catch (_) {
    // ignore
  }
  return null
}

router.get('/signed-url', async (req, res) => {
  try {
    const { interview_id, kind } = req.query
    if (!interview_id || !kind) return res.status(400).json({ error: 'interview_id and kind are required' })
    if (!['transcript', 'analysis'].includes(kind)) return res.status(400).json({ error: 'kind must be transcript|analysis' })

    // Require auth scope (the app mounts this router behind auth+scope+injectClientMemberships)
    const scope = Array.isArray(req.client_memberships) ? req.client_memberships : []
    if (!scope.length) return res.status(403).json({ error: 'No client scope' })

    // Load interview and enforce scope
    const { data: interview, error } = await supabaseAdmin
      .from('interviews')
      .select('id, client_id, transcript_url, analysis_url')
      .eq('id', interview_id)
      .maybeSingle()
    if (error) return res.status(400).json({ error: error.message })
    if (!interview) return res.status(404).json({ error: 'Interview not found' })
    if (!scope.includes(interview.client_id)) return res.status(403).json({ error: 'Forbidden' })

    const raw = kind === 'transcript' ? interview.transcript_url : interview.analysis_url
    if (!raw) return res.status(404).json({ error: `${kind} not available` })

    const parsed = parseBucketPath(raw)
    if (!parsed) {
      // As a last resort, if it's already a (public) URL we can return it,
      // but prefer signed access going forward.
      if (/^https?:\/\//i.test(raw)) return res.json({ ok: true, url: raw, mode: 'legacy_url' })
      return res.status(400).json({ error: 'Unrecognized storage path/URL' })
    }

    const EXPIRES = Number(process.env.SIGNED_URL_TTL_SECONDS || 300)
    const { data: signed, error: signErr } = await supabaseAdmin
      .storage
      .from(parsed.bucket)
      .createSignedUrl(parsed.path, EXPIRES)

    if (signErr) return res.status(400).json({ error: signErr.message })
    return res.json({ ok: true, url: signed?.signedUrl, mode: 'signed', bucket: parsed.bucket })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

module.exports = router
