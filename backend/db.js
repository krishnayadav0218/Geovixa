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

// -----------------------------------------------------------------------------------------
// MULTI-COMPANY (MULTI-TENANT) SUPPORT
// -----------------------------------------------------------------------------------------
// This app can now be sold/deployed to MULTIPLE companies out of ONE shared deployment +
// ONE shared database. Every company gets its own isolated data (employees, attendance,
// projects, shift categories, leave/grievance/salary records, and its own Admin/Manager/
// Coordinator/report-only-role accounts) via a `company_id` column added to every relevant
// table, all scoped through the `companies` table below.
//
// - `companies.code` is the short code a company's users type at login (Company Code field)
//   to tell the shared app which tenant they belong to.
// - A brand-new `super_admin` role (company_id IS NULL) is the platform OWNER's account —
//   i.e. you, the person selling this — used only to create/manage companies from a
//   dedicated Companies panel (routes/companies.js). It never touches employee/attendance
//   data directly.
// - Every existing table keeps working as before for a single company; this is purely
//   additive so nothing breaks for an already-running single-company deployment (see the
//   backfill migration near the bottom of init(), which creates a default company and
//   assigns any pre-existing rows to it automatically on first boot after upgrading).
async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS companies (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      code TEXT UNIQUE NOT NULL,
      active INTEGER DEFAULT 1,
      contact_email TEXT,
      contact_phone TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  await pool.query('ALTER TABLE companies ADD COLUMN IF NOT EXISTS settings JSONB DEFAULT \'{}\'::jsonb;');
  // Company logo, uploaded by the platform owner (super_admin) — prints on that company's
  // salary slip PDFs alongside their name instead of the default "Geovixa" branding.
  // Stored as a relative /uploads/logos/... URL (see logoStorage.js), same pattern as
  // employees.pin_hash-adjacent photo/attachment columns elsewhere in this file.
  await pool.query('ALTER TABLE companies ADD COLUMN IF NOT EXISTS logo_url TEXT;');

  await pool.query(`
    CREATE TABLE IF NOT EXISTS admins (
      id SERIAL PRIMARY KEY,
      username TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'admin',
      project TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS employees (
      id SERIAL PRIMARY KEY,
      employee_id TEXT NOT NULL,
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
      name TEXT NOT NULL,
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
      name TEXT NOT NULL,
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
      reviewed_by TEXT
    );
  `);
  await pool.query('CREATE INDEX IF NOT EXISTS idx_salary_requests_project ON salary_slip_requests(project);');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_salary_requests_status ON salary_slip_requests(status);');

  // Leave applications — employees raise a leave request for a date range with a reason
  // and an optional attachment (medical certificate, etc.). Same project-scoping rule as
  // salary_slip_requests: a manager/coordinator only ever sees/actions their own project's
  // leave requests; admin sees/filters everything. `project` is stored on each row so this
  // scoping (and the report filter) can work off it directly.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS leave_requests (
      id SERIAL PRIMARY KEY,
      employee_id TEXT NOT NULL,
      from_date TEXT NOT NULL,
      to_date TEXT NOT NULL,
      reason TEXT,
      attachment_url TEXT,
      project TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      requested_at TIMESTAMPTZ DEFAULT NOW(),
      reviewed_at TIMESTAMPTZ,
      reviewed_by TEXT
    );
  `);
  await pool.query('CREATE INDEX IF NOT EXISTS idx_leave_requests_employee ON leave_requests(employee_id);');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_leave_requests_status ON leave_requests(status);');

  // grievances: employees raise a workplace problem/complaint (category + subject +
  // description + optional attachment as proof). Same project-scoping as leave_requests /
  // salary_slip_requests — a manager/coordinator only sees their own project's grievances,
  // admin sees everything. Status flow: pending -> in_review -> resolved/rejected, with an
  // optional resolution_note the reviewer can leave for the employee.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS grievances (
      id SERIAL PRIMARY KEY,
      employee_id TEXT NOT NULL,
      project TEXT,
      category TEXT NOT NULL,
      subject TEXT NOT NULL,
      description TEXT,
      attachment_url TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      requested_at TIMESTAMPTZ DEFAULT NOW(),
      reviewed_at TIMESTAMPTZ,
      reviewed_by TEXT,
      resolution_note TEXT
    );
  `);
  await pool.query('CREATE INDEX IF NOT EXISTS idx_grievances_employee ON grievances(employee_id);');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_grievances_status ON grievances(status);');

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
      name TEXT NOT NULL,
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
  // Employee PIN (4-6 digit) — set by the admin, used alongside Employee ID at employee
  // login. bcrypt-hashed, never stored in plain text. (This column was referenced by
  // routes/employees.js already but was missing here — added so PIN save/reset actually works.)
  await pool.query('ALTER TABLE employees ADD COLUMN IF NOT EXISTS pin_hash TEXT;');
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

  // -----------------------------------------------------------------------------------
  // MULTI-COMPANY COLUMNS — add company_id to every tenant-owned table.
  // -----------------------------------------------------------------------------------
  await pool.query('ALTER TABLE admins ADD COLUMN IF NOT EXISTS company_id INTEGER REFERENCES companies(id);');
  await pool.query('ALTER TABLE employees ADD COLUMN IF NOT EXISTS company_id INTEGER REFERENCES companies(id);');
  await pool.query('ALTER TABLE projects ADD COLUMN IF NOT EXISTS company_id INTEGER REFERENCES companies(id);');
  await pool.query('ALTER TABLE shift_categories ADD COLUMN IF NOT EXISTS company_id INTEGER REFERENCES companies(id);');
  await pool.query('ALTER TABLE custom_roles ADD COLUMN IF NOT EXISTS company_id INTEGER REFERENCES companies(id);');
  await pool.query('ALTER TABLE attendance ADD COLUMN IF NOT EXISTS company_id INTEGER REFERENCES companies(id);');
  await pool.query('ALTER TABLE salaries ADD COLUMN IF NOT EXISTS company_id INTEGER REFERENCES companies(id);');
  await pool.query('ALTER TABLE salary_slip_requests ADD COLUMN IF NOT EXISTS company_id INTEGER REFERENCES companies(id);');
  await pool.query('ALTER TABLE leave_requests ADD COLUMN IF NOT EXISTS company_id INTEGER REFERENCES companies(id);');
  await pool.query('ALTER TABLE grievances ADD COLUMN IF NOT EXISTS company_id INTEGER REFERENCES companies(id);');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_attendance_company ON attendance(company_id);');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_employees_company ON employees(company_id);');

  // ---- One-time backfill: create a default company for any data that pre-dates this
  // multi-company upgrade, and attach every "orphan" row (company_id IS NULL) to it. Safe
  // to run every boot — after the first run there are no more NULLs left to backfill, so
  // this becomes a no-op. New installs (empty DB) also get this default company seeded so
  // there's always at least one usable company + admin out of the box.
  const DEFAULT_COMPANY_NAME = process.env.DEFAULT_COMPANY_NAME || 'Geovixa';
  const DEFAULT_COMPANY_CODE = (process.env.DEFAULT_COMPANY_CODE || 'GEOVIXA').trim().toUpperCase();

  let defaultCompanyId;
  const existingDefault = await pool.query('SELECT id FROM companies WHERE UPPER(code) = $1', [DEFAULT_COMPANY_CODE]);
  if (existingDefault.rows[0]) {
    defaultCompanyId = existingDefault.rows[0].id;
  } else {
    const inserted = await pool.query(
      'INSERT INTO companies (name, code, active) VALUES ($1, $2, 1) RETURNING id',
      [DEFAULT_COMPANY_NAME, DEFAULT_COMPANY_CODE]
    );
    defaultCompanyId = inserted.rows[0].id;
    console.log(`🏢 Default company created -> "${DEFAULT_COMPANY_NAME}" (code: ${DEFAULT_COMPANY_CODE})`);
  }

  const orphanTables = [
    'admins', 'employees', 'projects', 'shift_categories', 'custom_roles',
    'attendance', 'salaries', 'salary_slip_requests', 'leave_requests', 'grievances',
  ];
  for (const table of orphanTables) {
    // admins.role = 'super_admin' rows are intentionally left with company_id NULL forever —
    // they're the platform-owner account, not tied to any one company.
    const whereClause = table === 'admins' ? "company_id IS NULL AND role <> 'super_admin'" : 'company_id IS NULL';
    await pool.query(`UPDATE ${table} SET company_id = $1 WHERE ${whereClause}`, [defaultCompanyId]);
  }

  // ---- Replace the old GLOBAL unique constraints with PER-COMPANY ones, now that
  // company_id exists on every relevant table. Usernames/employee IDs/project names/shift
  // category names/custom role names only need to be unique WITHIN a company — two
  // different companies can both have an employee "EMP001" or a project "MTDC" without
  // clashing, exactly like two different SaaS customers should be able to.
  await pool.query('ALTER TABLE employees DROP CONSTRAINT IF EXISTS employees_employee_id_key;');
  await pool.query('CREATE UNIQUE INDEX IF NOT EXISTS employees_company_empid_uq ON employees(company_id, employee_id);');

  await pool.query('ALTER TABLE projects DROP CONSTRAINT IF EXISTS projects_name_key;');
  await pool.query('CREATE UNIQUE INDEX IF NOT EXISTS projects_company_name_uq ON projects(company_id, name);');

  await pool.query('ALTER TABLE shift_categories DROP CONSTRAINT IF EXISTS shift_categories_name_key;');
  await pool.query('CREATE UNIQUE INDEX IF NOT EXISTS shift_categories_company_name_uq ON shift_categories(company_id, name);');

  await pool.query('ALTER TABLE custom_roles DROP CONSTRAINT IF EXISTS custom_roles_name_key;');
  await pool.query('CREATE UNIQUE INDEX IF NOT EXISTS custom_roles_company_name_uq ON custom_roles(company_id, name);');

  // admins.username: unique per company for normal accounts, unique globally among
  // super_admin accounts (company_id IS NULL) — two different companies CAN both have an
  // admin username "admin", but there's still only ever one global super_admin per username.
  await pool.query('ALTER TABLE admins DROP CONSTRAINT IF EXISTS admins_username_key;');
  await pool.query(
    'CREATE UNIQUE INDEX IF NOT EXISTS admins_company_username_uq ON admins(company_id, username) WHERE company_id IS NOT NULL;'
  );
  await pool.query(
    'CREATE UNIQUE INDEX IF NOT EXISTS admins_super_username_uq ON admins(username) WHERE company_id IS NULL;'
  );

  // salaries: PK used to be plain employee_id; now needs to be (company_id, employee_id)
  // since employee_id is only unique per company.
  await pool.query('ALTER TABLE salaries DROP CONSTRAINT IF EXISTS salaries_pkey;');
  await pool.query('CREATE UNIQUE INDEX IF NOT EXISTS salaries_company_empid_uq ON salaries(company_id, employee_id);');

  // salary_slip_requests: was UNIQUE(employee_id, month), now UNIQUE(company_id, employee_id, month).
  await pool.query('ALTER TABLE salary_slip_requests DROP CONSTRAINT IF EXISTS salary_slip_requests_employee_id_month_key;');
  await pool.query(
    'CREATE UNIQUE INDEX IF NOT EXISTS salary_slip_requests_company_emp_month_uq ON salary_slip_requests(company_id, employee_id, month);'
  );

  // Seed the projects list on first boot only (never overwrites projects an admin already
  // added/removed), per company that has no projects yet — MTDC, MCGM HK, MCGM, Security,
  // MCGM Education + a generic "Others".
  const companiesWithNoProjects = await pool.query(`
    SELECT c.id FROM companies c
    WHERE NOT EXISTS (SELECT 1 FROM projects p WHERE p.company_id = c.id)
  `);
  for (const { id: cid } of companiesWithNoProjects.rows) {
    const defaults = ['MTDC', 'MCGM HK', 'MCGM', 'Security', 'MCGM Education', 'Others'];
    for (const name of defaults) {
      await pool.query(
        'INSERT INTO projects (company_id, name) VALUES ($1, $2) ON CONFLICT (company_id, name) DO NOTHING',
        [cid, name]
      );
    }
  }

  // Seed the shift categories list on first boot only, per company that has none yet —
  // 12 Hrs HK/ATT (full=12, half=6), 8 Hrs FA (full=8, half=4), 9 Hrs General (full=9, half=4.5).
  const companiesWithNoShifts = await pool.query(`
    SELECT c.id FROM companies c
    WHERE NOT EXISTS (SELECT 1 FROM shift_categories s WHERE s.company_id = c.id)
  `);
  for (const { id: cid } of companiesWithNoShifts.rows) {
    const defaults = [
      ['12 Hrs - HK', 12, 6],
      ['12 Hrs - ATT', 12, 6],
      ['8 Hrs - FA', 8, 4],
      ['9 Hrs - General', 9, 4.5],
    ];
    for (const [name, full, half] of defaults) {
      await pool.query(
        'INSERT INTO shift_categories (company_id, name, full_hours, half_hours) VALUES ($1, $2, $3, $4) ON CONFLICT (company_id, name) DO NOTHING',
        [cid, name, full, half]
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
  // and how many employees/companies already exist in it. If employee data ever "disappears"
  // after a redeploy, this line in the Render logs immediately tells you whether it's a real
  // data-loss issue or just DATABASE_URL silently pointing at a different/empty database.
  try {
    const { rows } = await pool.query('SELECT current_database() AS db, inet_server_addr() AS host');
    const empCount = await pool.query('SELECT COUNT(*)::int AS count FROM employees');
    const companyCount = await pool.query('SELECT COUNT(*)::int AS count FROM companies');
    console.log(`📦 Connected to DB "${rows[0].db}" @ ${rows[0].host || '(pooled/unknown host)'} — ${companyCount.rows[0].count} company(ies), ${empCount.rows[0].count} employee(s) found`);
  } catch (err) {
    console.warn('Could not run DB diagnostic log:', err.message);
  }

  return { defaultCompanyId, defaultCompanyCode: DEFAULT_COMPANY_CODE };
}

module.exports = { pool, init };
