// /interview-agent-backend/generateRubric.js
const OpenAI = require('openai')
const { createClient } = require('@supabase/supabase-js')

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)

async function generateRubricForRole(roleId) {
  const { data: role, error } = await supabase
    .from('roles')
    .select('title, interview_type, manual_questions, job_description_url')
    .eq('id', roleId)
    .single()

  if (error || !role) {
    console.error('Error fetching role:', error)
    return
  }

  let jobDescriptionText = ''

  // Try to fetch and parse job description file if uploaded
  if (role.job_description_url) {
    const { data: fileData, error: fileError } = await supabase.storage
      .from('resumes') // or 'job-descriptions' if you made a new bucket
      .download(role.job_description_url)

    if (fileError) {
      console.error('Error downloading job description:', fileError)
    } else {
      const text = await fileData.text()
      jobDescriptionText = text
    }
  }

  const prompt = `
You are an AI interview designer. Create a JSON rubric based on the job description and any custom questions below.

Interview Type: ${role.interview_type}
Role Title: ${role.title}

Job Description:
${jobDescriptionText}

Manual Questions:
${role.manual_questions || 'None'}

Return JSON like:
{
  "questions": [
    { "text": "What excites you about this role?", "category": "motivation" },
    { "text": "How do you handle client objections?", "category": "sales_skill" }
  ]
}
`

  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-4',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.2
    })

    const raw = response.choices[0].message.content
    const parsed = JSON.parse(raw)

    await supabase.from('roles').update({ rubric: parsed }).eq('id', roleId)

    console.log(`Rubric generated and saved for role ${roleId}`)
  } catch (err) {
    console.error('OpenAI rubric generation failed:', err.message)
  }
}

module.exports = { generateRubricForRole }
