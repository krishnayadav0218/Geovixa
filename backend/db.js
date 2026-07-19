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
      project TEXT,
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
      project TEXT,
      shift_category TEXT,
      active INTEGER DEFAULT 1,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  // Projects (MTDC, MCGM HK, MCGM, Security, MCGM Education, Others, ...) — a simple
  // admin-managed list so employees can be grouped/filtered/reported project-wise.
  // weekly_off_day: 0=Sunday .. 6=Saturday — the one day a missed punch on that project
  // is treated as a Weekly Off (W/O) instead of an Absence. Defaults to Sunday, but not
  // every project's workforce is off on a Sunday (e.g. some security/retail sites rotate
  // a different day), so this is per-project and admin-editable, not hardcoded.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS projects (
      id SERIAL PRIMARY KEY,
      name TEXT UNIQUE NOT NULL,
      weekly_off_day SMALLINT NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  // Shift Categories (12 Hrs - HK, 12 Hrs - ATT, 8 Hrs - FA, 9 Hrs - General, ...) — same
  // admin-managed add/remove pattern as Projects. "name" is the exact string stored on
  // employees.shift_category, so it doubles as both the DB value and the display label.
  // full_hours / half_hours drive the P / HD / A attendance calculation for that category.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS shift_categories (
      id SERIAL PRIMARY KEY,
      name TEXT UNIQUE NOT NULL,
      full_hours NUMERIC NOT NULL,
      half_hours NUMERIC NOT NULL,
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

  // Monthly salary structure per employee (admin-managed) — used to generate the salary
  // slip an employee can download themselves. Kept as a separate table (rather than columns
  // on `employees`) so it's optional per employee and easy to update independently.
  // basic_salary + hra + other_allowances = fixed monthly gross; deductions/pf/esic = fixed
  // monthly deductions. The slip prorates basic/hra/allowances by attendance for that
  // month (see routes/salary.js) — deductions (incl. PF/ESIC) are applied in full.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS salaries (
      employee_id TEXT PRIMARY KEY,
      basic_salary NUMERIC NOT NULL DEFAULT 0,
      hra NUMERIC NOT NULL DEFAULT 0,
      other_allowances NUMERIC NOT NULL DEFAULT 0,
      deductions NUMERIC NOT NULL DEFAULT 0,
      pf NUMERIC NOT NULL DEFAULT 0,
      esic NUMERIC NOT NULL DEFAULT 0,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  // In case someone's already run an older version of this table (pre PF/ESIC columns).
  await pool.query('ALTER TABLE salaries ADD COLUMN IF NOT EXISTS pf NUMERIC NOT NULL DEFAULT 0;');
  await pool.query('ALTER TABLE salaries ADD COLUMN IF NOT EXISTS esic NUMERIC NOT NULL DEFAULT 0;');

  // Salary slip requests — employees can no longer view/download their own slip directly;
  // they raise a request here for a given month, which their project's coordinator (or a
  // manager/admin) has to approve before the slip becomes viewable/downloadable to them.
  // One row per employee+month (an employee can't file two requests for the same month).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS salary_slip_requests (
      id SERIAL PRIMARY KEY,
      employee_id TEXT NOT NULL,
      month TEXT NOT NULL,
      project TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      requested_at TIMESTAMPTZ DEFAULT NOW(),
      reviewed_at TIMESTAMPTZ,
      reviewed_by TEXT,
      UNIQUE (employee_id, month)
    );
  `);
  await pool.query('CREATE INDEX IF NOT EXISTS idx_salary_requests_project ON salary_slip_requests(project);');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_salary_requests_status ON salary_slip_requests(status);');

  // In case someone's already run an older version of this table on their Supabase project,
  // these just make sure the newer columns exist without touching existing rows.
  await pool.query("ALTER TABLE admins ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'admin';");
  await pool.query('ALTER TABLE admins ADD COLUMN IF NOT EXISTS project TEXT;');
  // Custom report-only roles (Area Officer, Supervisor, etc.) — the role *names* are fully
  // admin-defined (Managers tab -> Roles). Accounts created under one of these roles always
  // get role = 'report_viewer' internally (see middleware.js / projectScope.js), with
  // custom_role_name holding the actual admin-chosen label, and are locked to Reports only —
  // further narrowed down to specific Zone(s)/Ward(s)/Location(s) within their Project, not
  // just the whole Project like a Manager/Coordinator gets.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS custom_roles (
      id SERIAL PRIMARY KEY,
      name TEXT UNIQUE NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  await pool.query('ALTER TABLE admins ADD COLUMN IF NOT EXISTS custom_role_name TEXT;');
  await pool.query('ALTER TABLE admins ADD COLUMN IF NOT EXISTS scope_zone TEXT;');
  await pool.query('ALTER TABLE admins ADD COLUMN IF NOT EXISTS scope_ward TEXT;');
  await pool.query('ALTER TABLE admins ADD COLUMN IF NOT EXISTS scope_location TEXT;');
  await pool.query('ALTER TABLE employees ADD COLUMN IF NOT EXISTS location TEXT;');
  await pool.query('ALTER TABLE employees ADD COLUMN IF NOT EXISTS doj TEXT;');
  await pool.query('ALTER TABLE employees ADD COLUMN IF NOT EXISTS project TEXT;');
  await pool.query('ALTER TABLE employees ADD COLUMN IF NOT EXISTS shift_category TEXT;');
  // Zone / Ward / Site Code — extra location-grouping fields (mainly used by MCGM-style
  // projects where a project is further split by civic Zone/Ward, plus a Site Code for the
  // exact site). All optional, admin-editable, and usable as report filters.
  await pool.query('ALTER TABLE employees ADD COLUMN IF NOT EXISTS zone TEXT;');
  await pool.query('ALTER TABLE employees ADD COLUMN IF NOT EXISTS ward TEXT;');
  await pool.query('ALTER TABLE employees ADD COLUMN IF NOT EXISTS site_code TEXT;');
  await pool.query('ALTER TABLE projects ADD COLUMN IF NOT EXISTS weekly_off_day SMALLINT NOT NULL DEFAULT 0;');
  // Group Name — admin can put two or more projects under the same Group Name to combine
  // them (same idea as the old hardcoded "MCGM = MCGM + MCGM HK + MCGM Education" grouping,
  // just now fully admin-editable via the UI instead of hardcoded in code). NULL/blank = not
  // grouped ("ungrouped").
  await pool.query('ALTER TABLE projects ADD COLUMN IF NOT EXISTS group_name TEXT;');
  // One-time migration: projects already named "MCGM..." get group_name = 'MCGM' so the old
  // hardcoded MCGM grouping keeps working exactly as before, now as ordinary admin-editable
  // group data. Only touches rows that don't already have a group set.
  await pool.query("UPDATE projects SET group_name = 'MCGM' WHERE group_name IS NULL AND UPPER(name) LIKE 'MCGM%';");

  // Seed the projects list on first boot only (never overwrites projects an admin already
  // added/removed) — MTDC, MCGM HK, MCGM, Security, MCGM Education + a generic "Others".
  const projCount = await pool.query('SELECT COUNT(*)::int AS count FROM projects');
  if (projCount.rows[0].count === 0) {
    const defaults = ['MTDC', 'MCGM HK', 'MCGM', 'Security', 'MCGM Education', 'Others'];
    for (const name of defaults) {
      await pool.query('INSERT INTO projects (name) VALUES ($1) ON CONFLICT (name) DO NOTHING', [name]);
    }
  }

  // Seed the shift categories list on first boot only — 12 Hrs HK/ATT (full=12, half=6),
  // 8 Hrs FA (full=8, half=4), and the newly requested 9 Hrs General (full=9, half=4.5).
  const shiftCount = await pool.query('SELECT COUNT(*)::int AS count FROM shift_categories');
  if (shiftCount.rows[0].count === 0) {
    const defaults = [
      ['12 Hrs - HK', 12, 6],
      ['12 Hrs - ATT', 12, 6],
      ['8 Hrs - FA', 8, 4],
      ['9 Hrs - General', 9, 4.5],
    ];
    for (const [name, full, half] of defaults) {
      await pool.query(
        'INSERT INTO shift_categories (name, full_hours, half_hours) VALUES ($1, $2, $3) ON CONFLICT (name) DO NOTHING',
        [name, full, half]
      );
    }
  }

  // One-time migration: employees added before this update have shift_category stored as the
  // old internal codes ('12HK', '12ATT', '8FA'). Move them over to the new descriptive names so
  // they keep matching the shift_categories table above (and keep getting the right P/HD/A
  // hours). Safe to run every boot — it only touches rows still on the old codes.
  await pool.query("UPDATE employees SET shift_category = '12 Hrs - HK' WHERE shift_category = '12HK';");
  await pool.query("UPDATE employees SET shift_category = '12 Hrs - ATT' WHERE shift_category = '12ATT';");
  await pool.query("UPDATE employees SET shift_category = '8 Hrs - FA' WHERE shift_category = '8FA';");

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
