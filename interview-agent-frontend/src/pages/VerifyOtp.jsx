// /src/pages/VerifyOtp.jsx
import React, { useEffect, useState, useRef, useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';

function VerifyOtp() {
  const [params] = useSearchParams();
  const emailFromQuery = params.get('email') || '';
  const roleIdFromQuery = params.get('role_id') || '';
  const candidateIdFromQuery = params.get('candidate_id') || '';

  const [email, setEmail] = useState(emailFromQuery);
  const [otp, setOtp] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState('');
  const [creating, setCreating] = useState(false);
  const otpInputRef = useRef(null);

  const API_BASE = import.meta.env.VITE_BACKEND_URL;

  useEffect(() => {
    otpInputRef.current?.focus();
  }, []);

  const extractLink = (data) =>
    data?.video_url ||
    data?.redirect_url ||
    data?.conversation_url ||
    data?.url ||
    data?.link ||
    null;

  const startInterview = useCallback(
    async (candidate_id, role_id, verifiedEmail) => {
      setCreating(true);
      setError('');
      try {
        const resp = await fetch(`${API_BASE}/create-tavus-interview`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            candidate_id,
            name: '', // optional
            email: verifiedEmail,
            role_id
          })
        });

        const data = await resp.json();
        if (!resp.ok) {
          // Back end will send a helpful error message if Tavus times out
          setMessage(data.message || 'Interview link not ready yet. Please try again.');
          return;
        }

        const link = extractLink(data);
        if (link) {
          window.location.href = link;
          return;
        }

        setMessage('Verified. Interview link not ready yet—please try again.');
      } catch (e) {
        console.error('create-tavus-interview failed:', e);
        setMessage('Verified. Interview link not ready yet—please try again.');
      } finally {
        setCreating(false);
      }
    },
    [API_BASE]
  );

  const handleSubmit = async (e) => {
    e.preventDefault();
    setSubmitting(true);
    setError('');
    setMessage('');

    if (!/^\d{6}$/.test(otp)) {
      setError('Please enter the 6-digit code.');
      setSubmitting(false);
      return;
    }

    try {
      // 1) Verify OTP (FAST) — no Tavus call here
      const response = await fetch(`${API_BASE}/api/candidate/verify-otp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, code: otp })
      });

      const result = await response.json();

      if (!response.ok) {
        setError(result.error || 'Verification failed.');
        return;
      }

      setMessage(result.message || 'Verified.');
      const candidate_id = result.candidate_id || candidateIdFromQuery || '';
      const role_id = result.role_id || roleIdFromQuery || '';

      // 2) Now create Tavus interview (separate call)
      if (candidate_id && role_id && (result.email || email)) {
        await startInterview(candidate_id, role_id, result.email || email);
      } else {
        setMessage('Verified. Missing candidate or role information.');
      }
    } catch (err) {
      console.error('Error verifying OTP:', err);
      setError('Server error. Please try again.');
    } finally {
      setSubmitting(false);
    }
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
          readOnly={!!emailFromQuery}
        />

        <label className="block mb-2 text-sm font-bold text-gray-700">6-Digit OTP</label>
        <input
          ref={otpInputRef}
          type="text"
          inputMode="numeric"
          maxLength={6}
          pattern="\d{6}"
          className="w-full mb-4 px-3 py-2 border rounded"
          value={otp}
          onChange={(e) => setOtp(e.target.value.replace(/\D/g, ''))}
          required
        />

        {error && <p className="text-red-500 mb-4">{error}</p>}
        {message && <p className="text-green-600 mb-4">{message}</p>}

        <button
          type="submit"
          disabled={submitting || creating}
          className="bg-[#00cfc8] text-white px-4 py-2 rounded hover:bg-[#00b8b1] w-full"
        >
          {submitting ? 'Verifying...' : creating ? 'Starting interview…' : 'Submit OTP'}
        </button>

        {/* If Tavus was slow/timeouts, allow retry without re-entering OTP */}
        {message && !error && !submitting && !creating && (
          <button
            type="button"
            onClick={() =>
              startInterview(
                candidateIdFromQuery,
                roleIdFromQuery,
                email
              )
            }
            className="mt-3 w-full border px-4 py-2 rounded"
          >
            Try launching interview again
          </button>
        )}

        {import.meta.env.DEV && (
          <p className="text-xs text-gray-500 mt-3">
            Tip: If SMS is disabled, copy the latest code from the <code>otp_tokens</code> table.
          </p>
        )}
      </form>
    </div>
  );
}

export default VerifyOtp;
