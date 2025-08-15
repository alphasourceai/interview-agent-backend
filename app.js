require('dotenv').config();
const express = require('express');
const cors = require('cors');

const app = express();

const ALLOWED_ORIGINS = [
  'http://localhost:5173',
  'https://interview-agent-frontend.onrender.com'
];

app.use(cors({
  origin: (origin, cb) => {
    if (!origin || ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    return cb(new Error('Not allowed by CORS'));
  },
  credentials: true
}));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

const { handleTavusWebhook } = require('./handlers/tavusWebhook');
const candidateRoutes = require('./routes/candidates');
const reportRoutes = require('./routes/reports');
const createRoleRoute = require('./routes/createRole');
const candidateSubmitRoute = require('./routes/candidateSubmit');
const verifyOtpRoute = require('./routes/verifyOtp');
const { kbRouter } = require('./routes/kb');
const createInterviewRouter = require('./routes/createTavusInterview');
const retryRouter = require('./routes/retryInterview');
const webhookRouter = require('./routes/webhook');

app.use('/webhook', webhookRouter);
app.get('/health', (req, res) => res.status(200).json({ ok: true }));

app.use('/candidates', candidateRoutes);
app.use('/reports', reportRoutes);
app.use('/create-role', createRoleRoute);
app.use('/api/candidate/submit', candidateSubmitRoute);
app.use('/api/candidate/verify-otp', verifyOtpRoute);
app.use('/kb', kbRouter);
app.use('/create-tavus-interview', createInterviewRouter);
app.use('/interviews', retryRouter);

app.post('/webhook/recording-ready', handleTavusWebhook);

if (process.env.USE_FAKE_TAVUS === 'true' && process.env.NODE_ENV !== 'production') {
  app.post('/dev/mock/webhook/recording-ready', (req, res, next) => {
    req.body = {
      conversation_id: 'fake-' + Date.now(),
      video_url: 'https://example.com/fake.mp4'
    };
    return handleTavusWebhook(req, res, next);
  });
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});

module.exports = app;
