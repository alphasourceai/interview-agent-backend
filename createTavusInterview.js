const fetch = require('node-fetch');
require('dotenv').config();
const { resolvePublicBackendBase } = require('./config/urlConfig');
const {
  buildAuthenticatedTavusWebhookUrl,
  omitProviderCallbackUrls,
} = require('./src/lib/tavusWebhookAuth');

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
    const forwardedProto = String(req.headers?.['x-forwarded-proto'] || req.protocol || 'https').split(',')[0].trim();
    const forwardedHost = String(req.headers?.['x-forwarded-host'] || req.get?.('host') || req.headers?.host || '').split(',')[0].trim();
    const computedBase = forwardedHost ? `${forwardedProto || 'https'}://${forwardedHost}` : '';
    const callbackBase = resolvePublicBackendBase(computedBase);
    if (!callbackBase) {
      throw new Error('missing_callback_base_url');
    }
    const callbackUrl = buildAuthenticatedTavusWebhookUrl(`${callbackBase}/webhook/tavus`);

    const response = await fetch('https://api.tavus.io/conversations', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TAVUS_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        persona_id: TAVUS_PERSONA_ID,
        callback_url: callbackUrl,
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
      console.error('Tavus error:', {
        status: response.status,
        provider_code: String(data?.code || data?.error || '').slice(0, 80) || null,
      });
      return res.status(500).send({ error: 'Failed to create Tavus conversation' });
    }

    return res.status(200).send({
      message: 'Conversation created',
      data: omitProviderCallbackUrls(data),
    });
  } catch (error) {
    console.error('Error creating Tavus conversation:', error);
    return res.status(500).send({ error: 'Internal server error' });
  }
}

module.exports = { createTavusInterview };
