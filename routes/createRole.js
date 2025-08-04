const express = require('express');
const router = express.Router();
const multer = require('multer');
const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');
const { createClient } = require('@supabase/supabase-js');
const { OpenAI } = require('openai');
const fs = require('fs');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Multer config (store uploads in memory)
const storage = multer.memoryStorage();
const upload = multer({ storage: storage });

router.post('/', upload.single('job_description_file'), async (req, res) => {
  try {
    const { title, interview_type } = req.body;
    let manual_questions = [];

    // Validate required fields
    if (!title || !interview_type || !req.file) {
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

    // Extract text from uploaded file
    let extractedText = '';
    const fileBuffer = req.file.buffer;
    const fileType = req.file.originalname.split('.').pop().toLowerCase();

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
  basic: `You are an AI assistant creating quick screening questions. Based on the job description provided, generate 4 to 6 concise, easy-to-answer interview questions to assess general fit and communication ability. These should take no more than 10 minutes for a candidate to respond to.`,

  detailed: `You are an AI assistant creating structured leadership-style interview questions. Based on the job description, generate 6 to 8 open-ended questions that assess decision-making, collaboration, leadership, and role-relevant experience. These should be suitable for a 20-minute initial interview.`,

  technical: `You are an AI assistant generating technical screening questions. Based on the job description, generate 6 to 8 questions that test practical skills, tools, and problem-solving abilities. The questions should be specific to the technologies or methods mentioned in the job description and suitable for a 20-minute technical interview.`
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


    // Extract OpenAI response
    const aiQuestions = completion.choices[0].message.content
      .split('\n')
      .filter(line => line.trim())
      .map(q => q.replace(/^\d+\.\s*/, '').trim());

    const combinedQuestions = [...aiQuestions, ...manual_questions];

    // Insert role into Supabase
    const { data, error } = await supabase.from('roles').insert([
      {
        title,
        description: extractedText,
        rubric: { questions: combinedQuestions },
        interview_type
      }
    ]);

    if (error) {
      throw new Error(error.message);
    }

    return res.status(200).json({
      message: 'Role created successfully',
      questions: combinedQuestions
    });

  } catch (error) {
    console.error('Error in createRole:', error.message);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
