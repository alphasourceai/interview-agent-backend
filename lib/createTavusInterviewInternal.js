const fetch = require('node-fetch');
const { supabase } = require('./supabaseClient');
require('dotenv').config();

const TAVUS_API_KEY = process.env.TAVUS_API_KEY;
const TAVUS_PERSONA_ID = process.env.TAVUS_PERSONA_ID;

async function createTavusInterviewInternal({ candidate }) {
  try {
    const fullName = `${candidate.first_name} ${candidate.last_name}`;

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
          candidate_id: candidate.id,
          email: candidate.email,
        },
        variables: {
          name: fullName,
        },
      }),
    });

    const data = await response.json();

    if (!response.ok) {
      console.error('Tavus error:', data);
      throw new Error('Tavus conversation creation failed');
    }

    // Save to interviews table
    await supabase.from('interviews').insert({
      candidate_id: candidate.id,
      role_id: candidate.role_id,
      tavus_id: data.id,
      interview_url: data.url || data.interview_url || null,
      status: 'pending',
      created_at: new Date(),
    });

    return data.url || data.interview_url;
  } catch (error) {
    console.error('createTavusInterviewInternal error:', error);
    throw new Error('Failed to create Tavus interview');
  }
}

module.exports = { createTavusInterviewInternal };
