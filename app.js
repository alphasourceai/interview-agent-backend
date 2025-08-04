require('dotenv').config();
const express = require('express');
const cors = require('cors');

const { handleResumeUpload } = require('./handlers/resumeUpload');
const { handleTavusWebhook } = require('./handlers/tavusWebhook');
const createTavusInterviewHandler = require('./handlers/createTavusInterview');

const candidateRoutes = require('./routes/candidates');
const reportRoutes = require('./routes/reports');
const createRoleRoute = require('./routes/createRole'); // ✅ NEW: Role Creator Route

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.get('/', (req, res) => res.send('Interview Agent Backend Running'));

app.post('/upload-resume', handleResumeUpload);
app.post('/webhook/recording-ready', handleTavusWebhook);

app.post('/create-tavus-interview', async (req, res) => {
  try {
    const { candidate_id, name, email, role_id } = req.body;

    const candidate = {
      id: candidate_id,
      name,
      email,
      role_id
    };

    const video_url = await createTavusInterviewHandler(candidate);
    return res.status(200).json({ message: 'Tavus interview created', video_url });
  } catch (err) {
    console.error('Error creating Tavus interview:', err);
    return res.status(500).json({ error: 'Failed to create Tavus interview' });
  }
});

app.use('/candidates', candidateRoutes);
app.use('/reports', reportRoutes);
app.use('/create-role', createRoleRoute); // ✅ New route added here

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
