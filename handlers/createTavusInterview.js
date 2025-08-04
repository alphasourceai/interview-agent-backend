const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');
const { config } = require('dotenv');

config();

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

async function createTavusInterview(candidate) {
  console.log('Incoming candidate payload:', candidate);

  const API_KEY = process.env.TAVUS_API_KEY;
  const WEBHOOK_URL = process.env.TAVUS_WEBHOOK_URL;

  try {
    // 1. Get the role and rubric
    const { data: role, error: roleError } = await supabase
      .from('roles')
      .select('rubric')
      .eq('id', candidate.role_id)
      .single();

    if (roleError || !role) {
      throw new Error('Invalid role_id or missing rubric.');
    }

    // 2. Insert candidate into `candidates` table
    const { data: insertedCandidate, error: insertError } = await supabase
      .from('candidates')
      .insert([{ name: candidate.name, email: candidate.email, role_id: candidate.role_id }])
      .select()
      .single();

    if (insertError) {
      throw new Error(`Candidate insert failed: ${insertError.message}`);
    }

    // 3. Create Tavus conversation
    const response = await axios.post(
      'https://tavusapi.com/v2/conversations',
      {
        replica_id: "rfe12d8b9597",
        persona_id: "pdced222244b",
        webhook_url: WEBHOOK_URL
      },
      {
        headers: {
          'x-api-key': API_KEY,
          'Content-Type': 'application/json'
        }
      }
    );

    const data = response.data;

    // 4. Insert into `interviews`
    const { error: interviewError } = await supabase.from('interviews').insert([
      {
        candidate_id: insertedCandidate.id,
        video_url: data.conversation_url,
        tavus_application_id: data.conversation_id,
        status: 'Pending',
        role_id: candidate.role_id,
        rubric: role.rubric
      }
    ]);

    if (interviewError) {
      throw new Error(`Interview insert failed: ${interviewError.message}`);
    }

    return data;
  } catch (error) {
    console.error('Error creating Tavus interview:', error.message);
    throw error;
  }
}

module.exports = createTavusInterview;
