// utils/jdParser.js
'use strict';

const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

// Server-side Supabase (service role) – used to download from Storage
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

async function parseBufferToText(buffer, mime, filename) {
  const ext = (path.extname(filename || '').toLowerCase() || '').replace('.', '');
  const type = mime || '';

  if (type === 'application/pdf' || ext === 'pdf') {
    const out = await pdfParse(buffer);
    return (out.text || '').trim();
  }

  if (type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' || ext === 'docx') {
    const { value } = await mammoth.extractRawText({ buffer });
    return (value || '').trim();
  }

  throw Object.assign(new Error('Unsupported file type. Please upload PDF or DOCX.'), { status: 415 });
}

/**
 * Download a JD from Storage and return extracted text.
 * @param {{ path: string }} args - stored path like "job-descriptions/1234-abc.pdf" (bucket + key)
 */
async function parseJD({ path: storedPath }) {
  if (!storedPath || typeof storedPath !== 'string') {
    throw new Error('parseJD: path is required');
  }

  // Expect "bucket/key..."
  const firstSlash = storedPath.indexOf('/');
  if (firstSlash <= 0) {
    throw new Error(`parseJD: expected "bucket/key", got "${storedPath}"`);
  }
  const bucket = storedPath.slice(0, firstSlash);
  const key = storedPath.slice(firstSlash + 1);

  const { data: fileData, error } = await supabase
    .storage
    .from(bucket)
    .download(key);

  if (error) {
    throw new Error(`parseJD: download failed - ${error.message || error}`);
  }

  // supabase-js in Node returns a Blob-like; get ArrayBuffer then Buffer
  const arrayBuf = await fileData.arrayBuffer();
  const buf = Buffer.from(arrayBuf);

  const ext = (path.extname(key || '').toLowerCase() || '').replace('.', '');
  const mime =
    ext === 'pdf'  ? 'application/pdf' :
    ext === 'docx' ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' :
    '';

  const text = await parseBufferToText(buf, mime, key);
  return { text, description: text }; // return both; caller may use description
}

module.exports = {
  parseBufferToText,
  parseJD
};
