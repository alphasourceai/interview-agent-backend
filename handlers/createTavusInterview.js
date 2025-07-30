const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');
const { config } = require('dotenv');

config();

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

async function createTavusInterview(candidate) {
  const API_KEY = process.env.TAVUS_API_KEY;
  const WEBHOOK_URL = process.env.TAVUS_WEBHOOK_URL;

  const payload = {
    replica_id: "rfe12d8b9597",
    persona_id: "pdced222244b",
    webhook_url: WEBHOOK_URL
  };

  const headers = {
    'x-api-key': API_KEY,
    'Content-Type': 'application/json'
  };

  try {
    const response = await axios.post(
      'https://tavusapi.com/v2/conversations',
      payload,
      { headers }
    );

    const data = response.data;

    await supabase.from('conversations').insert([{
      candidate_id: candidate.id,
      email: candidate.email,
      name: candidate.name,
      conversation_id: data.conversation_id,
      conversation_url: data.conversation_url
    }]);

    return data;
  } catch (error) {
    console.error("Error creating Tavus interview:", error);
    throw error;
  }
}

module.exports = createTavusInterview;
