const fetch = require('node-fetch');
require('dotenv').config();

const TAVUS_API_KEY = process.env.TAVUS_API_KEY;
const TAVUS_PERSONA_ID = process.env.TAVUS_PERSONA_ID;

async function createTavusInterview(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).send({ error: 'Method not allowed' });
  }

  const { candidate_id, email, name } = req.body;

  if (!candidate_id || !email || !name) {
    return res.status(400).send({ error: 'Missing candidate_id, name, or email' });
  }

  try {
    const response = await fetch('https://api.tavus.io/conversations', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TAVUS_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        persona_id: TAVUS_PERSONA_ID,
        callback_url: 'https://interview-agent-backend-z6un.onrender.com/tavus-webhook',
        metadata: {
          candidate_id,
          email,
        },
        variables: {
          name,
        },
      }),
    });

    const data = await response.json();

    if (!response.ok) {
      console.error('Tavus error:', data);
      return res.status(500).send({ error: 'Failed to create Tavus conversation' });
    }

    return res.status(200).send({ message: 'Conversation created', data });
  } catch (error) {
    console.error('Error creating Tavus conversation:', error);
    return res.status(500).send({ error: 'Internal server error' });
  }
}

module.exports = { createTavusInterview };

