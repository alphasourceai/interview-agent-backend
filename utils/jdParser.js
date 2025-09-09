// utils/jdParser.js
const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');
const path = require('path');

async function parseBufferToText(buffer, mime, filename) {
  const ext = (path.extname(filename || '').toLowerCase() || '').replace('.', '');
  const type = mime || '';

  // Prefer by mime, fallback to extension
  if (type === 'application/pdf' || ext === 'pdf') {
    const out = await pdfParse(buffer);
    return (out.text || '').trim();
  }

  if (type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' || ext === 'docx') {
    const { value } = await mammoth.extractRawText({ buffer });
    return (value || '').trim();
  }

  // Legacy .doc not supported in this pass (avoid native deps)
  throw Object.assign(new Error('Unsupported file type. Please upload PDF or DOCX.'), { status: 415 });
}

module.exports = { parseBufferToText };
