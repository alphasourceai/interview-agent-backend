const multer = require('multer');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const analyzeResume = require('../analyzeResume');
const { supabaseAdmin: supabase } = require('../src/lib/supabaseClient');
const { ResumeUploadError, inspectResumeFile } = require('../src/lib/resumeUpload');

const storage = multer.memoryStorage();
const upload = multer({ storage, limits: { fileSize: 10 * 1024 * 1024 } });

function nullableScore(value) {
  if (value === null || value === undefined || String(value).trim() === '') return null;
  const score = Number(value);
  return Number.isFinite(score) ? Math.max(0, Math.min(100, score)) : null;
}

const handleResumeUpload = [
  upload.single('resume'),
  async (req, res) => {
    const request_id = req.request_id || null;
    try {
      const { name, email, role_id } = req.body;
      const resumeFile = req.file;
      if (!resumeFile) {
        return res.status(400).json({
          error: 'resume_required',
          code: 'resume_required',
          detail: 'Choose a resume file and try again.',
          hint: null,
          request_id
        });
      }
      try {
        await inspectResumeFile(resumeFile);
      } catch (error) {
        if (error instanceof ResumeUploadError) {
          return res.status(400).json({
            error: String(error.code || 'resume_unreadable').toLowerCase(),
            code: error.code,
            detail: error.detail,
            hint: null,
            request_id
          });
        }
        throw error;
      }
      const fileExt = path.extname(resumeFile.originalname);
      const candidate_id = `cand-${uuidv4()}`;
      const storagePath = `${candidate_id}${fileExt}`;

      const { data: uploadData, error: uploadError } = await supabase.storage
        .from('resumes')
        .upload(storagePath, resumeFile.buffer, {
          contentType: resumeFile.mimetype,
          upsert: true,
        });

      if (uploadError) {
        return res.status(500).json({ error: 'Resume upload failed', details: uploadError });
      }

      const resumeStoragePath = `resumes/${uploadData?.path || storagePath}`;

      const role = await supabase.from('roles').select('id, title, description, client_id').eq('id', role_id).single();
      let analysis;
      try {
        analysis = await analyzeResume(resumeFile.buffer, resumeFile.mimetype, role.data || {}, candidate_id);
      } catch (analysisErr) {
        return res.status(500).json({
          error: 'resume_analysis_failed',
          code: 'resume_analysis_failed',
          detail: analysisErr?.message || String(analysisErr || ''),
          hint: null,
          request_id
        });
      }


      const analysisSummary = {
        resume_score: nullableScore(analysis.resume_score),
        skills_match_percent: nullableScore(analysis.skills_match_percent),
        experience_match_percent: nullableScore(analysis.experience_match_percent),
        education_match_percent: nullableScore(analysis.education_match_percent),
        overall_resume_match_percent: nullableScore(analysis.overall_resume_match_percent),
        resume_summary: analysis.summary || '',
        evidence: Array.isArray(analysis.evidence) ? analysis.evidence : [],
        analysis_status: analysis.analysis_status || 'unavailable',
        resume_integrity: analysis.resume_integrity || null,
        resume_analysis: {
          experience_match_percent: nullableScore(analysis.experience_match_percent),
          skills_match_percent: nullableScore(analysis.skills_match_percent),
          education_match_percent: nullableScore(analysis.education_match_percent),
          summary: analysis.summary || ''
        }
      };

      const { data: candidate, error: dbError } = await supabase
        .from('candidates')
        .insert([{
          id: uuidv4(),
          candidate_id,
          name,
          email,
          role_id,
          upload_ts: new Date().toISOString(),
          status: 'Resume Uploaded',
          interview_status: 'pending',
          resume_url: resumeStoragePath,
          analysis_summary: analysisSummary
        }])
        .select()
        .single();

      if (dbError) {
        return res.status(500).json({ error: 'Failed to save candidate metadata', dbError });
      }

      return res.json({ message: 'Resume uploaded and analyzed', candidate, resume_url: resumeStoragePath, analysis });
    } catch (err) {
      console.error(err);
      return res.status(500).json({
        error: 'internal_server_error',
        code: 'internal_server_error',
        detail: err?.message || String(err || ''),
        hint: null,
        request_id
      });
    }
  }
];

module.exports = { handleResumeUpload };
