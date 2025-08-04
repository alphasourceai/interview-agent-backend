const axios = require('axios');

const generatePDFReport = async (candidateData) => {
  const payload = {
    name: candidateData.name,
    email: candidateData.email,
    resume_score: candidateData.resume_score || 0,
    interview_score: candidateData.interview_score || 0,
    overall_score: candidateData.overall_score || 0,
    resume_breakdown: {
      experience: candidateData.resume_breakdown?.experience || 0,
      skills: candidateData.resume_breakdown?.skills || 0,
      education: candidateData.resume_breakdown?.education || 0
    },
    interview_breakdown: {
      clarity: candidateData.interview_breakdown?.clarity || 0,
      confidence: candidateData.interview_breakdown?.confidence || 0,
      body_language: candidateData.interview_breakdown?.body_language || 0
    },
    status: candidateData.status || 'Interview Completed'
  };

  const filename = `${candidateData.email}-role name-report-1.pdf`;

  const body = JSON.stringify({
    document: {
      document_template_id: process.env.PDFMONKEY_TEMPLATE_ID,
      payload,
      status: 'pending', // 👈 MUST be passed exactly here
      meta: {
        _filename: filename
      }
    }
  });

  console.log('📄 Payload to PDFMonkey:', JSON.stringify(payload, null, 2));

  try {
    const createResponse = await axios({
      method: 'POST',
      url: 'https://api.pdfmonkey.io/api/v1/documents',
      headers: {
        Authorization: `Bearer ${process.env.PDFMONKEY_API_KEY}`,
        'Content-Type': 'application/json'
      },
      data: body
    });

    const documentId = createResponse.data.document.id;

    // Poll for final PDF
    const maxAttempts = 10;
    const delay = 2000;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      await new Promise(resolve => setTimeout(resolve, delay));

      const statusResponse = await axios.get(
        `https://api.pdfmonkey.io/api/v1/documents/${documentId}`,
        {
          headers: {
            Authorization: `Bearer ${process.env.PDFMONKEY_API_KEY}`
          }
        }
      );

      const doc = statusResponse.data.document;

      if (doc.status === 'success' && doc.download_url) {
        console.log('✅ PDF ready at:', doc.download_url);
        return doc.download_url;
      }

      console.log(`⏳ Polling attempt ${attempt + 1}: status = ${doc.status}`);
    }

    throw new Error('PDF generation timed out or failed');
  } catch (err) {
    console.error('❌ Failed to generate PDF report:', err.message);
    throw new Error('Failed to generate PDF report');
  }
};

module.exports = { generatePDFReport };
