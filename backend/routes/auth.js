const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { pool } = require('../db');
const { verifyAdmin, verifyAdminOrManager, verifyReports } = require('../middleware');
const { validateCompanyCode } = require('../policy');
const { getCompanySettings, checkRolePermission } = require('../companySettings');
const { verifyToken } = require('../totp');

function signToken(payload, expiresIn = '12h') {
  return jwt.sign(payload, process.env.JWT_SECRET, { expiresIn });
}

// Looks up an ACTIVE, NOT-EXPIRED company by its Company Code (case-insensitive). Every
// non-super-admin login (Admin/Manager/Coordinator/report-only-role AND Employee) now starts
// here — the Company Code is how the shared app knows which tenant's data to check against.
async function findActiveCompany(rawCode) {
  const check = validateCompanyCode(rawCode);
  if (!check.ok) return { ok: false, error: check.error };

  const { rows } = await pool.query('SELECT * FROM companies WHERE UPPER(code) = $1', [check.code]);
  const company = rows[0];
  if (!company) return { ok: false, error: 'Company Code not found. Please check with your admin.' };
  if (!company.active) return { ok: false, error: 'This company\'s account is currently inactive. Please contact support.' };
  // expires_at (subscription/plan end date, set by the platform owner) — NULL means no
  // expiry. Compared as plain date strings (YYYY-MM-DD), same pattern used throughout this
  // codebase for attendance dates, so this is timezone-safe.
  if (company.expires_at) {
    const todayStr = new Date().toISOString().slice(0, 10);
    const expiryStr = new Date(company.expires_at).toISOString().slice(0, 10);
    if (expiryStr < todayStr) {
      return { ok: false, error: 'Your company\'s subscription has expired. Please contact support to renew access.' };
    }
  }
  return { ok: true, company };
}

// POST /api/auth/login  -> used by Admin / Manager / Coordinator / report-only-role
// (username + password + company_code)
async function handleLogin(req, res) {
  const { username, password, company_code } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password required' });
  }
  const companyResult = await findActiveCompany(company_code);
  if (!companyResult.ok) {
    return res.status(400).json({ error: companyResult.error });
  }
  const company = companyResult.company;

  const { rows } = await pool.query(
    "SELECT * FROM admins WHERE company_id = $1 AND username = $2 AND role <> 'super_admin'",
    [company.id, username.trim()]
  );
  const account = rows[0];
  if (!account) {
    return res.status(401).json({ error: 'Invalid Company Code, username or password' });
  }

  const valid = bcrypt.compareSync(password, account.password_hash);
  if (!valid) {
    return res.status(401).json({ error: 'Invalid Company Code, username or password' });
  }

  const payload = {
    id: account.id,
    username: account.username,
    role: account.role,
    project: account.project || null,
    custom_role_name: account.custom_role_name || null,
    scope_zone: account.scope_zone || null,
    scope_ward: account.scope_ward || null,
    scope_location: account.scope_location || null,
    company_id: company.id,
    company_name: company.name,
    company_code: company.code,
    company_logo_url: company.logo_url || null,
  };
  const token = signToken(payload);
  const settings = await getCompanySettings(pool, company.id);
  res.json({ token, ...payload, settings });
}

router.post('/login', handleLogin);
// old path, kept working in case anything out there still calls it
router.post('/admin-login', handleLogin);

// GET /api/auth/company-lookup?code=XXXX -> PUBLIC, no login required. Returns just a
// company's display name + logo (nothing else — no employee counts, no contact info) so
// login screens can show "Signing in to: <Company>" as the person types their Company Code,
// before they've actually authenticated. 404s (rather than leaking "inactive") for an
// inactive company, same as login itself, so this can't be used to fingerprint which
// companies exist vs. which are merely switched off.
router.get('/company-lookup', async (req, res) => {
  const check = validateCompanyCode(req.query.code);
  if (!check.ok) return res.status(400).json({ error: check.error });

  const { rows } = await pool.query('SELECT name, logo_url, active FROM companies WHERE UPPER(code) = $1', [check.code]);
  const company = rows[0];
  if (!company || !company.active) return res.status(404).json({ error: 'Company not found' });

  res.json({ name: company.name, logo_url: company.logo_url });
});

// POST /api/auth/super-admin-login -> PLATFORM OWNER only (username + password, no company
// code — this account isn't tied to any single company). Used solely to reach the Companies
// panel where new client companies get onboarded.
// If this account has 2FA enabled (see routes/companies.js '/2fa/*'), a valid username +
// password alone gets a `{ requires_2fa: true }` response instead of a token — the frontend
// then re-submits the SAME request with a `totp_token` (the 6-digit authenticator code)
// added, which completes the login.
router.post('/super-admin-login', async (req, res) => {
  const { username, password, totp_token } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password required' });
  }

  const { rows } = await pool.query(
    "SELECT * FROM admins WHERE username = $1 AND role = 'super_admin' AND company_id IS NULL",
    [username.trim()]
  );
  const account = rows[0];
  if (!account) return res.status(401).json({ error: 'Invalid username or password' });

  const valid = bcrypt.compareSync(password, account.password_hash);
  if (!valid) return res.status(401).json({ error: 'Invalid username or password' });

  if (account.totp_enabled) {
    if (!totp_token) {
      // Password confirmed correct — now ask the frontend for the 2FA code, without issuing
      // a token yet. Not itself a security-sensitive leak: this only ever happens after the
      // real password has already been verified above.
      return res.json({ requires_2fa: true });
    }
    if (!verifyToken(account.totp_secret, totp_token)) {
      return res.status(401).json({ error: 'Incorrect authentication code. Please try again.' });
    }
  }

  const token = signToken({ id: account.id, username: account.username, role: 'super_admin', company_id: null });
  res.json({ token, username: account.username, role: 'super_admin' });
});

// POST /api/auth/employee-login  -> employee logs in with Company Code + Employee ID + PIN
router.post('/employee-login', async (req, res) => {
  const { employee_id, pin, company_code } = req.body;
  if (!employee_id || !employee_id.trim()) {
    return res.status(400).json({ error: 'Employee ID is required' });
  }
  const companyResult = await findActiveCompany(company_code);
  if (!companyResult.ok) {
    return res.status(400).json({ error: companyResult.error });
  }
  const company = companyResult.company;

  const { rows } = await pool.query(
    'SELECT * FROM employees WHERE company_id = $1 AND employee_id = $2',
    [company.id, employee_id.trim()]
  );
  const emp = rows[0];
  if (!emp) return res.status(401).json({ error: 'Incorrect Company Code or Employee ID. Please check and try again.' });
  if (!emp.active) return res.status(403).json({ error: 'This Employee ID is deactivated. Contact admin.' });

  // PIN is OPTIONAL, set per-employee by the admin (see routes/employees.js). If this
  // employee has no PIN on file, Employee ID alone logs them in — no PIN prompt/check at all.
  // If they DO have one set, it must be provided and match.
  if (emp.pin_hash) {
    if (!pin || !String(pin).trim()) {
      return res.status(400).json({ error: 'PIN is required for this Employee ID' });
    }
    const pinValid = bcrypt.compareSync(String(pin).trim(), emp.pin_hash);
    if (!pinValid) {
      return res.status(401).json({ error: 'Incorrect PIN. Please check and try again.' });
    }
  }

  const payload = {
    employee_id: emp.employee_id,
    name: emp.name,
    designation: emp.designation,
    role: 'employee',
    company_id: company.id,
    company_name: company.name,
    company_code: company.code,
  };
  const token = signToken(payload);
  const settings = await getCompanySettings(pool, company.id);

  res.json({
    token,
    role: 'employee',
    company: { id: company.id, name: company.name, code: company.code, logo_url: company.logo_url || null },
    employee: { employee_id: emp.employee_id, name: emp.name, designation: emp.designation, phone: emp.phone },
    settings,
  });
});

// POST /api/auth/change-password  -> logged-in admin/manager changes own password
router.post('/change-password', async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: 'No token provided' });

  try {
    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (!['admin', 'manager', 'coordinator', 'report_viewer', 'super_admin'].includes(decoded.role)) {
      return res.status(403).json({ error: 'Not allowed' });
    }
    const { newPassword } = req.body;
    if (!newPassword || newPassword.length < 6) {
      return res.status(400).json({ error: 'New password must be at least 6 characters' });
    }
    const hash = bcrypt.hashSync(newPassword, 10);
    await pool.query('UPDATE admins SET password_hash = $1 WHERE id = $2', [hash, decoded.id]);
    res.json({ message: 'Password updated successfully' });
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
});

// ---- manager account management, admin only (scoped to the admin's own company) ----

router.get('/managers', verifyAdmin, async (req, res) => {
  const allowed = await checkRolePermission(pool, req.user.company_id, req.user.role, 'managers');
  if (!allowed) return res.status(403).json({ error: 'You do not have access to the Managers section.' });

  const { rows } = await pool.query(
    "SELECT id, username, project, created_at FROM admins WHERE role = 'manager' AND company_id = $1 ORDER BY id DESC",
    [req.user.company_id]
  );
  res.json({ count: rows.length, managers: rows });
});

router.post('/managers', verifyAdmin, async (req, res) => {
  const { username, password, project } = req.body;
  if (!username || !password || password.length < 6) {
    return res.status(400).json({ error: 'Username and password (min 6 characters) are required' });
  }
  if (!project || !project.trim()) {
    return res.status(400).json({ error: 'Project is required — this Manager will only be able to see that project\'s data' });
  }
  try {
    const hash = bcrypt.hashSync(password, 10);
    await pool.query(
      "INSERT INTO admins (username, password_hash, role, project, company_id) VALUES ($1, $2, 'manager', $3, $4)",
      [username.trim(), hash, project.trim(), req.user.company_id]
    );
    res.json({ message: 'Manager account created successfully' });
  } catch (err) {
    if (err.code === '23505') { // postgres unique_violation
      return res.status(409).json({ error: 'This username already exists' });
    }
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/auth/managers/:id -> admin edits a Manager's username / project / (optionally) password
router.put('/managers/:id', verifyAdmin, async (req, res) => {
  const { username, password, project } = req.body;
  const { rows } = await pool.query(
    "SELECT * FROM admins WHERE id = $1 AND role = 'manager' AND company_id = $2",
    [req.params.id, req.user.company_id]
  );
  const existing = rows[0];
  if (!existing) return res.status(404).json({ error: 'Manager not found' });

  if (username !== undefined && !username.trim()) {
    return res.status(400).json({ error: 'Username cannot be empty' });
  }
  if (project !== undefined && !project.trim()) {
    return res.status(400).json({ error: "Project is required — this Manager will only be able to see that project's data" });
  }
  if (password !== undefined && password !== '' && password.length < 6) {
    return res.status(400).json({ error: 'New password must be at least 6 characters' });
  }

  try {
    const newUsername = username !== undefined ? username.trim() : existing.username;
    const newProject = project !== undefined ? project.trim() : existing.project;
    const newHash = (password !== undefined && password !== '') ? bcrypt.hashSync(password, 10) : existing.password_hash;

    await pool.query(
      'UPDATE admins SET username = $1, project = $2, password_hash = $3 WHERE id = $4 AND company_id = $5',
      [newUsername, newProject, newHash, req.params.id, req.user.company_id]
    );
    res.json({ message: 'Manager account updated successfully' });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'This username already exists' });
    }
    res.status(500).json({ error: err.message });
  }
});

router.delete('/managers/:id', verifyAdmin, async (req, res) => {
  const result = await pool.query(
    "DELETE FROM admins WHERE id = $1 AND role = 'manager' AND company_id = $2",
    [req.params.id, req.user.company_id]
  );
  if (result.rowCount === 0) return res.status(404).json({ error: 'Manager not found' });
  res.json({ message: 'Manager account removed' });
});

// ---- coordinator account management, same permissions as manager, admin only (own company) ----

router.get('/coordinator-accounts', verifyAdmin, async (req, res) => {
  const allowed = await checkRolePermission(pool, req.user.company_id, req.user.role, 'coordinators');
  if (!allowed) return res.status(403).json({ error: 'You do not have access to the Coordinators section.' });

  const { rows } = await pool.query(
    "SELECT id, username, project, created_at FROM admins WHERE role = 'coordinator' AND company_id = $1 ORDER BY id DESC",
    [req.user.company_id]
  );
  res.json({ count: rows.length, accounts: rows });
});

router.post('/coordinator-accounts', verifyAdmin, async (req, res) => {
  const { username, password, project } = req.body;
  if (!username || !password || password.length < 6) {
    return res.status(400).json({ error: 'Username and password (min 6 characters) are required' });
  }
  if (!project || !project.trim()) {
    return res.status(400).json({ error: 'Project is required — this Coordinator will only be able to see that project\'s data' });
  }
  try {
    const hash = bcrypt.hashSync(password, 10);
    await pool.query(
      "INSERT INTO admins (username, password_hash, role, project, company_id) VALUES ($1, $2, 'coordinator', $3, $4)",
      [username.trim(), hash, project.trim(), req.user.company_id]
    );
    res.json({ message: 'Coordinator account created successfully' });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'This username already exists' });
    }
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/auth/coordinator-accounts/:id -> admin edits a Coordinator's username / project / (optionally) password
router.put('/coordinator-accounts/:id', verifyAdmin, async (req, res) => {
  const { username, password, project } = req.body;
  const { rows } = await pool.query(
    "SELECT * FROM admins WHERE id = $1 AND role = 'coordinator' AND company_id = $2",
    [req.params.id, req.user.company_id]
  );
  const existing = rows[0];
  if (!existing) return res.status(404).json({ error: 'Coordinator account not found' });

  if (username !== undefined && !username.trim()) {
    return res.status(400).json({ error: 'Username cannot be empty' });
  }
  if (project !== undefined && !project.trim()) {
    return res.status(400).json({ error: "Project is required — this Coordinator will only be able to see that project's data" });
  }
  if (password !== undefined && password !== '' && password.length < 6) {
    return res.status(400).json({ error: 'New password must be at least 6 characters' });
  }

  try {
    const newUsername = username !== undefined ? username.trim() : existing.username;
    const newProject = project !== undefined ? project.trim() : existing.project;
    const newHash = (password !== undefined && password !== '') ? bcrypt.hashSync(password, 10) : existing.password_hash;

    await pool.query(
      'UPDATE admins SET username = $1, project = $2, password_hash = $3 WHERE id = $4 AND company_id = $5',
      [newUsername, newProject, newHash, req.params.id, req.user.company_id]
    );
    res.json({ message: 'Coordinator account updated successfully' });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'This username already exists' });
    }
    res.status(500).json({ error: err.message });
  }
});

router.delete('/coordinator-accounts/:id', verifyAdmin, async (req, res) => {
  const result = await pool.query(
    "DELETE FROM admins WHERE id = $1 AND role = 'coordinator' AND company_id = $2",
    [req.params.id, req.user.company_id]
  );
  if (result.rowCount === 0) return res.status(404).json({ error: 'Coordinator account not found' });
  res.json({ message: 'Coordinator account removed' });
});

// GET /api/auth/me -> whoami, used by the web app to restore session role
router.get('/me', verifyReports, async (req, res) => {
  const settings = req.user.company_id ? await getCompanySettings(pool, req.user.company_id) : null;
  res.json({
    username: req.user.username,
    role: req.user.role,
    project: req.user.project || null,
    custom_role_name: req.user.custom_role_name || null,
    scope_zone: req.user.scope_zone || null,
    scope_ward: req.user.scope_ward || null,
    scope_location: req.user.scope_location || null,
    company_id: req.user.company_id || null,
    company_name: req.user.company_name || null,
    company_code: req.user.company_code || null,
    company_logo_url: req.user.company_logo_url || null,
    settings,
  });
});

// ---- custom role NAMES (Area Officer, Supervisor, etc.), admin only (own company) ----
// These are just labels the Admin curates once (Managers tab -> Roles). Every account created
// under one of these labels is internally role = 'report_viewer' (see role-accounts below) —
// custom_role_name only controls what's shown in the UI and what the Admin can pick from.

router.get('/role-types', verifyAdmin, async (req, res) => {
  const { rows } = await pool.query(
    'SELECT * FROM custom_roles WHERE company_id = $1 ORDER BY name ASC',
    [req.user.company_id]
  );
  res.json({ count: rows.length, roles: rows });
});

router.post('/role-types', verifyAdmin, async (req, res) => {
  const { name } = req.body;
  if (!name || !name.trim()) {
    return res.status(400).json({ error: 'Role name is required' });
  }
  try {
    await pool.query('INSERT INTO custom_roles (name, company_id) VALUES ($1, $2)', [name.trim(), req.user.company_id]);
    res.json({ message: 'Role added successfully' });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'This role already exists' });
    }
    res.status(500).json({ error: err.message });
  }
});

router.delete('/role-types/:id', verifyAdmin, async (req, res) => {
  const { rows } = await pool.query(
    'SELECT * FROM custom_roles WHERE id = $1 AND company_id = $2',
    [req.params.id, req.user.company_id]
  );
  const role = rows[0];
  if (!role) return res.status(404).json({ error: 'Role not found' });

  const inUse = await pool.query(
    "SELECT COUNT(*)::int AS count FROM admins WHERE role = 'report_viewer' AND custom_role_name = $1 AND company_id = $2",
    [role.name, req.user.company_id]
  );
  if (inUse.rows[0].count > 0) {
    return res.status(409).json({
      error: `${inUse.rows[0].count} account(s) still use the "${role.name}" role — remove or reassign them first`,
    });
  }

  await pool.query('DELETE FROM custom_roles WHERE id = $1 AND company_id = $2', [req.params.id, req.user.company_id]);
  res.json({ message: 'Role removed' });
});

// ---- report-only role accounts (Area Officer / Supervisor / any custom role), admin only,
// scoped to the admin's own company ----
// Same account model as Manager/Coordinator (username + password + Project), but internally
// role = 'report_viewer' — locked to Reports only (routes/export.js is the only route group
// that accepts this role, see middleware.js verifyReports) — and additionally narrowed to
// specific Zone(s)/Ward(s)/Location(s) within that Project via scope_zone/scope_ward/
// scope_location (comma-separated; blank = no extra narrowing, full Project access).

router.get('/role-accounts', verifyAdmin, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id, username, project, custom_role_name, scope_zone, scope_ward, scope_location, created_at
     FROM admins WHERE role = 'report_viewer' AND company_id = $1 ORDER BY id DESC`,
    [req.user.company_id]
  );
  res.json({ count: rows.length, accounts: rows });
});

router.post('/role-accounts', verifyAdmin, async (req, res) => {
  const { username, password, project, custom_role_name, scope_zone, scope_ward, scope_location } = req.body;
  if (!username || !password || password.length < 6) {
    return res.status(400).json({ error: 'Username and password (min 6 characters) are required' });
  }
  if (!project || !project.trim()) {
    return res.status(400).json({ error: "Project is required — this account will only be able to see that project's data" });
  }
  if (!custom_role_name || !custom_role_name.trim()) {
    return res.status(400).json({ error: 'Role is required — add one first under "Manage Roles" if it doesn\'t exist yet' });
  }
  try {
    const hash = bcrypt.hashSync(password, 10);
    await pool.query(
      `INSERT INTO admins (username, password_hash, role, project, custom_role_name, scope_zone, scope_ward, scope_location, company_id)
       VALUES ($1, $2, 'report_viewer', $3, $4, $5, $6, $7, $8)`,
      [
        username.trim(), hash, project.trim(), custom_role_name.trim(),
        (scope_zone || '').trim() || null, (scope_ward || '').trim() || null, (scope_location || '').trim() || null,
        req.user.company_id,
      ]
    );
    res.json({ message: 'Account created successfully' });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'This username already exists' });
    }
    res.status(500).json({ error: err.message });
  }
});

router.put('/role-accounts/:id', verifyAdmin, async (req, res) => {
  const { username, password, project, custom_role_name, scope_zone, scope_ward, scope_location } = req.body;
  const { rows } = await pool.query(
    "SELECT * FROM admins WHERE id = $1 AND role = 'report_viewer' AND company_id = $2",
    [req.params.id, req.user.company_id]
  );
  const existing = rows[0];
  if (!existing) return res.status(404).json({ error: 'Account not found' });

  if (username !== undefined && !username.trim()) {
    return res.status(400).json({ error: 'Username cannot be empty' });
  }
  if (project !== undefined && !project.trim()) {
    return res.status(400).json({ error: "Project is required — this account will only be able to see that project's data" });
  }
  if (custom_role_name !== undefined && !custom_role_name.trim()) {
    return res.status(400).json({ error: 'Role cannot be empty' });
  }
  if (password !== undefined && password !== '' && password.length < 6) {
    return res.status(400).json({ error: 'New password must be at least 6 characters' });
  }

  try {
    const newUsername = username !== undefined ? username.trim() : existing.username;
    const newProject = project !== undefined ? project.trim() : existing.project;
    const newRoleName = custom_role_name !== undefined ? custom_role_name.trim() : existing.custom_role_name;
    const newScopeZone = scope_zone !== undefined ? ((scope_zone || '').trim() || null) : existing.scope_zone;
    const newScopeWard = scope_ward !== undefined ? ((scope_ward || '').trim() || null) : existing.scope_ward;
    const newScopeLocation = scope_location !== undefined ? ((scope_location || '').trim() || null) : existing.scope_location;
    const newHash = (password !== undefined && password !== '') ? bcrypt.hashSync(password, 10) : existing.password_hash;

    await pool.query(
      `UPDATE admins SET username = $1, project = $2, custom_role_name = $3, scope_zone = $4,
       scope_ward = $5, scope_location = $6, password_hash = $7 WHERE id = $8 AND company_id = $9`,
      [newUsername, newProject, newRoleName, newScopeZone, newScopeWard, newScopeLocation, newHash, req.params.id, req.user.company_id]
    );
    res.json({ message: 'Account updated successfully' });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'This username already exists' });
    }
    res.status(500).json({ error: err.message });
  }
});

router.delete('/role-accounts/:id', verifyAdmin, async (req, res) => {
  const result = await pool.query(
    "DELETE FROM admins WHERE id = $1 AND role = 'report_viewer' AND company_id = $2",
    [req.params.id, req.user.company_id]
  );
  if (result.rowCount === 0) return res.status(404).json({ error: 'Account not found' });
  res.json({ message: 'Account removed' });
});

module.exports = router;
