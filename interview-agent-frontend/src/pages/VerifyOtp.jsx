import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';

function VerifyOtp() {
  const [email, setEmail] = useState('');
  const [otp, setOtp] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const navigate = useNavigate();

  const handleSubmit = async (e) => {
    e.preventDefault();
    setSubmitting(true);
    setError('');

    try {
      const response = await fetch(`${import.meta.env.VITE_BACKEND_URL}/api/candidate/verify-otp`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email, code: otp }),
});

      const result = await response.json();

      if (response.ok) {
        window.location.href = result.redirect_url;
      } else {
        setError(result.error || 'Verification failed.');
      }
    } catch (err) {
      console.error('Error verifying OTP:', err);
      setError('Server error. Please try again.');
    }

    setSubmitting(false);
  };

  return (
    <div className="flex flex-col items-center justify-center min-h-screen p-6">
      <h1 className="text-2xl font-semibold mb-4">Verify Your OTP</h1>
      <form onSubmit={handleSubmit} className="w-full max-w-sm bg-white shadow-md rounded px-8 py-6">
        <label className="block mb-2 text-sm font-bold text-gray-700">Email</label>
        <input
          type="email"
          className="w-full mb-4 px-3 py-2 border rounded"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
        />

        <label className="block mb-2 text-sm font-bold text-gray-700">6-Digit OTP</label>
        <input
          type="text"
          className="w-full mb-4 px-3 py-2 border rounded"
          maxLength="6"
          value={otp}
          onChange={(e) => setOtp(e.target.value)}
          required
        />

        {error && <p className="text-red-500 mb-4">{error}</p>}

        <button
          type="submit"
          disabled={submitting}
          className="bg-[#00cfc8] text-white px-4 py-2 rounded hover:bg-[#00b8b1] w-full"
        >
          {submitting ? 'Verifying...' : 'Submit OTP'}
        </button>
      </form>
    </div>
  );
}

export default VerifyOtp;
