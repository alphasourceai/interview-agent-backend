// app.js
require('dotenv').config();
const express = require('express');
const cors = require('cors');

const app = express();

/** CORS (simple) */
const DEFAULT_ORIGINS = [
  'http://localhost:5173',
  'https://interview-agent-frontend.onrender.com',
];
const envOrigins = (process.env.CORS_ORIGINS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);
const ALLOWED_ORIGINS = envOrigins.length ? envOrigins : DEFAULT_ORIGINS;

app.use(cors({
  origin: (origin, cb) => {
    if (!origin || ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    return cb(new Error('Not allowed by CORS'));
  },
  credentials: true,
}));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

/** Routes */
const webhookRouter = require('./routes/webhook');
const candidateRoutes = require('./routes/candidates');
const reportRoutes = require('./routes/reports');
const createRoleRoute = require('./routes/createRole');
const candidateSubmitRoute = require('./routes/candidateSubmit');
const verifyOtpRoute = require('./routes/verifyOtp');
const { kbRouter } = require('./routes/kb');
const createInterviewRouter = require('./routes/createTavusInterview');
const retryRouter = require('./routes/retryInterview');

/** Healthcheck */
app.get('/health', (req, res) => res.status(200).json({ ok: true }));

/** Mount routers */
app.use('/webhook', webhookRouter);                 // <— unified Tavus webhook (/webhook/tavus and /webhook/recording-ready)
app.use('/candidates', candidateRoutes);
app.use('/reports', reportRoutes);
app.use('/create-role', createRoleRoute);
app.use('/api/candidate/submit', candidateSubmitRoute);
app.use('/api/candidate/verify-otp', verifyOtpRoute);
app.use('/kb', kbRouter);
app.use('/create-tavus-interview', createInterviewRouter);
app.use('/interviews', retryRouter);

/** NOTE:
 * We intentionally REMOVED the legacy direct mount:
 *   app.post('/webhook/recording-ready', handleTavusWebhook)
 * to avoid conflicting handlers.
 * The new unified router handles:
 *   POST /webhook/recording-ready   (manual tests)
 *   POST /webhook/tavus             (real Tavus callbacks)
 */

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});

module.exports = app;
