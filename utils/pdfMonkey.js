const axios = require('axios');

const PDFMONKEY_API_KEY = process.env.PDFMONKEY_API_KEY;
const TEMPLATE_ID = process.env.PDFMONKEY_TEMPLATE_ID;

async function generateCandidatePDF(candidateData) {
  try {
    const response = await axios.post(
      'https://api.pdfmonkey.io/api/v1/documents',
      {
        document: {
          template_id: TEMPLATE_ID,
          payload: candidateData
        }
      },
      {
        headers: {
          Authorization: `Bearer ${PDFMONKEY_API_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );

    return response.data.data.attributes.download_url;
  } catch (err) {
    console.error('Error generating PDF:', err.response?.data || err.message);
    throw new Error('Failed to generate candidate PDF');
  }
}

module.exports = { generateCandidatePDF };
