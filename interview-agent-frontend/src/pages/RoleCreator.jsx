// /src/pages/RoleCreator.jsx
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'

export default function RoleCreator() {
  const [title, setTitle] = useState('')
  const [interviewType, setInterviewType] = useState('basic')
  const [manualQuestions, setManualQuestions] = useState('')
  const [jobFile, setJobFile] = useState(null)
  const [submitting, setSubmitting] = useState(false)

  const navigate = useNavigate()

  const handleSubmit = async (e) => {
    e.preventDefault()
    setSubmitting(true)

    const formData = new FormData()
    formData.append('title', title)
    formData.append('interview_type', interviewType)
    formData.append('client_id', '230f8351-f284-450e-b1d8-adeef448b70a') // 🔒 TEMP until login
    formData.append('job_description_file', jobFile)

    // Parse manual questions into array
    const questionsArray = manualQuestions
      .split('\n')
      .map(q => q.trim())
      .filter(Boolean)

    formData.append('manual_questions', JSON.stringify(questionsArray))

    try {
      const response = await fetch('https://interview-agent-backend-z6un.onrender.com/create-role', {
  method: 'POST',
  body: formData
})

      const result = await response.json()
      if (response.ok) {
        alert('Role created!')
        navigate('/dashboard')
      } else {
        alert(result.error || 'Something went wrong.')
      }
    } catch (err) {
      console.error(err)
      alert('Failed to submit form.')
    }

    setSubmitting(false)
  }

  return (
    <div className="p-6 max-w-2xl mx-auto">
      <h1 className="text-2xl font-bold mb-4">Create a Role</h1>
      <form onSubmit={handleSubmit} className="space-y-4">

        <div>
          <label className="block font-semibold">Job Title</label>
          <input
            type="text"
            required
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            className="w-full p-2 border rounded"
          />
        </div>

        <div>
          <label className="block font-semibold">Interview Type</label>
          <select
            value={interviewType}
            onChange={(e) => setInterviewType(e.target.value)}
            className="w-full p-2 border rounded"
          >
            <option value="basic">Basic (screening, ~10 min)</option>
            <option value="detailed">Detailed (leadership, ~20 min)</option>
            <option value="technical">Technical (skills-focused, ~20 min)</option>
          </select>
        </div>

        <div>
          <label className="block font-semibold">Upload Job Description (PDF or DOCX)</label>
          <input
            type="file"
            accept=".pdf,.docx"
            onChange={(e) => setJobFile(e.target.files[0])}
            className="w-full"
            required
          />
        </div>

        <div>
          <label className="block font-semibold">Optional Manual Questions</label>
          <textarea
            rows="4"
            value={manualQuestions}
            onChange={(e) => setManualQuestions(e.target.value)}
            className="w-full p-2 border rounded"
            placeholder="One question per line"
          />
        </div>

        <button
          type="submit"
          disabled={submitting}
          className="bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-700"
        >
          {submitting ? 'Submitting...' : 'Create Role'}
        </button>
      </form>
    </div>
  )
}
