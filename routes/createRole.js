const express = require('express');
const router = express.Router();
const multer = require('multer');
const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');
const { createClient } = require('@supabase/supabase-js');
const { OpenAI } = require('openai');
const { v4: uuidv4 } = require('uuid');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Multer config (store uploads in memory)
const storage = multer.memoryStorage();
const upload = multer({ storage: storage });

router.post('/', upload.single('job_description_file'), async (req, res) => {
  try {
    const { title, interview_type, client_id } = req.body;
    let manual_questions = [];

    // Validate required fields
    if (!title || !interview_type || !client_id || !req.file) {
      return res.status(400).json({ error: 'Missing required fields.' });
    }

    // Parse manual_questions if present
    if (req.body.manual_questions) {
      try {
        manual_questions = JSON.parse(req.body.manual_questions);
        if (!Array.isArray(manual_questions)) throw new Error();
      } catch (err) {
        return res.status(400).json({ error: 'manual_questions must be a JSON array.' });
      }
    }

    // Store uploaded file in Supabase Storage
    const fileBuffer = req.file.buffer;
    const fileType = req.file.originalname.split('.').pop().toLowerCase();
    const fileName = `${Date.now()}-${req.file.originalname}`;
    const { data: uploadData, error: uploadError } = await supabase.storage
      .from('resumes') // Consider renaming to 'job-descriptions'
      .upload(`job-descriptions/${fileName}`, fileBuffer);

    if (uploadError) {
      return res.status(500).json({ error: 'Failed to upload job description file.' });
    }

    const job_description_url = uploadData.path;

    // Extract text from file
    let extractedText = '';
    if (fileType === 'pdf') {
      const data = await pdfParse(fileBuffer);
      extractedText = data.text;
    } else if (fileType === 'docx') {
      const result = await mammoth.extractRawText({ buffer: fileBuffer });
      extractedText = result.value;
    } else {
      return res.status(400).json({ error: 'Unsupported file type. Upload PDF or DOCX.' });
    }

    // Build OpenAI prompt
    const basePrompt = {
      basic: `You are an AI assistant creating quick screening questions. Based on the job description provided, generate 4 to 6 concise, easy-to-answer interview questions to assess general fit and communication ability.`,
      detailed: `You are an AI assistant creating structured leadership-style interview questions. Based on the job description, generate 6 to 8 open-ended questions that assess decision-making, collaboration, leadership, and experience.`,
      technical: `You are an AI assistant generating technical screening questions. Based on the job description, generate 6 to 8 questions that test practical skills and problem-solving.`
    };

    const systemPrompt = basePrompt[interview_type.toLowerCase()] || basePrompt.basic;

    const completion = await openai.chat.completions.create({
      model: "gpt-4",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: extractedText },
        { role: "user", content: "Please format the questions in a numbered list with no extra commentary." }
      ],
      temperature: 0.7
    });

    const aiQuestions = completion.choices[0].message.content
      .split('\n')
      .filter(line => line.trim())
      .map(q => ({
        text: q.replace(/^\d+\.\s*/, '').trim(),
        category: 'auto'
      }));

    const manualFormatted = manual_questions.map(q => ({
      text: q,
      category: 'manual'
    }));

    const combinedQuestions = [...aiQuestions, ...manualFormatted];

    // 🔐 Generate role token
    const slug_or_token = uuidv4();

    // 📥 Insert role into Supabase
    const { data, error } = await supabase.from('roles').insert([
      {
        title,
        description: extractedText,
        rubric: { questions: combinedQuestions },
        interview_type,
        client_id,
        job_description_url,
        slug_or_token // ✅ Injected token
      }
    ]).select().single();

    if (error) {
      throw new Error(error.message);
    }

    return res.status(200).json({
      message: 'Role created successfully',
      role_id: data.id,
      slug_or_token: data.slug_or_token,
      questions: combinedQuestions
    });

  } catch (error) {
    console.error('Error in createRole:', error.message);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
