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

function mimeFromExt(filename = '') {
  const ext = path.extname(filename).toLowerCase();
  if (ext === '.pdf')  return 'application/pdf';
  if (ext === '.docx') return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  if (ext === '.txt')  return 'text/plain';
  if (ext === '.doc')  return 'application/msword'; // not parsed below, just for clarity
  return 'application/octet-stream';
}

async function parseBufferToText(buffer, mime, filename) {
  const type = (mime || mimeFromExt(filename)).toLowerCase();
  const ext  = (path.extname(filename || '').toLowerCase() || '').replace('.', '');

  // TXT
  if (type === 'text/plain' || ext === 'txt') {
    return Buffer.isBuffer(buffer) ? buffer.toString('utf8') : String(buffer || '');
  }

  // PDF
  if (type === 'application/pdf' || ext === 'pdf') {
    const out = await pdfParse(buffer);
    return (out.text || '').trim();
  }

  // DOCX
  if (
    type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
    ext === 'docx'
  ) {
    const { value } = await mammoth.extractRawText({ buffer });
    return (value || '').trim();
  }

  // Legacy .doc not supported (avoids native deps)
  throw Object.assign(
    new Error('Unsupported file type. Please upload PDF, DOCX, or TXT.'),
    { status: 415 }
  );
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

  const { data: fileData, error } = await supabase.storage.from(bucket).download(key);
  if (error) {
    throw new Error(`parseJD: download failed - ${error.message || error}`);
  }

  // supabase-js in Node returns a Blob-like; convert to Buffer
  const arrayBuf = await fileData.arrayBuffer();
  const buf = Buffer.from(arrayBuf);

  const text = await parseBufferToText(buf, fileData.type || mimeFromExt(key), key);
  return { text, description: text };
}

module.exports = {
  parseBufferToText,
  parseJD
};
