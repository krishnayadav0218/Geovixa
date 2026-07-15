require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const authRoutes = require('./routes/auth');
const employeeRoutes = require('./routes/employees');
const attendanceRoutes = require('./routes/attendance');
const exportRoutes = require('./routes/export');

// Ensure admin & manager accounts exist on first run
require('./seedAdmin');
require('./seedManager');

const app = express();

app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
app.use(cors());
app.use(express.json({ limit: '10mb' })); // allows base64 selfie photos in request body

// ---- Brute-force protection on login endpoints ----
// Max 8 attempts per 15 minutes per IP on any /api/auth/*login* route.
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

// Serve the admin web portal (static files)
app.use(express.static(path.join(__dirname, 'public')));

// Serve saved selfie photos (written by photoStorage.js) at /uploads/photos/<file>
const DATA_DIR = process.env.DATA_DIR || __dirname;
app.use('/uploads', express.static(path.join(DATA_DIR, 'uploads')));

// API routes
app.use('/api/auth', authRoutes);
app.use('/api/employees', employeeRoutes);
app.use('/api/attendance', attendanceRoutes);
app.use('/api/export', exportRoutes);

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', project: process.env.PROJECT_NAME || 'MTDC' });
});

// Fallback to portal index for any non-API route (simple SPA support)
app.get(/^(?!\/api).*/, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`\n🚀 MTDC Attendance Backend running on port ${PORT}`);
  console.log(`   Admin portal:  http://localhost:${PORT}`);
  console.log(`   API base:      http://localhost:${PORT}/api\n`);
});
