// routes/reports.js
const express = require('express')
const crypto = require('crypto')
const { createClient } = require('@supabase/supabase-js')

const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY')
}
const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })

const PDFMONKEY_API_KEY = process.env.PDFMONKEY_API_KEY
const PDFMONKEY_TEMPLATE_ID = process.env.PDFMONKEY_TEMPLATE_ID
const REPORTS_BUCKET = process.env.SUPABASE_REPORTS_BUCKET || 'reports'

const router = express.Router()

function requireScope(req, res, next) {
  if (!Array.isArray(req.client_memberships)) return res.status(403).json({ error: 'No client scope' })
  next()
}
function sleep(ms){return new Promise(r=>setTimeout(r,ms))}
function sha256(obj){const s=typeof obj==='string'?obj:JSON.stringify(obj);return crypto.createHash('sha256').update(s).digest('hex')}

async function fetchInterview(interview_id) {
  const { data, error } = await supabaseAdmin.from('interviews').select('*').eq('id', interview_id).maybeSingle()
  if (error) throw new Error(error.message)
  if (!data) throw new Error('Interview not found')
  return data
}
async function fetchCandidate(candidate_id) {
  if (!candidate_id) return null
  const { data, error } = await supabaseAdmin.from('candidates').select('*').eq('id', candidate_id).maybeSingle()
  if (error) throw new Error(error.message)
  return data
}

// Try multiple possible columns on reports: interview_id, interview, interviewId, conversation_id
async function fetchLatestReportForInterview(interview_id) {
  const tryCols = ['interview_id', 'interview', 'interviewId', 'conversation_id']
  for (const col of tryCols) {
    try {
      const { data, error } = await supabaseAdmin
        .from('reports')
        .select('*')
        .eq(col, interview_id)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle()
      if (error) {
        // If it's a "column does not exist" error, try next
        if (/column .* does not exist/i.test(error.message)) continue
        // Other DB error -> propagate
        throw error
      }
      if (data) return data
      // no row; keep trying next column name
    } catch (e) {
      if (/column .* does not exist/i.test(String(e.message))) continue
      throw e
    }
  }
  // No matching column or no report found
  return null
}

function coalesceScore(n){const x=Number(n);return Number.isFinite(x)?x:0}

async function buildPayload(interview) {
  const candidate = await fetchCandidate(interview.candidate_id)
  const report = await fetchLatestReportForInterview(interview.id)

  const name = candidate?.name || interview.candidate_name || 'Unknown'
  const email = candidate?.email || interview.candidate_email || 'unknown@example.com'

  const resume_breakdown = report?.resume_breakdown || { experience:0, skills:0, education:0 }
  const interview_breakdown = report?.interview_breakdown || { clarity:0, confidence:0, body_language:0 }

  const resume_score = coalesceScore(report?.resume_score)
  const interview_score = coalesceScore(report?.interview_score)
  const overall_score = coalesceScore(report?.overall_score) || Math.round((resume_score + interview_score)/2)

  return {
    name, email,
    resume_score, interview_score, overall_score,
    resume_breakdown: {
      experience: coalesceScore(resume_breakdown.experience),
      skills: coalesceScore(resume_breakdown.skills),
      education: coalesceScore(resume_breakdown.education),
    },
    interview_breakdown: {
      clarity: coalesceScore(interview_breakdown.clarity),
      confidence: coalesceScore(interview_breakdown.confidence),
      body_language: coalesceScore(interview_breakdown.body_language),
    },
    video_url: interview.video_url || null,
    transcript_url: null,
    analysis_url: null,
  }
}

// Storage helpers
async function ensureBucketExists(bucket){
  const { data:list } = await supabaseAdmin.storage.listBuckets()
  if (!list?.find(b=>b.name===bucket)) { try{ await supabaseAdmin.storage.createBucket(bucket, { public:false }) }catch{} }
}
async function signedUrlIfExists(bucket,path,expires=300){
  const { data, error } = await supabaseAdmin.storage.from(bucket).createSignedUrl(path, expires)
  if (error) return null
  return data?.signedUrl || null
}
async function uploadPdf(bucket,path,buffer){
  await ensureBucketExists(bucket)
  const { error } = await supabaseAdmin.storage.from(bucket).upload(path, buffer, { contentType:'application/pdf', upsert:true })
  if (error) throw new Error(error.message)
}

// PDFMonkey
async function pdfmonkeyCreateAndWait(payload, filename){
  if (!PDFMONKEY_API_KEY || !PDFMONKEY_TEMPLATE_ID) throw new Error('PDFMonkey not configured')
  const base='https://api.pdfmonkey.io/api/v1'
  const headers={ Authorization:`Bearer ${PDFMONKEY_API_KEY}`, 'Content-Type':'application/json' }
  const body=JSON.stringify({ document:{ document_template_id:PDFMONKEY_TEMPLATE_ID, status:'pending', payload, meta:{ filename } } })
  const createRes=await fetch(`${base}/documents`,{ method:'POST', headers, body })
  if (!createRes.ok){ const t=await createRes.text(); throw new Error(`PDF create failed: ${createRes.status} ${t}`) }
  const created=await createRes.json(); const id=created?.data?.id; if (!id) throw new Error('No document id')

  for (let i=0;i<30;i++){
    const showRes=await fetch(`${base}/documents/${id}`,{ headers })
    const doc=await showRes.json()
    const status=doc?.data?.attributes?.status
    const url=doc?.data?.attributes?.download_url
    if (status==='success' && url) return url
    if (status==='failure' || status==='error') throw new Error('PDFMonkey document failed')
    await sleep(1000)
  }
  throw new Error('PDF generation timed out')
}

async function generateOrGetCached(interview_id){
  const interview = await fetchInterview(interview_id)
  const payload = await buildPayload(interview)
  const fp = sha256(payload)
  const path = `${fp}.pdf`

  const cached = await signedUrlIfExists(REPORTS_BUCKET, path, 300)
  if (cached) return { url: cached, fingerprint: fp, cached: true }

  const filename = `report-${interview_id}.pdf`
  const pdfUrl = await pdfmonkeyCreateAndWait(payload, filename)
  const resp = await fetch(pdfUrl)
  if (!resp.ok) throw new Error(`Fetch PDF failed: ${resp.statusText}`)
  const buf = Buffer.from(await resp.arrayBuffer())
  await uploadPdf(REPORTS_BUCKET, path, buf)

  const signed = await signedUrlIfExists(REPORTS_BUCKET, path, 300)
  return { url: signed || pdfUrl, fingerprint: fp, cached: false }
}

// Routes
router.get('/:interview_id/generate', requireScope, async (req, res) => {
  try {
    const { interview_id } = req.params
    const { data: row, error } = await supabaseAdmin
      .from('interviews')
      .select('client_id')
      .eq('id', interview_id)
      .maybeSingle()
    if (error) return res.status(400).json({ error: error.message })
    if (!row) return res.status(404).json({ error: 'Interview not found' })
    if (!req.client_memberships.includes(row.client_id)) return res.status(403).json({ error: 'Forbidden' })

    const out = await generateOrGetCached(interview_id)
    res.json({ ok: true, url: out.url, cached: out.cached, fingerprint: out.fingerprint })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

router.get('/:interview_id/download', requireScope, async (req, res) => {
  try {
    const { interview_id } = req.params
    const { data: row, error } = await supabaseAdmin
      .from('interviews')
      .select('client_id')
      .eq('id', interview_id)
      .maybeSingle()
    if (error) return res.status(400).json({ error: error.message })
    if (!row) return res.status(404).json({ error: 'Interview not found' })
    if (!req.client_memberships.includes(row.client_id)) return res.status(403).json({ error: 'Forbidden' })

    const out = await generateOrGetCached(interview_id)
    const pdfResp = await fetch(out.url)
    if (!pdfResp.ok) return res.status(502).json({ error: 'Failed to fetch cached PDF' })

    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader('Content-Disposition', `attachment; filename="report-${interview_id}.pdf"`)
    const ab = await pdfResp.arrayBuffer()
    res.end(Buffer.from(ab))
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

module.exports = router
