// generateRubric.js
const { createClient } = require('@supabase/supabase-js')
const OpenAI = require('openai')
const { randomUUID } = require('crypto')
const path = require('path')
const { parseBufferToText } = require('./utils/jdParser')
const { ensureTavusDocumentForRole } = require('./lib/tavusDocuments')

// Create internal clients with SR key (server-side only)
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false }
})
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })

const INTERVIEW_TYPE_PROMPTS = {
  BASIC: 'Create 5 short, screening-style questions that quickly assess overall fit, communication, and motivation. Keep them grounded in the job description and highlight day-to-day expectations.',
  DETAILED: 'Create 6-8 deeper behavioral and leadership questions. Encourage STAR-style answers and tie each question to responsibilities or success metrics pulled from the job description.',
  TECHNICAL: 'Create 8-10 technical or skill-based questions focused on the specific tools, systems, and requirements in the job description. Include scenario-based or problem-solving prompts when appropriate.'
}

function normalizeInterviewType(type) {
  const key = String(type || 'BASIC').trim().toUpperCase()
  if (!['BASIC', 'DETAILED', 'TECHNICAL'].includes(key)) {
    console.warn(`[rubric] unknown_interview_type type=${type}; falling back to BASIC`)
    return 'BASIC'
  }
  return key
}

function buildPrompt({ role, jdText, manualQuestions }) {
  const type = normalizeInterviewType(role.interview_type)
  const guidance = INTERVIEW_TYPE_PROMPTS[type] || INTERVIEW_TYPE_PROMPTS.BASIC
  return `You are an AI interview designer. Using the role details below, craft a JSON rubric that Interview Agent will feed into Tavus.

Return ONLY valid JSON with this shape:
{
  "questions": [
    { "text": "Question text...", "category": "skill_or_theme" }
  ]
}

Rules:
- Every question MUST reference the responsibilities, skills, or context from the job description.
- Include clear categories (skill areas) so downstream scoring can bucket responses.
- ${guidance}

Role Title: ${role.title || 'Unknown Role'}
Interview Type: ${type}

Job Description Text:
${jdText || 'N/A'}

Custom / Manual Questions Provided By The Client (use or adapt as needed):
${manualQuestions || 'None'}
`
}

function validateRubric(rubricObj, context) {
  if (!rubricObj || typeof rubricObj !== 'object') {
    console.error('[rubric] invalid_structure', context)
    throw new Error('rubric_invalid_structure')
  }
  if (!Array.isArray(rubricObj.questions) || rubricObj.questions.length === 0) {
    console.error('[rubric] empty_rubric', context)
    throw new Error('rubric_empty')
  }
  return rubricObj
}

function buildFallbackRubric(role) {
  const title = role?.title || 'this role'
  return {
    questions: [
      { text: `What experience makes you a strong fit for the ${title} position?`, category: 'experience' },
      { text: `Tell me about a recent accomplishment that best demonstrates your impact for ${title}.`, category: 'impact' },
      { text: `What motivates you most about contributing to ${title}?`, category: 'motivation' }
    ]
  }
}

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
    .select('id, title, interview_type, manual_questions, job_description_url, tavus_document_id')
    .eq('id', roleId)
    .single()
  if (roleErr || !role) throw new Error(`role_lookup_failed: ${roleErr?.message || 'not found'}`)

  const interviewType = normalizeInterviewType(role.interview_type)
  console.log(`[rubric] generate role=${roleId} type=${interviewType}`)

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
  if (!jdText) {
    console.warn(`[rubric] missing_job_description role=${roleId} type=${interviewType} url=${role.job_description_url || 'none'}`)
  }

  // 3) Build LLM prompt
  const prompt = buildPrompt({
    role: { ...role, interview_type: interviewType },
    jdText,
    manualQuestions: role.manual_questions || 'None'
  })

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
    if (!rubricObj) {
      console.error('[rubric] openai_parse_failed', { role_id: roleId, interview_type: interviewType, raw })
      throw new Error('rubric_parse_failed')
    }
  } catch (e) {
    console.error('[rubric] openai_rubric_failed', { role_id: roleId, interview_type: interviewType, error: e?.message || e })
    throw e
  }

  try {
    rubricObj = validateRubric(rubricObj, { role_id: roleId, interview_type: interviewType })
  } catch (err) {
    if (!jdText) {
      console.warn('[rubric] empty_rubric_fallback', { role_id: roleId, interview_type: interviewType, reason: 'missing_jd' })
      rubricObj = validateRubric(buildFallbackRubric(role), { role_id: roleId, interview_type: interviewType, fallback: true })
    } else {
      throw err
    }
  }

  // 5) Write rubric to roles.rubric + description (first chunk of JD text)
  const description = jdText ? jdText.slice(0, 2000) : null
  await supabase.from('roles').update({
    rubric: rubricObj,
    ...(description ? { description } : {})
  }).eq('id', roleId)

  // 6) Create + upload KB JSON (kbs/<uuid>.json), store <uuid> in roles.kb_document_id
  const kbJson = makeKBFromRubric(rubricObj)
  if (!Array.isArray(kbJson.questions) || kbJson.questions.length === 0) {
    throw new Error('kb_generation_failed: rubric produced no questions')
  }
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

  try {
    await ensureTavusDocumentForRole(
      { id: roleId, title: role.title, kb_document_id: kbId, tavus_document_id: role.tavus_document_id },
      { supabase, rubric: kbJson }
    )
  } catch (e) {
    console.error('[tavus-doc] ensure failed after KB generation:', e?.message || e)
  }

  return { role_id: roleId, kb_document_id: kbId }
}

module.exports = { generateRubricAndKBForRole }
