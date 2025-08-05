import React from 'react';
import { useParams } from 'react-router-dom';
import InterviewAccessForm from '../components/InterviewAccessForm';

const InterviewAccessPage = () => {
  const { role_token } = useParams();

  return (
    <div className="p-4 max-w-2xl mx-auto">
      <h1 className="text-2xl font-bold mb-4">Start Your Interview</h1>
      <InterviewAccessForm roleToken={role_token} />
    </div>
  );
};

export default InterviewAccessPage;
