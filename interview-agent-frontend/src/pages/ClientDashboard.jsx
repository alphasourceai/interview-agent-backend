import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabaseClient'
import { Link } from 'react-router-dom'

export default function ClientDashboard() {
  const [roles, setRoles] = useState([])
  const [candidateCounts, setCandidateCounts] = useState({})

  const clientId = '230f8351-f284-450e-b1d8-adeef448b70a' // 🔒 TEMP until auth

  useEffect(() => {
    const fetchRolesAndCounts = async () => {
      // 1. Get roles
      const { data: rolesData, error: rolesError } = await supabase
        .from('roles')
        .select('*')
        .eq('client_id', clientId)

      if (rolesError) {
        console.error('Error fetching roles:', rolesError)
        return
      }

      setRoles(rolesData)

      // 2. Get candidate counts grouped by role_id
    const { data: candidatesData, error: candidatesError } = await supabase
  .from('candidates')
  .select('id, role_id')
  .eq('client_id', clientId)

if (candidatesError) {
  console.error('Error fetching candidates:', candidatesError)
  return
}

// Group by role_id manually
const countsMap = {}
candidatesData.forEach((candidate) => {
  const roleId = candidate.role_id
  countsMap[roleId] = (countsMap[roleId] || 0) + 1
})

setCandidateCounts(countsMap)

    }

    fetchRolesAndCounts()
  }, [])

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <h1 className="text-2xl font-bold mb-4">Your Roles</h1>
      <Link to="/create-role" className="text-blue-600 underline mb-2 block">
        Create New Role
      </Link>
      <table className="w-full border">
        <thead>
          <tr className="bg-gray-100">
            <th className="p-2 text-left">Title</th>
            <th className="p-2 text-left">Interview Type</th>
            <th className="p-2 text-left">Candidates Created</th>
            <th className="p-2 text-left">Actions</th>
          </tr>
        </thead>
        <tbody>
          {roles.map((role) => (
            <tr key={role.id} className="border-t">
              <td className="p-2">{role.title}</td>
              <td className="p-2">{role.interview_type}</td>
              <td className="p-2">{candidateCounts[role.id] || 0}</td>
              <td className="p-2">
                <Link to={`/reports/${role.id}`} className="text-blue-600 underline">
                  Reports & Candidates
                </Link>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
