import { useState } from 'react';
import axios from 'axios';
import { useNavigate } from 'react-router-dom';

export default function InterviewAccessForm({ roleToken }) {
  const navigate = useNavigate();

  const [formData, setFormData] = useState({
    first_name: '',
    last_name: '',
    email: '',
    phone: '',
    resume: null,
  });

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  const handleChange = (e) => {
    const { name, value, files } = e.target;
    setFormData((prev) => ({
      ...prev,
      [name]: files ? files[0] : value,
    }));
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!roleToken) {
      setError('Missing role link. Please use the correct interview URL.');
      return;
    }

    setSubmitting(true);
    setError('');
    setMessage('');

    const body = new FormData();
    body.append('first_name', formData.first_name);
    body.append('last_name', formData.last_name);
    body.append('email', formData.email);
    body.append('phone', formData.phone);
    body.append('resume', formData.resume);
    body.append('role_token', roleToken);

    try {
      const res = await axios.post(
        `${import.meta.env.VITE_BACKEND_URL}/api/candidate/submit`,
        body
      );

      setMessage(res.data?.message || 'OTP created.');

      // Redirect to OTP entry with the data we returned from the backend
      const { candidate_id, email, role_id } = res.data || {};
      if (candidate_id && email) {
        navigate(
          `/verify-otp?candidate_id=${encodeURIComponent(
            candidate_id
          )}&email=${encodeURIComponent(email)}&role_id=${encodeURIComponent(
            role_id || ''
          )}`
        );
      } else {
        // Fallback: at least carry the email so the user doesn’t retype it
        navigate(`/verify-otp?email=${encodeURIComponent(formData.email)}`);
      }
    } catch (err) {
      setError(err.response?.data?.error || 'Something went wrong.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <input
        type="text"
        name="first_name"
        placeholder="First Name"
        onChange={handleChange}
        required
      />
      <input
        type="text"
        name="last_name"
        placeholder="Last Name"
        onChange={handleChange}
        required
      />
      <input
        type="email"
        name="email"
        placeholder="Email"
        onChange={handleChange}
        required
      />
      <input
        type="tel"
        name="phone"
        placeholder="Phone Number"
        onChange={handleChange}
        required
      />
      <input
        type="file"
        name="resume"
        accept=".pdf,.doc,.docx"
        onChange={handleChange}
        required
      />

      <button type="submit" disabled={submitting || !formData.resume}>
        {submitting ? 'Submitting...' : 'Submit & Get OTP'}
      </button>

      {error && <p className="text-red-500">{error}</p>}
      {message && <p className="text-green-600">{message}</p>}
    </form>
  );
}
