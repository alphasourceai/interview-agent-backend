import { useState } from 'react';
import axios from 'axios';

export default function VerifyOtpForm({ email }) {
  const [code, setCode] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  const handleSubmit = async (e) => {
    e.preventDefault();
    setSubmitting(true);
    setError('');
    setMessage('');

    try {
      const res = await axios.post('/api/candidate/verify-otp', {
        email,
        code,
      });

      if (res.data.redirect_url) {
        window.location.href = res.data.redirect_url;
      } else {
        setMessage(res.data.message);
      }
    } catch (err) {
      setError(err.response?.data?.error || 'Verification failed.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="max-w-md mx-auto space-y-4">
      <input
        type="text"
        name="code"
        placeholder="Enter OTP"
        value={code}
        onChange={(e) => setCode(e.target.value)}
        required
      />
      <button type="submit" disabled={submitting}>
        {submitting ? 'Verifying...' : 'Verify & Start Interview'}
      </button>
      {error && <p className="text-red-500">{error}</p>}
      {message && <p className="text-green-600">{message}</p>}
    </form>
  );
}
