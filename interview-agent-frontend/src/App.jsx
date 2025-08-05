import React from 'react';
import { Routes, Route } from 'react-router-dom';
import InterviewAccessPage from './pages/InterviewAccessPage';
import VerifyOtp from './pages/VerifyOtp';

function App() {
  return (
    <Routes>
      <Route path="/interview-access/:role_token" element={<InterviewAccessPage />} />
      <Route path="/verify-otp" element={<VerifyOtp />} />
    </Routes>
  );
}

export default App;
