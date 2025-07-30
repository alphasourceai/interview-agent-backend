const express = require('express');
const dotenv = require('dotenv');
const { handleResumeUpload } = require('./handlers/resumeUpload');
const { handleWebhook } = require('./handlers/recordingReady');
const createTavusInterviewHandler = require('./handlers/createTavusInterview');

dotenv.config();

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.get('/', (req, res) => res.send('Interview Agent Backend Running'));

app.post('/upload-resume', handleResumeUpload);
app.post('/webhook/recording-ready', handleWebhook);
app.post('/create-tavus-interview', async (req, res) => {
  try {
    const { candidate_id, name, email } = req.body;

    const candidate = {
      id: candidate_id,
      name,
      email
    };

    const video_url = await createTavusInterviewHandler(candidate);

    return res.status(200).json({ message: 'Tavus interview created', video_url });
  } catch (err) {
    console.error('Error creating Tavus interview:', err);
    return res.status(500).json({ error: 'Failed to create Tavus interview' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
