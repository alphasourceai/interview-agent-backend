// routes/reports.js
const express = require('express')
const router = express.Router()
const { supabaseAdmin } = require('../src/lib/supabaseClient')

// Prefer the new generator; fall back to the legacy util if present
let generateReport = null
try {
  // expected to export: async function generateReport(payload) -> url
  ({ generateReport } = require('../src/lib/generateReport'))
} catch (_) {}
let legacyGenerateCandidatePDF = null
if (!generateReport) {
  try {
    // legacy: async function generateCandidatePDF(payload) -> url
    ({ generateCandidatePDF: legacyGenerateCandidatePDF } = require('../utils/pdfMonkey'))
  } catch (_) {}
}

/** Parse "<bucket>/<path>" or full Supabase object URL into { bucket, path } */
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

async function downloadJsonFromStorage(urlOrPath) {
  const bp = parseBucketPathFromUrl(urlOrPath)
  if (!bp) return null
  const { data, error } = await supabaseAdmin.storage.from(bp.bucket).download(bp.path)
  if (error || !data) return null
  const text = await data.text()
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

async function getInterview(interviewId) {
  // Keep selection minimal; expand as needed
  return supabaseAdmin
    .from('interviews')
    .select('id, client_id, candidate_id, role_id, video_url, transcript_url, analysis_url, created_at')
    .eq('id', interviewId)
    .single()
}

function ensureAccess(reqMemberships, clientId) {
  // Accept either array of ids or array of {client_id,...}
  const ids = Array.isArray(reqMemberships)
    ? reqMemberships.map(m => (typeof m === 'string' ? m : m.client_id)).filter(Boolean)
    : []
  if (!ids.includes(clientId)) {
    const e = new Error('Forbidden')
    e.status = 403
    throw e
  }
}

async function buildPayload(interview) {
  const transcript = interview.transcript_url
    ? await downloadJsonFromStorage(interview.transcript_url)
    : null
  const analysis = interview.analysis_url
    ? await downloadJsonFromStorage(interview.analysis_url)
    : null

  // Very simple, MVP-safe payload; expand with real scoring when ready
  const payload = {
    interview_id: interview.id,
    created_at: interview.created_at,
    candidate_id: interview.candidate_id || null,
    role_id: interview.role_id || null,

    // Summaries (blank-safe if you haven't uploaded files yet)
    transcript_summary: transcript?.summary || '',
    analysis_summary: analysis?.summary || '',

    // Naive placeholder scores (feel free to replace when you have models)
    resume_score: 0,
    interview_score: 0,
    overall_score: 0,
    resume_breakdown: { experience: 0, skills: 0, education: 0 },
    interview_breakdown: { clarity: 0, confidence: 0, body_language: 0 },
  }

  return payload
}

async function runGenerator(payload) {
  if (generateReport) {
    // New code path
    return await generateReport(payload)
  }
  if (legacyGenerateCandidatePDF) {
    // Back-compat path
    return await legacyGenerateCandidatePDF(payload)
  }
  const e = new Error('Report service not configured')
  e.status = 500
  throw e
}

async function handlerGenerate(req, res) {
  try {
    if (!req.user) return res.status(401).json({ error: 'Unauthorized' })

    const interviewId = req.params.interview_id
    if (!interviewId) return res.status(400).json({ error: 'interview_id is required' })

    const { data: interview, error } = await getInterview(interviewId)
    if (error || !interview) return res.status(404).json({ error: 'Interview not found' })

    // Tenant access check
    ensureAccess(req.client_memberships || req.memberships || [], interview.client_id)

    const payload = await buildPayload(interview)
    const url = await runGenerator(payload)

    // Best-effort: persist a reports row (schema may vary; ignore errors)
    try {
      await supabaseAdmin
        .from('reports')
        .upsert(
          { interview_id: interviewId, report_url: url, created_at: new Date().toISOString() },
          { onConflict: 'interview_id' }
        )
    } catch (_) {}

    return res.json({ ok: true, url })
  } catch (e) {
    return res.status(e.status || 500).json({ error: e.message || 'Server error' })
  }
}

// Primary endpoint (POST) + GET alias for convenience
router.post('/:interview_id/generate', handlerGenerate)
router.get('/:interview_id/generate', handlerGenerate)

module.exports = router
