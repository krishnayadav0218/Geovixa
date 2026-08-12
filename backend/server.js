require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

// Every login on this entire platform (every company's Admin/Manager/Coordinator/Employee,
// plus the platform owner) is only as secure as this one secret — anyone who has or guesses
// it can forge a valid session token for ANY account, including super_admin. A missing,
// short, or well-known-default value here would make that trivial, so this is checked before
// the server accepts any traffic at all rather than silently running with a weak secret.
const WEAK_JWT_SECRETS = ['secret', 'changeme', 'change-this', 'your-secret-key', 'jwt_secret', 'password', '12345678', 'replace-with-your-own-long-random-secret'];
if (!process.env.JWT_SECRET) {
  throw new Error(
    'JWT_SECRET is not set. Every login on this platform depends on it — generate one with ' +
    '`openssl rand -hex 32` and set it in your environment before starting the server.'
  );
}
if (process.env.JWT_SECRET.length < 32) {
  throw new Error(
    `JWT_SECRET is too short (${process.env.JWT_SECRET.length} chars, need at least 32) — ` +
    'a short secret can be brute-forced, letting an attacker forge login tokens for any account. ' +
    'Generate a strong one with `openssl rand -hex 32`.'
  );
}
if (WEAK_JWT_SECRETS.includes(process.env.JWT_SECRET.toLowerCase())) {
  throw new Error(
    'JWT_SECRET is set to a well-known placeholder value — this is publicly guessable and ' +
    'must never be used. Generate a real one with `openssl rand -hex 32`.'
  );
}

const { init } = require('./db');
const seedAdmin = require('./seedAdmin');
const seedManager = require('./seedManager');
const seedSuperAdmin = require('./seedSuperAdmin');

const authRoutes = require('./routes/auth');
const employeeRoutes = require('./routes/employees');
const attendanceRoutes = require('./routes/attendance');
const exportRoutes = require('./routes/export');
const projectRoutes = require('./routes/projects');
const shiftCategoryRoutes = require('./routes/shiftCategories');
const salaryRoutes = require('./routes/salary');
const leaveRoutes = require('./routes/leave');
const grievanceRoutes = require('./routes/grievance');
const relieverRoutes = require('./routes/reliever');
const overtimeRoutes = require('./routes/overtime');
const auditRoutes = require('./routes/audit');
const maintenanceRoutes = require('./routes/maintenance');
const sosRoutes = require('./routes/sos');
const announcementsRoutes = require('./routes/announcements');
const emergencyRoutes = require('./routes/emergency');
const clientAccountsRoutes = require('./routes/clientAccounts');
const clientPortalRoutes = require('./routes/clientPortal');
const companyRoutes = require('./routes/companies');

const app = express();

// Security headers. CSP was previously disabled entirely — that's a meaningful chunk of
// XSS/clickjacking protection just switched off. This enables a real policy instead:
// - defaultSrc/scriptSrc/styleSrc restricted to same-origin (blocks a malicious/injected
//   <script src="https://evil.example"> or stylesheet from loading at all).
// - 'unsafe-inline' is still needed for scriptSrc/styleSrc because this app's existing
//   frontend uses inline onclick="" handlers and inline style="" attributes throughout —
//   removing that would need a large refactor. CSP still blocks the more common/severe XSS
//   payloads (loading an external attacker-controlled script/exfiltration endpoint), just
//   not ones relying purely on inline injection.
// - imgSrc allows data:/blob: since selfie photos, company logos, and QR-less 2FA setup all
//   render base64 data URIs.
// - connectSrc/fontSrc kept to 'self'; scriptSrc explicitly allows the one external CDN
//   script this app actually loads (the xlsx.js bulk-import parser).
// - frameAncestors 'none' blocks this app being framed by another site (clickjacking).
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", 'https://cdnjs.cloudflare.com'],
      // helmet defaults scriptSrcAttr to 'none' (blocks onclick="" etc. entirely) unless
      // told otherwise — this app's existing frontend relies on onclick="" attributes
      // throughout, so that default would break virtually every button in the UI.
      scriptSrcAttr: ["'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      // Google Fonts: style.css @imports the Space Grotesk/Inter/JetBrains Mono font faces
      // from fonts.googleapis.com (styleSrc, above) which in turn references the actual font
      // files on fonts.gstatic.com (fontSrc, below).
      fontSrc: ["'self'", 'data:', 'https://fonts.gstatic.com'],
      imgSrc: ["'self'", 'data:', 'blob:'],
      connectSrc: ["'self'"],
      objectSrc: ["'none'"],
      frameAncestors: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
    },
  },
  crossOriginEmbedderPolicy: false,
}));
// This API is consumed by the Android app and any future non-browser client in addition to
// this web portal — none of them send cookies, only a Bearer token in the Authorization
// header, so a wildcard origin here doesn't expose the CSRF/credential-leak risk it would
// for a cookie-authenticated API. Kept open rather than allow-listing specific origins so
// the Android app (and any client integration) keeps working without extra config.
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
app.use('/api/auth/super-admin-login', loginLimiter);

// Separate, slightly more generous limiter for the public company-lookup preview (used to
// show "Signing in to: <Company>" as someone types their Company Code) — still needs its own
// limit since, unlike the login endpoints above, it doesn't require a password at all, so
// without this an attacker could otherwise brute-force/enumerate valid Company Codes very
// quickly by just requesting this endpoint on repeat.
const companyLookupLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please try again shortly.' },
});
app.use('/api/auth/company-lookup', companyLookupLimiter);

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
app.use('/api/projects', projectRoutes);
app.use('/api/shift-categories', shiftCategoryRoutes);
app.use('/api/salary', salaryRoutes);
app.use('/api/leave', leaveRoutes);
app.use('/api/grievance', grievanceRoutes);
app.use('/api/reliever', relieverRoutes);
app.use('/api/overtime', overtimeRoutes);
app.use('/api/audit', auditRoutes);
app.use('/api/maintenance', maintenanceRoutes);
app.use('/api/sos', sosRoutes);
app.use('/api/announcements', announcementsRoutes);
app.use('/api/emergency', emergencyRoutes);
app.use('/api/client-accounts', clientAccountsRoutes);
app.use('/api/client-portal', clientPortalRoutes);
// Platform-owner only — create/manage the companies this app is sold/deployed to.
app.use('/api/companies', companyRoutes);

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', project: process.env.PROJECT_NAME || 'Geovixa' });
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
  let dbInfo = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      dbInfo = await init();
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

  // Seeds the default company's Admin + Manager (multi-company installs: this is just the
  // very first/demo company — use the Companies panel, logged in as the platform owner, to
  // add real customer companies afterwards), plus the platform-owner (super_admin) account.
  await seedAdmin(dbInfo.defaultCompanyId);
  await seedManager(dbInfo.defaultCompanyId);
  await seedSuperAdmin();

  app.listen(PORT, () => {
    console.log(`\n🚀 Geovixa Attendance Backend running on port ${PORT}`);
    console.log(`   Admin portal:  http://localhost:${PORT}`);
    console.log(`   API base:      http://localhost:${PORT}/api\n`);
  });
}

start().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
