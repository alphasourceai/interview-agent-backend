// generateRubric.js
const { createClient } = require('@supabase/supabase-js')
const OpenAI = require('openai')
const { randomUUID } = require('crypto')
const path = require('path')
const { parseBufferToText } = require('./utils/jdParser')

// Create internal clients with SR key (server-side only)
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false }
})
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })

function splitBucketAndKey(full) {
  // Expects strings like "job-descriptions/<objectPath>"
  if (!full || typeof full !== 'string') return { bucket: null, key: null }
  const idx = full.indexOf('/')
  if (idx === -1) return { bucket: full, key: '' }
  return { bucket: full.slice(0, idx), key: full.slice(idx + 1) }
}

async function downloadAsBuffer(bucket, key) {
  const { data, error } = await supabase.storage.from(bucket).download(key)
  if (error) throw new Error(`storage_download_failed: ${error.message}`)
  // supabase-js returns a Blob in Node 18+
  const ab = await data.arrayBuffer()
  return Buffer.from(ab)
}

function guessMimeFromExt(filename) {
  const ext = (path.extname(filename || '').toLowerCase() || '').replace('.', '')
  if (ext === 'pdf') return 'application/pdf'
  if (ext === 'docx') return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  return 'application/octet-stream'
}

function safeJSONParse(s) {
  try { return JSON.parse(s) } catch { return null }
}

function makeKBFromRubric(rubricObj) {
  const qs = Array.isArray(rubricObj?.questions) ? rubricObj.questions : []
  // Normalize to simple { text, category } like your kbs/*.json
  const questions = qs.map(q => ({
    text: typeof q?.text === 'string' ? q.text : String(q),
    category: q?.category || 'auto'
  })).filter(q => q.text && q.text.trim())
  return { questions }
}

async function generateRubricAndKBForRole(roleId) {
  // 1) Load role
  const { data: role, error: roleErr } = await supabase
    .from('roles')
    .select('id, title, interview_type, manual_questions, job_description_url')
    .eq('id', roleId)
    .single()
  if (roleErr || !role) throw new Error(`role_lookup_failed: ${roleErr?.message || 'not found'}`)

  // 2) Pull + parse JD (if present)
  let jdText = ''
  let jdFileName = ''
  if (role.job_description_url) {
    const { bucket, key } = splitBucketAndKey(role.job_description_url)
    if (bucket && key) {
      jdFileName = key
      const buf = await downloadAsBuffer(bucket, key)
      const mime = guessMimeFromExt(key)
      jdText = await parseBufferToText(buf, mime, key)
    }
  }

  // 3) Build LLM prompt
  const prompt = `
You are an AI interview designer. Create a JSON rubric based on the job description and any custom questions.

Return ONLY valid JSON. Shape:
{
  "questions": [
    { "text": "Question text...", "category": "skill_or_theme" }
  ]
}

Interview Type: ${role.interview_type || 'BASIC'}
Role Title: ${role.title}

Job Description (may be empty):
${jdText || 'N/A'}

Manual Questions:
${role.manual_questions || 'None'}
`.trim()

  // 4) Call OpenAI
  let rubricObj = null
  try {
    const resp = await openai.chat.completions.create({
      model: 'gpt-4',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.2
    })
    const raw = resp?.choices?.[0]?.message?.content || ''
    rubricObj = safeJSONParse(raw)
  } catch (e) {
    // Keep going; we'll fallback to basic KB if needed
    console.error('openai_rubric_failed:', e?.message || e)
  }

  // Fallback rubric if parsing failed
  if (!rubricObj || !Array.isArray(rubricObj.questions)) {
    const fallbackQ = role.title
      ? [`What experience makes you a strong fit for the ${role.title} role?`]
      : [`Tell me about your most relevant experience for this role.`]
    rubricObj = { questions: fallbackQ.map(t => ({ text: t, category: 'auto' })) }
  }

  // 5) Write rubric to roles.rubric + description (first chunk of JD text)
  const description = jdText ? jdText.slice(0, 2000) : null
  await supabase.from('roles').update({
    rubric: rubricObj,
    ...(description ? { description } : {})
  }).eq('id', roleId)

  // 6) Create + upload KB JSON (kbs/<uuid>.json), store <uuid> in roles.kb_document_id
  const kbJson = makeKBFromRubric(rubricObj)
  const kbId = randomUUID()
  const kbKey = `${kbId}.json`
  const { error: upErr } = await supabase.storage
    .from('kbs')
    .upload(kbKey, new Blob([JSON.stringify(kbJson, null, 2)], { type: 'application/json' }), {
      contentType: 'application/json',
      upsert: true
    })
  if (upErr) {
    // If Blob unsupported in your Node env, fallback to Buffer:
    const { error: upErr2 } = await supabase.storage
      .from('kbs')
      .upload(kbKey, Buffer.from(JSON.stringify(kbJson)), {
        contentType: 'application/json',
        upsert: true
      })
    if (upErr2) throw new Error(`kb_upload_failed: ${upErr2.message}`)
  }

  const { error: updErr } = await supabase
    .from('roles')
    .update({ kb_document_id: kbId })
    .eq('id', roleId)
  if (updErr) throw new Error(`kb_id_update_failed: ${updErr.message}`)

  return { role_id: roleId, kb_document_id: kbId }
}

module.exports = { generateRubricAndKBForRole }
