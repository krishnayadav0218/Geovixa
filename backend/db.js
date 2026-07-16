const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

// DATA_DIR points to a persistent disk in production (e.g. Render disk mounted at /var/data).
// Falls back to the backend folder itself for local development.
const DATA_DIR = process.env.DATA_DIR || __dirname;
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'mtdc_attendance.db'));

db.pragma('journal_mode = WAL');

// ----- TABLES -----

db.exec(`
CREATE TABLE IF NOT EXISTS admins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'admin',   -- 'admin' (full access) or 'manager' (view + download only)
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
`);

db.exec(`
CREATE TABLE IF NOT EXISTS employees (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_id TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  designation TEXT,
  phone TEXT,
  location TEXT,                -- work location / site (e.g. "Mumbai - L Ward")
  doj TEXT,                     -- Date of Joining, YYYY-MM-DD
  active INTEGER DEFAULT 1,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
`);

db.exec(`
CREATE TABLE IF NOT EXISTS attendance (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_id TEXT NOT NULL,
  status TEXT NOT NULL,         -- 'on_duty' or 'off_duty'
  photo TEXT,                   -- base64 selfie photo (data URI) taken at punch time
  latitude REAL NOT NULL,
  longitude REAL NOT NULL,
  address TEXT,
  device_time TEXT,
  server_time TEXT DEFAULT CURRENT_TIMESTAMP,
  attendance_date TEXT NOT NULL -- YYYY-MM-DD, for easy filtering
);
`);

db.exec(`CREATE INDEX IF NOT EXISTS idx_attendance_emp ON attendance(employee_id);`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_attendance_date ON attendance(attendance_date);`);

// ----- LIGHTWEIGHT MIGRATIONS (for existing databases from older versions) -----
// Adds new columns without wiping existing data.
const attendanceCols = db.prepare(`PRAGMA table_info(attendance)`).all().map(c => c.name);
if (!attendanceCols.includes('photo')) {
  db.exec(`ALTER TABLE attendance ADD COLUMN photo TEXT;`);
}

const adminCols = db.prepare(`PRAGMA table_info(admins)`).all().map(c => c.name);
if (!adminCols.includes('role')) {
  db.exec(`ALTER TABLE admins ADD COLUMN role TEXT NOT NULL DEFAULT 'admin';`);
}

const employeeCols = db.prepare(`PRAGMA table_info(employees)`).all().map(c => c.name);
if (!employeeCols.includes('location')) {
  db.exec(`ALTER TABLE employees ADD COLUMN location TEXT;`);
}
if (!employeeCols.includes('doj')) {
  db.exec(`ALTER TABLE employees ADD COLUMN doj TEXT;`);
}

module.exports = db;
