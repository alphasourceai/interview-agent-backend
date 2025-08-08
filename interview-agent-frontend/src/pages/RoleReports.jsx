import React, { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { supabase } from '../lib/supabaseClient';

export default function RoleReports() {
  const { roleId } = useParams();
  const [reports, setReports] = useState([]);

  useEffect(() => {
    const fetchReports = async () => {
      const { data, error } = await supabase
        .from('reports')
        .select('*')
        .eq('role_id', roleId);

      if (error) {
        console.error('Error fetching reports:', error.message);
      } else {
        setReports(data);
      }
    };

    fetchReports();
  }, [roleId]);

  return (
    <div style={{ padding: '2rem' }}>
      <h2>Reports for Role</h2>
      {reports.length === 0 ? (
        <p>No reports found for this role.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Candidate</th>
              <th>Overall Score</th>
              <th>Status</th>
              <th>View</th>
            </tr>
          </thead>
          <tbody>
            {reports.map((report) => (
              <tr key={report.id}>
                <td>{report.candidate_email}</td>
                <td>{report.overall_score}</td>
                <td>{report.status}</td>
                <td>
                  <a href={report.report_url} target="_blank" rel="noopener noreferrer">
                    View PDF
                  </a>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
