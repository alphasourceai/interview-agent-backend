'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const {
  ResumeUploadError,
  inspectResumeFile,
  uploadResumeObject
} = require('../src/lib/resumeUpload');

function mammothFixture(name) {
  return fs.readFileSync(path.join(path.dirname(require.resolve('mammoth')), '..', 'test', 'test-data', name));
}

test('resume inspection rejects zero-byte and invalid DOCX files', async () => {
  await assert.rejects(
    inspectResumeFile({ originalname: 'resume.docx', mimetype: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer: Buffer.alloc(0), size: 0 }),
    (error) => error instanceof ResumeUploadError && error.code === 'RESUME_EMPTY'
  );
  await assert.rejects(
    inspectResumeFile({ originalname: 'resume.docx', mimetype: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer: Buffer.from('not-a-docx') }),
    (error) => error instanceof ResumeUploadError && error.code === 'RESUME_UNREADABLE'
  );
});

test('resume inspection rejects a valid but blank DOCX', async () => {
  await assert.rejects(
    inspectResumeFile({
      originalname: 'blank.docx',
      mimetype: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      buffer: mammothFixture('empty.docx')
    }),
    (error) => error instanceof ResumeUploadError && error.code === 'RESUME_EMPTY'
  );
});

test('resume inspection accepts a readable DOCX and records metadata', async () => {
  const result = await inspectResumeFile({
    originalname: 'resume.docx',
    mimetype: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    buffer: mammothFixture('single-paragraph.docx')
  });
  assert.equal(result.extension, 'docx');
  assert.equal(result.parse_status, 'parsed');
  assert.match(result.sha256, /^[a-f0-9]{64}$/);
  assert.ok(result.extracted_text_length >= 20);
});

test('resume upload does not report success when storage rejects the write', async () => {
  const storage = {
    from() {
      return { upload: async () => ({ error: { message: 'blocked' } }) };
    }
  };
  await assert.rejects(
    uploadResumeObject({
      storage,
      bucket: 'resumes',
      objectPath: 'candidate.docx',
      file: { buffer: Buffer.from('x') },
      inspection: { mime_type: 'application/octet-stream' }
    }),
    (error) => error instanceof ResumeUploadError && error.code === 'RESUME_UPLOAD_FAILED'
  );
});
