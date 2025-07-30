const axios = require('axios');
const { config } = require('dotenv');

config();

async function createTavusInterview(candidate) {
  const TAVUS_API_KEY = process.env.TAVUS_API_KEY;
  const WEBHOOK_URL = process.env.TAVUS_WEBHOOK_URL;

  const payload = {
    webhook_url: WEBHOOK_URL,
    metadata: {
      candidate_id: candidate.id,
      email: candidate.email
    },
    variables: {
      name: candidate.name
    }
  };

  const headers = {
    Authorization: `Bearer ${TAVUS_API_KEY}`,
    'Content-Type': 'application/json'
  };

  const response = await axios.post(
    'https://api.tavus.io/v1/videos',
    payload,
    { headers }
  );

  return response.data?.url || null;
}

module.exports = createTavusInterview;
