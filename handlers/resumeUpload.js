const multer = require('multer');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const analyzeResume = require('../analyzeResume');
const { supabaseAdmin: supabase } = require('../src/lib/supabaseClient');

const storage = multer.memoryStorage();
const upload = multer({ storage });

const handleResumeUpload = [
  upload.single('resume'),
  async (req, res) => {
    const request_id = req.request_id || null;
    try {
      const { name, email, role_id } = req.body;
      const resumeFile = req.file;
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
        resume_score: Number(analysis.resume_score) || 0,
        skills_match_percent: Number(analysis.skills_match_percent) || 0,
        experience_match_percent: Number(analysis.experience_match_percent) || 0,
        education_match_percent: Number(analysis.education_match_percent) || 0,
        overall_resume_match_percent: Number(analysis.overall_resume_match_percent) || 0,
        resume_summary: analysis.summary || '',
        resume_analysis: {
          experience_match_percent: Number(analysis.experience_match_percent) || 0,
          skills_match_percent: Number(analysis.skills_match_percent) || 0,
          education_match_percent: Number(analysis.education_match_percent) || 0,
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
