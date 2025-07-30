const axios = require('axios');
const { config } = require('dotenv');

config();

async function createTavusInterview(candidate) {
  const TAVUS_API_KEY = process.env.TAVUS_API_KEY;
  const WEBHOOK_URL = `${process.env.TAVUS_WEBHOOK_URL}?candidate_id=${candidate.id}&email=${candidate.email}`;

  const payload = {
    replica_id: "rfe12d8b9597",
    persona_id: "pdced222244b",
    webhook_url: WEBHOOK_URL
  };

  const headers = {
    'x-api-key': TAVUS_API_KEY,
    'Content-Type': 'application/json'
  };

  const response = await axios.post(
    'https://tavusapi.com/v2/conversations',
    payload,
    { headers }
  );

  return response.data?.conversation_url || null;
}

module.exports = createTavusInterview;
