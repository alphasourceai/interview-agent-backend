// src/pages/VerifyOtp.jsx
import React, { useEffect, useRef, useState, useCallback } from "react";
import { useSearchParams } from "react-router-dom";

export default function VerifyOtp() {
  const [params] = useSearchParams();

  const emailFromQuery = params.get("email") || "";
  const roleIdFromQuery = params.get("role_id") || "";
  const candidateIdFromQuery = params.get("candidate_id") || "";

  const [email, setEmail] = useState(emailFromQuery);
  const [roleId, setRoleId] = useState(roleIdFromQuery);
  const [candidateId, setCandidateId] = useState(candidateIdFromQuery);
  const [otp, setOtp] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [verifying, setVerifying] = useState(false);
  const [creating, setCreating] = useState(false);

  const [interviewId, setInterviewId] = useState(
    () => sessionStorage.getItem("interviewId") || ""
  );

  const otpRef = useRef(null);
  const API_BASE = (import.meta.env.VITE_BACKEND_URL || "").replace(/\/+$/, "");

  useEffect(() => {
    otpRef.current?.focus();
  }, []);

  const extractLink = (obj) =>
    obj?.video_url || obj?.conversation_url || obj?.redirect_url || obj?.url || obj?.link || null;

  const startInterview = useCallback(
    async (candId, rId, verifiedEmail) => {
      if (!candId) {
        setMessage("Verified, but missing candidate ID.");
        return;
      }
      setCreating(true);
      setError("");
      setMessage("");
      try {
        const resp = await fetch(`${API_BASE}/create-tavus-interview`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ candidate_id: candId, role_id: rId, email: verifiedEmail })
        });
        const data = await resp.json();

        if (!resp.ok) {
          setError(data?.error || "Could not start interview.");
          return;
        }

        if (data?.interview_id) {
          setInterviewId(data.interview_id);
          sessionStorage.setItem("interviewId", data.interview_id);
        }

        const link = extractLink(data);
        if (link) {
          window.location.href = link;
          return;
        }
        setMessage("Interview room is initializing. You can try again or use Resume.");
      } catch (e) {
        setError("Network error creating interview.");
      } finally {
        setCreating(false);
      }
    },
    [API_BASE]
  );

  const resumeInterview = useCallback(
    async () => {
      if (!interviewId) {
        setMessage("No interview to resume yet.");
        return;
      }
      setCreating(true);
      setError("");
      setMessage("");
      try {
        const resp = await fetch(`${API_BASE}/interviews/${interviewId}/retry-create`, { method: "POST" });
        const data = await resp.json();
        if (!resp.ok) {
          setError(data?.error || "Could not resume yet.");
          return;
        }
        const link = extractLink(data);
        if (link) {
          window.location.href = link;
          return;
        }
        setMessage(data?.message || "Room not ready—try again shortly.");
      } catch (e) {
        setError("Network error resuming interview.");
      } finally {
        setCreating(false);
      }
    },
    [API_BASE, interviewId]
  );

  const onSubmit = async (e) => {
    e.preventDefault();
    setVerifying(true);
    setError("");
    setMessage("");

    if (!email || !/^\d{6}$/.test(otp)) {
      setError("Enter your email and a 6-digit code.");
      setVerifying(false);
      return;
    }

    try {
      const resp = await fetch(`${API_BASE}/api/candidate/verify-otp`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, code: otp })
      });
      const data = await resp.json();

      if (!resp.ok) {
        setError(data?.error || "Verification failed.");
        return;
      }

      const nextCandidateId = data?.candidate_id || candidateId;
      const nextRoleId = data?.role_id || roleId;
      const verifiedEmail = data?.email || email;

      setCandidateId(nextCandidateId || "");
      setRoleId(nextRoleId || "");
      setMessage("Verified. Launching your interview…");

      await startInterview(nextCandidateId, nextRoleId, verifiedEmail);
    } catch (e) {
      setError("Network error verifying code.");
    } finally {
      setVerifying(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center p-6">
      <div className="w-full max-w-md bg-white shadow rounded-2xl p-6">
        <h1 className="text-xl font-semibold mb-4">Verify your code</h1>

        <form onSubmit={onSubmit} className="space-y-4">
          <div>
            <label className="block text-sm mb-1">Email</label>
            <input
              type="email"
              className="w-full border rounded px-3 py-2"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              readOnly={!!emailFromQuery}
            />
          </div>

          <div>
            <label className="block text-sm mb-1">6-digit code</label>
            <input
              ref={otpRef}
              type="text"
              inputMode="numeric"
              pattern="\d{6}"
              maxLength={6}
              className="w-full border rounded px-3 py-2 tracking-widest"
              value={otp}
              onChange={(e) => setOtp(e.target.value.replace(/\D/g, ""))}
              placeholder="••••••"
              required
            />
          </div>

          {error ? <p className="text-red-600 text-sm">{error}</p> : null}
          {message ? <p className="text-green-700 text-sm">{message}</p> : null}

          <button
            type="submit"
            disabled={verifying || creating}
            className="w-full bg-black text-white rounded px-4 py-2"
          >
            {verifying ? "Verifying…" : creating ? "Starting…" : "Submit"}
          </button>
        </form>

        {(interviewId || (!verifying && !creating && message)) && (
          <div className="mt-4 space-y-2">
            <button
              type="button"
              disabled={creating}
              onClick={() => startInterview(candidateId, roleId, email)}
              className="w-full border rounded px-4 py-2"
            >
              Try launching again
            </button>

            {interviewId ? (
              <button
                type="button"
                disabled={creating}
                onClick={resumeInterview}
                className="w-full border rounded px-4 py-2"
              >
                Resume interview
              </button>
            ) : null}
          </div>
        )}

        {import.meta.env.DEV && (
          <p className="text-xs text-gray-500 mt-3">
            Dev tip: OTP lives in <code>otp_tokens</code> if SMS isn’t wired yet.
          </p>
        )}
      </div>
    </div>
  );
}
