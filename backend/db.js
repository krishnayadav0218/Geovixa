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
  // Internal notes — visible only to the platform owner (super_admin), e.g. billing plan,
  // renewal date, special arrangements. Never exposed to the company's own Admin/Manager/
  // Employee accounts.
  await pool.query('ALTER TABLE companies ADD COLUMN IF NOT EXISTS notes TEXT;');
  // Subscription / plan fields — controlled by the super_admin (Companies -> Edit).
  // plan: a free-text label ('trial', 'basic', 'premium', or any custom name you use) —
  // purely informational/organizational, doesn't itself change what's enabled (that's still
  // done via companies.settings, see companySettings.js).
  // expires_at: NULL = no expiry (access never blocked). If set and in the past, every
  // login for that company (Admin/Manager/Coordinator/Reports/Employee) is blocked with a
  // clear "subscription expired" message until the super_admin extends/clears it.
  // max_employees: NULL = unlimited. If set, adding a new employee (single or bulk) once the
  // company is already at the limit is blocked — a practical way to enforce plan tiers.
  await pool.query("ALTER TABLE companies ADD COLUMN IF NOT EXISTS plan TEXT NOT NULL DEFAULT 'standard';");
  await pool.query('ALTER TABLE companies ADD COLUMN IF NOT EXISTS expires_at DATE;');
  await pool.query('ALTER TABLE companies ADD COLUMN IF NOT EXISTS max_employees INTEGER;');

  // Audit log — every sensitive action the platform owner (super_admin) takes: creating/
  // editing/deleting a company, changing its settings/logo/plan, resetting an Admin's
  // password, or impersonating a company's Admin. Read-only history, nothing in the app ever
  // deletes rows from this table. See auditLog.js / routes/companies.js '/audit-log'.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS audit_log (
      id SERIAL PRIMARY KEY,
      actor_username TEXT NOT NULL,
      actor_role TEXT NOT NULL,
      action TEXT NOT NULL,
      target_type TEXT,
      target_id TEXT,
      target_label TEXT,
      details TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  await pool.query('CREATE INDEX IF NOT EXISTS idx_audit_log_created ON audit_log(created_at DESC);');

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
  // TOTP-based two-factor authentication for the PLATFORM OWNER (super_admin) login only —
  // this account can create/manage every company, so it gets the extra protection. Company
  // Admin/Manager/Employee logins are unaffected. totp_secret is only ever set once 2FA is
  // actually enabled (after the owner scans the QR code and confirms one code) — see
  // routes/companies.js '/2fa/*' routes.
  await pool.query('ALTER TABLE admins ADD COLUMN IF NOT EXISTS totp_secret TEXT;');
  await pool.query('ALTER TABLE admins ADD COLUMN IF NOT EXISTS totp_enabled INTEGER NOT NULL DEFAULT 0;');
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
  // Employee email — optional, admin-set, used only to send status-update emails (leave/
  // grievance/salary-slip approved or rejected) when SMTP is configured (see mailer.js). The
  // app works exactly the same with no email on file; it's not used for login.
  await pool.query('ALTER TABLE employees ADD COLUMN IF NOT EXISTS email TEXT;');
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

  // Seed the projects list on first boot only for the DEFAULT company (never overwrites
  // projects an admin already added/removed) — MTDC, MCGM HK, MCGM, Security, MCGM Education
  // + a generic "Others". This is purely a backward-compat migration for pre-existing
  // single-tenant installs; brand-new companies created afterwards via the Companies panel
  // deliberately start with NO projects, so their Employees section isn't cluttered with
  // Geovixa's own example data — see routes/companies.js.
  const defaultCompanyHasNoProjects = await pool.query(
    'SELECT 1 FROM companies c WHERE c.id = $1 AND NOT EXISTS (SELECT 1 FROM projects p WHERE p.company_id = c.id)',
    [defaultCompanyId]
  );
  if (defaultCompanyHasNoProjects.rows.length) {
    const defaults = ['MTDC', 'MCGM HK', 'MCGM', 'Security', 'MCGM Education', 'Others'];
    for (const name of defaults) {
      await pool.query(
        'INSERT INTO projects (company_id, name) VALUES ($1, $2) ON CONFLICT (company_id, name) DO NOTHING',
        [defaultCompanyId, name]
      );
    }
  }

  // Same backward-compat scoping as above — DEFAULT company only.
  // 12 Hrs HK/ATT (full=12, half=6), 8 Hrs FA (full=8, half=4), 9 Hrs General (full=9, half=4.5).
  const defaultCompanyHasNoShifts = await pool.query(
    'SELECT 1 FROM companies c WHERE c.id = $1 AND NOT EXISTS (SELECT 1 FROM shift_categories s WHERE s.company_id = c.id)',
    [defaultCompanyId]
  );
  if (defaultCompanyHasNoShifts.rows.length) {
    const defaults = [
      ['12 Hrs - HK', 12, 6],
      ['12 Hrs - ATT', 12, 6],
      ['8 Hrs - FA', 8, 4],
      ['9 Hrs - General', 9, 4.5],
    ];
    for (const [name, full, half] of defaults) {
      await pool.query(
        'INSERT INTO shift_categories (company_id, name, full_hours, half_hours) VALUES ($1, $2, $3, $4) ON CONFLICT (company_id, name) DO NOTHING',
        [defaultCompanyId, name, full, half]
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

  // ---------------------------------------------------------------------------------------
  // RELIEVER & OT AUTOMATION — added on top of the existing attendance/leave/salary system.
  // Three pieces: (1) bank details on employees so approved OT can actually be paid out,
  // (2) reliever_assignments — admin/manager assigns a covering employee for a colleague's
  // weekly-off/absence, the reliever accepts/rejects from their own dashboard, (3)
  // overtime_records — hours beyond an employee's shift's "full_hours" threshold (same
  // thresholds used by attendanceStatus.js for P/HD/A) get logged, go through HR approval,
  // and finally get grouped into a payment_batch (Excel/CSV bank-upload file) once paid.
  // ---------------------------------------------------------------------------------------

  // Bank details — optional per employee, needed only once OT payments are turned on. Kept as
  // plain columns on employees (not a separate table) since it's 1:1 and rarely changes.
  await pool.query('ALTER TABLE employees ADD COLUMN IF NOT EXISTS bank_account_holder TEXT;');
  await pool.query('ALTER TABLE employees ADD COLUMN IF NOT EXISTS bank_account_number TEXT;');
  await pool.query('ALTER TABLE employees ADD COLUMN IF NOT EXISTS bank_ifsc TEXT;');
  await pool.query('ALTER TABLE employees ADD COLUMN IF NOT EXISTS bank_name TEXT;');

  // Per-shift-category OT rate (₹/hour). Kept alongside full_hours/half_hours since OT is
  // naturally shift-category-specific (a 12-hour HK shift and an 8-hour FA shift can pay
  // different OT rates). NULL/0 = OT rate not configured yet for that category.
  await pool.query('ALTER TABLE shift_categories ADD COLUMN IF NOT EXISTS ot_rate_per_hour NUMERIC NOT NULL DEFAULT 0;');

  // Reliever assignments — admin/manager assigns `reliever_employee_id` to cover
  // `original_employee_id`'s duty on `duty_date`. The reliever sees this on their own
  // dashboard and can accept/reject; admin/manager can cancel. Kept simple on purpose — one
  // row per covered day, not a recurring roster.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS reliever_assignments (
      id SERIAL PRIMARY KEY,
      company_id INTEGER REFERENCES companies(id),
      original_employee_id TEXT NOT NULL,
      reliever_employee_id TEXT NOT NULL,
      project TEXT,
      duty_date TEXT NOT NULL,
      reason TEXT,
      status TEXT NOT NULL DEFAULT 'assigned',
      assigned_by TEXT,
      assigned_at TIMESTAMPTZ DEFAULT NOW(),
      responded_at TIMESTAMPTZ
    );
  `);
  await pool.query('CREATE INDEX IF NOT EXISTS idx_reliever_company ON reliever_assignments(company_id);');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_reliever_original_emp ON reliever_assignments(original_employee_id);');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_reliever_reliever_emp ON reliever_assignments(reliever_employee_id);');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_reliever_date ON reliever_assignments(duty_date);');

  // Overtime records — one row per employee per work_date. worked_hours/ot_hours are computed
  // from that day's attendance punches vs. the employee's shift_category full_hours threshold
  // (see otCalculator.js). status flow: pending -> approved/rejected -> (approved ones only)
  // paid, once included in a payment_batch.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS overtime_records (
      id SERIAL PRIMARY KEY,
      company_id INTEGER REFERENCES companies(id),
      employee_id TEXT NOT NULL,
      project TEXT,
      work_date TEXT NOT NULL,
      shift_category TEXT,
      full_hours NUMERIC,
      worked_hours NUMERIC,
      ot_hours NUMERIC NOT NULL DEFAULT 0,
      rate_per_hour NUMERIC NOT NULL DEFAULT 0,
      ot_amount NUMERIC NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'pending',
      approved_by TEXT,
      approved_at TIMESTAMPTZ,
      payment_batch_id INTEGER,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  await pool.query('CREATE UNIQUE INDEX IF NOT EXISTS overtime_company_emp_date_uq ON overtime_records(company_id, employee_id, work_date);');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_overtime_company ON overtime_records(company_id);');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_overtime_status ON overtime_records(status);');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_overtime_emp ON overtime_records(employee_id);');

  // Payment batches — one row per "HR clicked Generate Payment File". Groups a set of
  // approved-and-unpaid OT records into a single downloadable bank-upload Excel/CSV, and
  // stamps those overtime_records rows as 'paid' + linked back here via payment_batch_id.
  // This is the "Option 1: Bank file export, HR uploads to bank portal" payment flow. A
  // direct-payout-API (RazorpayX/Cashfree) integration can be added later re-using this same
  // batch as its input, without changing anything upstream (OT calc/approval stay identical).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS payment_batches (
      id SERIAL PRIMARY KEY,
      company_id INTEGER REFERENCES companies(id),
      created_by TEXT,
      record_count INTEGER NOT NULL DEFAULT 0,
      total_amount NUMERIC NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'generated',
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  await pool.query('CREATE INDEX IF NOT EXISTS idx_payment_batches_company ON payment_batches(company_id);');

  // ---------------------------------------------------------------------------------------
  // SITE MANAGEMENT + LIVE OPERATIONS MAP + AUDIT/LOGIN HISTORY
  // "projects" already IS the site concept in this app (one row per site/location) — extended
  // in place rather than creating a parallel "sites" table, so nothing that already scopes by
  // project name (employees, attendance, leave, grievances, salary) needs to change.
  // ---------------------------------------------------------------------------------------
  await pool.query('ALTER TABLE projects ADD COLUMN IF NOT EXISTS client TEXT;');
  await pool.query('ALTER TABLE projects ADD COLUMN IF NOT EXISTS address TEXT;');
  await pool.query('ALTER TABLE projects ADD COLUMN IF NOT EXISTS latitude NUMERIC;');
  await pool.query('ALTER TABLE projects ADD COLUMN IF NOT EXISTS longitude NUMERIC;');
  await pool.query('ALTER TABLE projects ADD COLUMN IF NOT EXISTS geofence_radius_m NUMERIC NOT NULL DEFAULT 200;');
  await pool.query('ALTER TABLE projects ADD COLUMN IF NOT EXISTS required_manpower INTEGER NOT NULL DEFAULT 0;');
  await pool.query('ALTER TABLE projects ADD COLUMN IF NOT EXISTS supervisor_employee_id TEXT;');
  // SLA target (hours) a grievance/complaint raised at this site should be resolved within —
  // used to compute the site's Health Score and flag SLA breaches on the Live Ops Map.
  await pool.query('ALTER TABLE projects ADD COLUMN IF NOT EXISTS sla_hours NUMERIC NOT NULL DEFAULT 24;');

  // Audit log needs company_id so multi-tenant admins only ever see their own company's
  // activity (it started life as a super-admin-only table, hence the late addition here).
  await pool.query('ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS company_id INTEGER REFERENCES companies(id);');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_audit_log_company ON audit_log(company_id);');

  // Login history — every login attempt (success AND failure) across all account types
  // (admin/manager/coordinator/report-role/employee), for the Audit & Security module: who
  // logged in when, from where, and every failed attempt (possible brute-force/security
  // signal). company_id is nullable because a failed login with a bad/unknown Company Code
  // never resolves to a tenant.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS login_history (
      id SERIAL PRIMARY KEY,
      company_id INTEGER REFERENCES companies(id),
      username TEXT,
      role TEXT,
      success BOOLEAN NOT NULL,
      reason TEXT,
      ip_address TEXT,
      user_agent TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  await pool.query('CREATE INDEX IF NOT EXISTS idx_login_history_company ON login_history(company_id);');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_login_history_created ON login_history(created_at DESC);');

  // ---------------------------------------------------------------------------------------
  // PHASE 2: Maintenance+SLA tickets, Client Portal, Emergency Operations, Employee SOS,
  // Company Communication/Announcements.
  // ---------------------------------------------------------------------------------------

  // Maintenance tickets — also covers the "Complaint + SLA Management" module (spec modules 6
  // & 7 are the same workflow: a ticket IS the complaint). Separate from `grievances` (HR/
  // personal complaints raised by an employee about work matters) — these are facility/asset
  // issues (AC not working, leak, etc.) with a technician + SLA timer.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS maintenance_tickets (
      id SERIAL PRIMARY KEY,
      company_id INTEGER REFERENCES companies(id),
      project TEXT NOT NULL,
      category TEXT NOT NULL,
      subject TEXT NOT NULL,
      description TEXT,
      priority TEXT NOT NULL DEFAULT 'medium',
      status TEXT NOT NULL DEFAULT 'open',
      raised_by TEXT,
      assigned_technician TEXT,
      sla_hours NUMERIC,
      photo_url TEXT,
      resolution_note TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      assigned_at TIMESTAMPTZ,
      resolved_at TIMESTAMPTZ,
      verified_at TIMESTAMPTZ,
      closed_at TIMESTAMPTZ
    );
  `);
  await pool.query('CREATE INDEX IF NOT EXISTS idx_maint_company ON maintenance_tickets(company_id);');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_maint_status ON maintenance_tickets(status);');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_maint_project ON maintenance_tickets(project);');

  // Client Portal — a client account is scoped to one or more sites (projects) of ONE
  // company, read-only. Kept as its own table (not reusing `admins`) since a client is a
  // fundamentally different kind of account (external, no HR/attendance/payroll access at all).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS clients (
      id SERIAL PRIMARY KEY,
      company_id INTEGER REFERENCES companies(id),
      username TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      name TEXT NOT NULL,
      contact_email TEXT,
      contact_phone TEXT,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  await pool.query('CREATE UNIQUE INDEX IF NOT EXISTS clients_company_username_uq ON clients(company_id, username);');
  await pool.query(`
    CREATE TABLE IF NOT EXISTS client_sites (
      id SERIAL PRIMARY KEY,
      client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
      project TEXT NOT NULL
    );
  `);
  await pool.query('CREATE INDEX IF NOT EXISTS idx_client_sites_client ON client_sites(client_id);');

  // Emergency Operations — escalation log. Detection itself is computed live off
  // projects/attendance (same data as the Live Ops Map); this table just records WHEN a
  // senior actually pressed "Escalate" for a shortage, so there's a trail of who was
  // notified and whether it got resolved.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS emergency_escalations (
      id SERIAL PRIMARY KEY,
      company_id INTEGER REFERENCES companies(id),
      project TEXT NOT NULL,
      shortage INTEGER NOT NULL,
      escalated_by TEXT,
      status TEXT NOT NULL DEFAULT 'open',
      note TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      resolved_at TIMESTAMPTZ
    );
  `);
  await pool.query('CREATE INDEX IF NOT EXISTS idx_escalations_company ON emergency_escalations(company_id);');

  // Employee SOS — a panic-button alert with type + GPS, visible live to admin/manager/
  // coordinator until acknowledged and resolved.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS sos_alerts (
      id SERIAL PRIMARY KEY,
      company_id INTEGER REFERENCES companies(id),
      employee_id TEXT NOT NULL,
      project TEXT,
      type TEXT NOT NULL DEFAULT 'other',
      latitude DOUBLE PRECISION,
      longitude DOUBLE PRECISION,
      note TEXT,
      status TEXT NOT NULL DEFAULT 'open',
      acknowledged_by TEXT,
      acknowledged_at TIMESTAMPTZ,
      resolution_note TEXT,
      resolved_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  await pool.query('CREATE INDEX IF NOT EXISTS idx_sos_company ON sos_alerts(company_id);');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_sos_status ON sos_alerts(status);');

  // Company Communication — broadcast announcements. audience: 'all' | 'project' | 'staff'
  // (staff = admin/manager/coordinator only, not employees). project is set only when
  // audience = 'project'.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS announcements (
      id SERIAL PRIMARY KEY,
      company_id INTEGER REFERENCES companies(id),
      title TEXT NOT NULL,
      message TEXT NOT NULL,
      audience TEXT NOT NULL DEFAULT 'all',
      project TEXT,
      pinned INTEGER NOT NULL DEFAULT 0,
      created_by TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  await pool.query('CREATE INDEX IF NOT EXISTS idx_announcements_company ON announcements(company_id);');

  // ---------------------------------------------------------------------------------------
  // LIVE LOCATION TRACKING (while on_duty) + RELIEVER AUTO-ASSIGN
  // ---------------------------------------------------------------------------------------

  // Current live position — overwritten on every ping while on_duty, cleared on off_duty
  // punch (see routes/attendance.js). This is what "who's near site X right now" and the
  // reliever ranking's distance score both read from.
  await pool.query('ALTER TABLE employees ADD COLUMN IF NOT EXISTS live_latitude DOUBLE PRECISION;');
  await pool.query('ALTER TABLE employees ADD COLUMN IF NOT EXISTS live_longitude DOUBLE PRECISION;');
  await pool.query('ALTER TABLE employees ADD COLUMN IF NOT EXISTS live_last_ping_at TIMESTAMPTZ;');
  // Live battery level — reported by the native Android app on every location ping
  // (browser/WebView has no reliable API for this). Lets admins spot a phone about
  // to die BEFORE tracking silently drops out, instead of only after the fact.
  await pool.query('ALTER TABLE employees ADD COLUMN IF NOT EXISTS live_battery_percent SMALLINT;');
  await pool.query('ALTER TABLE employees ADD COLUMN IF NOT EXISTS live_is_charging BOOLEAN;');

  // Full trail of pings — an insert-only history, separate from the single "current position"
  // columns above, so a site-wise "who has been near here today" search is possible even
  // after someone moves on, not just their latest position.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS location_pings (
      id SERIAL PRIMARY KEY,
      company_id INTEGER REFERENCES companies(id),
      employee_id TEXT NOT NULL,
      latitude DOUBLE PRECISION NOT NULL,
      longitude DOUBLE PRECISION NOT NULL,
      recorded_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  await pool.query('CREATE INDEX IF NOT EXISTS idx_location_pings_emp ON location_pings(employee_id, recorded_at DESC);');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_location_pings_company ON location_pings(company_id, recorded_at DESC);');

  // ---------------------------------------------------------------------------------------
  // IN-APP NOTIFICATIONS — real per-employee feed with read/unread state. Previously the
  // Alerts tab only ever showed the announcements list (broadcast-only, no read tracking).
  // This table backs individual events too: leave approved/rejected, reliever assigned, etc.
  // ---------------------------------------------------------------------------------------
  await pool.query(`
    CREATE TABLE IF NOT EXISTS notifications (
      id SERIAL PRIMARY KEY,
      company_id INTEGER REFERENCES companies(id),
      employee_id TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'general',
      title TEXT NOT NULL,
      body TEXT NOT NULL DEFAULT '',
      is_read BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  await pool.query('CREATE INDEX IF NOT EXISTS idx_notifications_employee ON notifications(employee_id, company_id, created_at DESC);');

  // Push token — set by the native Android app (FCM) or a future web-push client, so the
  // backend has somewhere to target these notification events with a real device push.
  await pool.query('ALTER TABLE employees ADD COLUMN IF NOT EXISTS push_token TEXT;');

  // Per-company Reliever Auto-Assign toggle — admin-controlled (not super-admin/platform
  // settings, since this is an operational on/off switch an admin flips daily, not a
  // platform-level feature entitlement). When enabled, server.js's background loop scans
  // for shortage sites and force-assigns the nearest free employee automatically.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS reliever_auto_assign_settings (
      company_id INTEGER PRIMARY KEY REFERENCES companies(id),
      enabled BOOLEAN NOT NULL DEFAULT false,
      radius_km NUMERIC NOT NULL DEFAULT 15,
      updated_by TEXT,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  // Auto-assign fills a general headcount SHORTAGE at a site, not "cover for this one
  // specific absent person" — so unlike a manual/forced assignment, there's no single
  // original_employee_id to point at. Relax the NOT NULL constraint from the original
  // (manual-only) design to allow that.
  await pool.query('ALTER TABLE reliever_assignments ALTER COLUMN original_employee_id DROP NOT NULL;');

  // Location-level required headcount — the actual fix for "shortage detection only worked
  // at whole-project level". A project with 100 sub-locations (4 employees each) needs
  // shortage tracked PER location, not just as one project-wide total, or a shortage at one
  // building can hide behind surplus at another. Same fields/defaults as projects'.
  await pool.query('ALTER TABLE site_locations ADD COLUMN IF NOT EXISTS required_manpower INTEGER NOT NULL DEFAULT 0;');
  // A reliever assignment can now target a specific sub-location (not just the whole
  // project) — nullable, so all pre-existing project-wide assignments are unaffected.
  await pool.query('ALTER TABLE reliever_assignments ADD COLUMN IF NOT EXISTS site_location_id INTEGER REFERENCES site_locations(id) ON DELETE SET NULL;');
  // Same for escalations — a shortage escalation can now point at a specific sub-location.
  await pool.query('ALTER TABLE emergency_escalations ADD COLUMN IF NOT EXISTS site_location_id INTEGER REFERENCES site_locations(id) ON DELETE SET NULL;');
  await pool.query('ALTER TABLE emergency_escalations ADD COLUMN IF NOT EXISTS location_name TEXT;');

  // ---------------------------------------------------------------------------------------
  // SITE LOCATIONS — a single project (site) can span many physical spots (e.g. one "MCGM
  // Ward 12" project covering 100 separate buildings, 4 employees each). Each project still
  // has its own single geofence (§ projects.latitude/longitude/geofence_radius_m, used as a
  // fallback) — this table lets specific SUB-locations within that project have their own,
  // tighter geofence, and lets an employee be assigned to exactly one of them.
  // ---------------------------------------------------------------------------------------
  await pool.query(`
    CREATE TABLE IF NOT EXISTS site_locations (
      id SERIAL PRIMARY KEY,
      company_id INTEGER REFERENCES companies(id),
      project TEXT NOT NULL,
      name TEXT NOT NULL,
      latitude DOUBLE PRECISION NOT NULL,
      longitude DOUBLE PRECISION NOT NULL,
      radius_m NUMERIC NOT NULL DEFAULT 200,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  await pool.query('CREATE UNIQUE INDEX IF NOT EXISTS site_locations_company_project_name_uq ON site_locations(company_id, project, name);');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_site_locations_project ON site_locations(company_id, project);');

  // Which specific sub-location (if any) an employee punches from. NULL = this employee's
  // geofence falls back to their project's own single geofence, exactly as before this
  // feature existed — fully backward compatible, opt-in per employee.
  await pool.query('ALTER TABLE employees ADD COLUMN IF NOT EXISTS site_location_id INTEGER REFERENCES site_locations(id) ON DELETE SET NULL;');

  // ---------------------------------------------------------------------------------------
  // DEVICE BINDING + FAKE-GPS SIGNALS — the first punch from an employee "binds" their
  // device fingerprint; later punches from a materially different device are flagged (not
  // blocked outright — phones legitimately get replaced) so an admin can see it. Separately,
  // punches implying impossible travel speed since the employee's last known position ARE
  // blocked outright (teleporting between two points a few minutes apart is never real GPS).
  // ---------------------------------------------------------------------------------------
  await pool.query('ALTER TABLE employees ADD COLUMN IF NOT EXISTS bound_device_id TEXT;');
  await pool.query('ALTER TABLE employees ADD COLUMN IF NOT EXISTS bound_device_set_at TIMESTAMPTZ;');
  await pool.query('ALTER TABLE attendance ADD COLUMN IF NOT EXISTS device_id TEXT;');
  await pool.query('ALTER TABLE attendance ADD COLUMN IF NOT EXISTS device_mismatch BOOLEAN NOT NULL DEFAULT false;');

  // ---------------------------------------------------------------------------------------
  // OFFLINE ATTENDANCE SYNC — when a punch is submitted by the client's own retry queue
  // (network was down at the actual moment of punching, see app.js's offline outbox) rather
  // than live, it's tagged here so admins can distinguish "synced late" from "punched late".
  // ---------------------------------------------------------------------------------------
  await pool.query('ALTER TABLE attendance ADD COLUMN IF NOT EXISTS synced_late BOOLEAN NOT NULL DEFAULT false;');
  await pool.query('ALTER TABLE attendance ADD COLUMN IF NOT EXISTS captured_at TIMESTAMPTZ;');

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
