const { Pool } = require('pg');

// Switched over from better-sqlite3 to Postgres (Supabase) so attendance data
// doesn't vanish every time Render spins the container down / redeploys.
// Get this string from Supabase -> Project Settings -> Database -> Connection string (URI).
// Use the "Transaction pooler" one if you're on Render's starter plan, it plays nicer
// with short-lived connections than the direct one.
const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error(
    'DATABASE_URL is not set. Add it to your .env locally, and to the Render Environment tab in production.'
  );
}

const pool = new Pool({
  connectionString,
  ssl: { rejectUnauthorized: false }, // supabase requires ssl, this just avoids self-signed cert complaints
});

// Without this handler, an idle connection being closed by Supabase's pooler (PgBouncer) —
// which happens routinely and is normal — throws an *unhandled* error that crashes the whole
// Node process. A crash + auto-restart can easily look like "the app lost its data" to a user,
// even though the actual Postgres data was never touched.
pool.on('error', (err) => {
  console.error('Unexpected Postgres pool error (connection will be replaced automatically):', err.message);
});

// Creates tables if they don't already exist yet. Safe to call every boot.
async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS admins (
      id SERIAL PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'admin',
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS employees (
      id SERIAL PRIMARY KEY,
      employee_id TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      designation TEXT,
      phone TEXT,
      location TEXT,
      doj TEXT,
      active INTEGER DEFAULT 1,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS attendance (
      id SERIAL PRIMARY KEY,
      employee_id TEXT NOT NULL,
      status TEXT NOT NULL,
      photo TEXT,
      latitude DOUBLE PRECISION NOT NULL,
      longitude DOUBLE PRECISION NOT NULL,
      address TEXT,
      device_time TEXT,
      server_time TIMESTAMPTZ DEFAULT NOW(),
      attendance_date TEXT NOT NULL
    );
  `);

  await pool.query('CREATE INDEX IF NOT EXISTS idx_attendance_emp ON attendance(employee_id);');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_attendance_date ON attendance(attendance_date);');

  // In case someone's already run an older version of this table on their Supabase project,
  // these just make sure the newer columns exist without touching existing rows.
  await pool.query("ALTER TABLE admins ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'admin';");
  await pool.query('ALTER TABLE employees ADD COLUMN IF NOT EXISTS location TEXT;');
  await pool.query('ALTER TABLE employees ADD COLUMN IF NOT EXISTS doj TEXT;');

  // Diagnostic boot log — prints which actual Postgres database this instance is talking to
  // and how many employees already exist in it. If employee data ever "disappears" after a
  // redeploy, this line in the Render logs immediately tells you whether it's a real data-loss
  // issue or just DATABASE_URL silently pointing at a different/empty database.
  try {
    const { rows } = await pool.query('SELECT current_database() AS db, inet_server_addr() AS host');
    const empCount = await pool.query('SELECT COUNT(*)::int AS count FROM employees');
    console.log(`📦 Connected to DB "${rows[0].db}" @ ${rows[0].host || '(pooled/unknown host)'} — ${empCount.rows[0].count} employee(s) found`);
  } catch (err) {
    console.warn('Could not run DB diagnostic log:', err.message);
  }
}

module.exports = { pool, init };
