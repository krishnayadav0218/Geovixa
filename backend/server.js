require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const { init } = require('./db');
const seedAdmin = require('./seedAdmin');
const seedManager = require('./seedManager');

const authRoutes = require('./routes/auth');
const employeeRoutes = require('./routes/employees');
const attendanceRoutes = require('./routes/attendance');
const exportRoutes = require('./routes/export');

const app = express();

app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
app.use(cors());
app.use(express.json({ limit: '10mb' })); // allows base64 selfie photos in request body

// brute-force protection on login endpoints — max 8 attempts / 15 min / ip
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 8,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts. Please try again after 15 minutes.' },
});
app.use('/api/auth/login', loginLimiter);
app.use('/api/auth/admin-login', loginLimiter);
app.use('/api/auth/employee-login', loginLimiter);

// admin web portal (static files)
app.use(express.static(path.join(__dirname, 'public')));

// saved selfie photos (written by photoStorage.js), served at /uploads/photos/<file>
const DATA_DIR = process.env.DATA_DIR || __dirname;
app.use('/uploads', express.static(path.join(DATA_DIR, 'uploads')));

// api routes
app.use('/api/auth', authRoutes);
app.use('/api/employees', employeeRoutes);
app.use('/api/attendance', attendanceRoutes);
app.use('/api/export', exportRoutes);

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', project: process.env.PROJECT_NAME || 'Krystal Connect' });
});

// fallback to portal index for any non-api route (simple SPA support)
app.get(/^(?!\/api).*/, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 5000;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// DB setup + seeding both hit Postgres now, so they're async — everything has to
// finish before the server actually starts accepting requests.
async function start() {
  const MAX_ATTEMPTS = 5;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      await init();
      break; // connected fine, move on to seeding + listen
    } catch (err) {
      const isLastAttempt = attempt === MAX_ATTEMPTS;
      console.error(`DB connection attempt ${attempt}/${MAX_ATTEMPTS} failed: ${err.message}`);
      if (isLastAttempt) throw err;
      // Backs off 3s, 6s, 9s, 12s — covers the handful of seconds it can take Supabase's
      // pooler to accept connections right after the app cold-starts on Render's free tier.
      await sleep(3000 * attempt);
    }
  }

  await seedAdmin();
  await seedManager();

  app.listen(PORT, () => {
    console.log(`\n🚀 Krystal Connect Attendance Backend running on port ${PORT}`);
    console.log(`   Admin portal:  http://localhost:${PORT}`);
    console.log(`   API base:      http://localhost:${PORT}/api\n`);
  });
}

start().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
