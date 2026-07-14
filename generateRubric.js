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

const REPLACEMENT_RUBRIC_MIN_QUESTIONS = 3
const RUBRIC_TARGET_MINIMUMS = Object.freeze({
  BASIC: 5,
  DETAILED: 7,
  TECHNICAL: 7
})

class RubricQuestionQualityError extends Error {
  constructor({ minimum, target, validQuestionCount }) {
    super(`Generated rubric must contain at least ${minimum} valid, distinct questions.`)
    this.name = 'RubricQuestionQualityError'
    this.code = 'RUBRIC_QUESTION_QUALITY_FAILED'
    this.stage = 'rubric_quality'
    this.status = 502
    this.detail = { minimum, target, valid_question_count: validQuestionCount, attempts: 2 }
  }
}

function normalizeQuestionKey(value) {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ')
}

function normalizeRubricQuestions(questions) {
  const seen = new Set()
  const normalized = []

  for (const question of Array.isArray(questions) ? questions : []) {
    if (!question || typeof question !== 'object' || Array.isArray(question)) continue
    const text = String(question.text || '').replace(/\s+/g, ' ').trim()
    if (!text) continue
    const key = normalizeQuestionKey(text)
    if (seen.has(key)) continue
    seen.add(key)
    const category = String(question.category || '').replace(/\s+/g, ' ').trim() || 'auto'
    normalized.push({ ...question, text, category })
  }

  return normalized
}

function replacementRubricTargetCount(interviewType) {
  const normalizedType = String(interviewType || 'BASIC').trim().toUpperCase()
  return RUBRIC_TARGET_MINIMUMS[normalizedType] || RUBRIC_TARGET_MINIMUMS.BASIC
}

function makeKBFromRubric(rubricObj) {
  const qs = Array.isArray(rubricObj?.questions) ? rubricObj.questions : []
  // Tavus-facing KB must contain only clean question text, not rubric categories or scoring labels.
  const questions = qs.map(q => ({
    text: typeof q?.text === 'string' ? q.text : String(q)
  })).filter(q => q.text && q.text.trim())
  return { questions }
}

function buildRubricPrompt(role, jdText) {
  return `
You are an AI interview designer. Create a JSON rubric based on the job description and any custom questions.

Return ONLY valid JSON. Shape:
{
  "questions": [
    { "text": "Question text...", "category": "skill_or_theme" }
  ]
}

Interview Type: ${role.interview_type || 'BASIC'}
Role Title: ${role.title}

Question requirements:
- Every question must be open-ended and designed to elicit a substantive response.
- Never generate yes/no questions or other closed-ended prompts.
- Prefer formats like: "Tell me about...", "Walk me through...", "Describe a time when...", "How have you..."
- Ground questions in the JD and Manual Questions.

Interview-type guidance:
- BASIC: short screening style; focus on core fit, relevant experience, motivation, and communication; lighter depth; use a smaller set of questions; target about 5-7 questions.
- DETAILED: deeper behavioral and situational coverage; leadership, ownership, judgment, collaboration, problem-solving, and complexity; target about 7-10 questions.
- TECHNICAL: skill-heavy and scenario-based; tools/processes/technical reasoning depth; require approach, tradeoffs, execution, and troubleshooting detail; target about 7-10 questions.

Manual-question handling:
- If Manual Questions are provided, incorporate them into the final rubric.
- You may lightly clean wording for clarity, but preserve original intent.
- Do not drop manual questions unless they are duplicative, closed-ended, or clearly low quality.
- If adapted, convert them into stronger open-ended versions.

Ordering:
- Start with broad/core fit questions.
- Then move into role-specific depth.
- End with the most specialized, technical, or high-judgment questions.

Avoid:
- duplicate questions
- overly generic filler questions
- questions that can be answered with yes/no
- questions unrelated to the JD or Manual Questions

Job Description (may be empty):
${jdText || 'N/A'}

Manual Questions:
${role.manual_questions || 'None'}
`.trim()
}

function buildRubricCorrectionPrompt(role, jdText, validQuestions) {
  const target = replacementRubricTargetCount(role?.interview_type)
  const additionalNeeded = Math.max(target - validQuestions.length, REPLACEMENT_RUBRIC_MIN_QUESTIONS - validQuestions.length)
  return `${buildRubricPrompt(role, jdText)}

QUALITY CORRECTION:
The prior result contained only ${validQuestions.length} valid, distinct questions. Return a complete replacement JSON rubric with at least ${target} valid, distinct questions. Add at least ${additionalNeeded} new, non-duplicate questions while preserving these usable questions where appropriate:
${JSON.stringify(validQuestions)}`
}

async function requestRubric({ prompt, openaiClient = openai, logger = console }) {
  try {
    const resp = await openaiClient.chat.completions.create({
      model: process.env.OPENAI_RUBRIC_MODEL || process.env.OPENAI_MODEL || 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.2
    })
    const raw = resp?.choices?.[0]?.message?.content || ''
    const rubricObj = safeJSONParse(raw)
    return rubricObj && Array.isArray(rubricObj.questions) ? rubricObj : null
  } catch (e) {
    logger.error('openai_rubric_failed:', e?.message || e)
    return null
  }
}

function fallbackRubric(role) {
  const fallbackQuestion = role.title
    ? `What experience makes you a strong fit for the ${role.title} role?`
    : 'Tell me about your most relevant experience for this role.'
  return { questions: [{ text: fallbackQuestion, category: 'auto' }] }
}

async function generateRubricForRole({ role, jdText, openaiClient = openai, logger = console }) {
  const rubricObj = await requestRubric({
    prompt: buildRubricPrompt(role, jdText),
    openaiClient,
    logger
  })

  return rubricObj || fallbackRubric(role)
}

async function generateReplacementRubric({ role, jdText, openaiClient = openai, logger = console }) {
  const initialRubric = await generateRubricForRole({ role, jdText, openaiClient, logger })
  const initialQuestions = normalizeRubricQuestions(initialRubric.questions)
  if (initialQuestions.length >= REPLACEMENT_RUBRIC_MIN_QUESTIONS) {
    return { ...initialRubric, questions: initialQuestions }
  }

  const retryRubric = await requestRubric({
    prompt: buildRubricCorrectionPrompt(role, jdText, initialQuestions),
    openaiClient,
    logger
  })
  const mergedQuestions = normalizeRubricQuestions([
    ...initialQuestions,
    ...(retryRubric?.questions || [])
  ])
  if (mergedQuestions.length < REPLACEMENT_RUBRIC_MIN_QUESTIONS) {
    throw new RubricQuestionQualityError({
      minimum: REPLACEMENT_RUBRIC_MIN_QUESTIONS,
      target: replacementRubricTargetCount(role?.interview_type),
      validQuestionCount: mergedQuestions.length
    })
  }

  return { ...(retryRubric || initialRubric), questions: mergedQuestions }
}

async function uploadKnowledgeBase({ rubricObj, supabaseClient = supabase, kbId = randomUUID() }) {
  const kbJson = makeKBFromRubric(rubricObj)
  const kbKey = `${kbId}.json`
  const { error: upErr } = await supabaseClient.storage
    .from('kbs')
    .upload(kbKey, new Blob([JSON.stringify(kbJson, null, 2)], { type: 'application/json' }), {
      contentType: 'application/json',
      upsert: true
    })
  if (upErr) {
    const { error: upErr2 } = await supabaseClient.storage
      .from('kbs')
      .upload(kbKey, Buffer.from(JSON.stringify(kbJson)), {
        contentType: 'application/json',
        upsert: true
    })
    if (upErr2) throw new Error(`kb_upload_failed: ${upErr2.message}`)
  }
  return kbId
}

async function generateJdDerivedArtifactsForRole(
  { role, jdText },
  { supabaseClient = supabase, openaiClient = openai, logger = console, kbId } = {}
) {
  if (!role?.id) throw new Error('role_id_required')
  const normalizedJdText = String(jdText || '').trim()
  const rubric = await generateReplacementRubric({
    role,
    jdText: normalizedJdText,
    openaiClient,
    logger
  })
  const kbDocumentId = await uploadKnowledgeBase({
    rubricObj: rubric,
    supabaseClient,
    kbId
  })
  const rubricQuestions = Array.isArray(rubric?.questions) ? rubric.questions : []
  const description = normalizedJdText
    ? normalizedJdText.replace(/\s+/g, ' ').slice(0, 400)
    : null

  return {
    job_description_text: normalizedJdText,
    description,
    rubric,
    rubric_questions: rubricQuestions,
    kb_document_id: kbDocumentId
  }
}

async function generateRubricAndKBForRole(roleId) {
  const { data: role, error: roleErr } = await supabase
    .from('roles')
    .select('id, title, interview_type, manual_questions, job_description_url')
    .eq('id', roleId)
    .single()
  if (roleErr || !role) throw new Error(`role_lookup_failed: ${roleErr?.message || 'not found'}`)

  let jdText = ''
  if (role.job_description_url) {
    const { bucket, key } = splitBucketAndKey(role.job_description_url)
    if (bucket && key) {
      const buf = await downloadAsBuffer(bucket, key)
      const mime = guessMimeFromExt(key)
      jdText = await parseBufferToText(buf, mime, key)
    }
  }

  const rubric = await generateRubricForRole({ role, jdText })
  const rubricQuestions = Array.isArray(rubric?.questions) ? rubric.questions : []
  const descriptionExcerpt = jdText ? jdText.replace(/\s+/g, ' ').trim().slice(0, 400) : ''

  await supabase.from('roles').update({
    rubric,
    rubric_questions: rubricQuestions,
    ...(jdText ? { job_description_text: jdText, description: descriptionExcerpt || null } : {})
  }).eq('id', roleId)

  const kbDocumentId = await uploadKnowledgeBase({ rubricObj: rubric })
  const { error: updErr } = await supabase
    .from('roles')
    .update({ kb_document_id: kbDocumentId })
    .eq('id', roleId)
  if (updErr) throw new Error(`kb_id_update_failed: ${updErr.message}`)

  try {
    await ensureTavusDocumentForRole(
      { id: roleId, title: role.title, kb_document_id: kbDocumentId },
      { supabase, rubric }
    )
  } catch (tavusErr) {
    console.error(
      `[generateRubric] tavus_document_creation_failed role=${roleId} kb_document_id=${kbDocumentId}:`,
      tavusErr?.message || tavusErr
    )
  }

  return { role_id: roleId, kb_document_id: kbDocumentId }
}

module.exports = {
  REPLACEMENT_RUBRIC_MIN_QUESTIONS,
  RubricQuestionQualityError,
  generateRubricAndKBForRole,
  generateJdDerivedArtifactsForRole,
  generateRubricForRole,
  makeKBFromRubric,
  normalizeRubricQuestions,
  replacementRubricTargetCount
}
