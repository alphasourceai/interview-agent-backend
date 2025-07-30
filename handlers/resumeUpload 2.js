const multer = require('multer');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const pdfParse = require('pdf-parse');
const { createClient } = require('@supabase/supabase-js');
const OpenAI = require('openai');
const fs = require('fs');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const storage = multer.memoryStorage();
const upload = multer({ storage });

const handleResumeUpload = [
  upload.single('resume'),
  async (req, res) => {
    try {
      const { name, email, role_id } = req.body;
      const resumeFile = req.file;
      const fileExt = path.extname(resumeFile.originalname);
      const timestamp = Date.now();
      const storagePath = `resumes/${email}-${timestamp}${fileExt}`;

      const { data: uploadData, error: uploadError } = await supabase.storage
        .from('resumes')
        .upload(storagePath, resumeFile.buffer, {
          contentType: resumeFile.mimetype,
          upsert: true,
        });

      if (uploadError) {
        return res.status(500).json({ error: 'Resume upload failed', details: uploadError });
      }

      const publicURL = `https://${process.env.SUPABASE_URL.split('//')[1]}/storage/v1/object/public/${uploadData.path}`;

      const { data: candidate, error: dbError } = await supabase
        .from('candidates')
        .insert([{ id: uuidv4(), name, email, role_id, upload_ts: new Date().toISOString(), status: 'Resume Uploaded' }])
        .select()
        .single();

      if (dbError) {
        return res.status(500).json({ error: 'Failed to save candidate metadata', dbError });
      }

      const pdfText = (await pdfParse(resumeFile.buffer)).text;

      const role = await supabase.from('roles').select('description').eq('id', role_id).single();
      const roleDesc = role.data?.description || 'No role description available';

      const analysisPrompt = `
You are an expert recruiter. Evaluate the following resume against this role description.

Role Description:
${roleDesc}

Resume:
${pdfText}

Use this scoring rubric (0–100 total):
- Skills Match %
- Experience Match %
- Education Match %

Respond in JSON with:
{
  "resume_score": [0–100],
  "skills_match_percent": [0–100],
  "experience_match_percent": [0–100],
  "education_match_percent": [0–100],
  "overall_resume_match_percent": [0–100],
  "summary": "short explanation"
}
`;

      const response = await openai.chat.completions.create({
        model: 'gpt-4-turbo',
        messages: [{ role: 'user', content: analysisPrompt }],
        temperature: 0.3,
      });

      const analysis = JSON.parse(response.choices[0].message.content);

      await supabase.from('reports').insert([
        {
          candidate_id: candidate.id,
          analysis,
          resume_score: analysis.resume_score,
        },
      ]);

      return res.json({ message: 'Resume uploaded and analyzed', candidate, resume_url: publicURL, analysis });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: 'Internal server error', details: err.message });
    }
  }
];

module.exports = { handleResumeUpload };
