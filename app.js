const express = require('express');
const dotenv = require('dotenv');
const { handleResumeUpload } = require('./handlers/resumeUpload');
const { handleWebhook } = require('./handlers/recordingReady');

dotenv.config();

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.get('/', (req, res) => res.send('Interview Agent Backend Running'));

app.post('/upload-resume', handleResumeUpload);
app.post('/webhook/recording-ready', handleWebhook);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});

const { handleTavusWebhook } = require('./handlers/tavusWebhook');
app.post('/api/tavus-webhook', express.json(), handleTavusWebhook);
