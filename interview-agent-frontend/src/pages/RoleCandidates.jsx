import React, { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { supabase } from '../lib/supabaseClient';

export default function RoleCandidates() {
  const { roleId } = useParams();
  const [candidates, setCandidates] = useState([]);

  useEffect(() => {
    const fetchCandidates = async () => {
      const { data, error } = await supabase
        .from('candidates')
        .select('*')
        .eq('role_id', roleId);

      if (error) {
        console.error('Error fetching candidates:', error.message);
      } else {
        setCandidates(data);
      }
    };

    fetchCandidates();
  }, [roleId]);

  return (
    <div style={{ padding: '2rem' }}>
      <h2>Candidates for Role</h2>
      {candidates.length === 0 ? (
        <p>No candidates found for this role.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Email</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {candidates.map((candidate) => (
              <tr key={candidate.id}>
                <td>{candidate.name}</td>
                <td>{candidate.email}</td>
                <td>{candidate.status || 'N/A'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
