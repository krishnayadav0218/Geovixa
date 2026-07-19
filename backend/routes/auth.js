const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { pool } = require('../db');
const { verifyAdmin, verifyAdminOrManager, verifyReports } = require('../middleware');

function signToken(payload, expiresIn = '12h') {
  return jwt.sign(payload, process.env.JWT_SECRET, { expiresIn });
}

// POST /api/auth/login  -> used by BOTH Admin and Manager (username + password)
async function handleLogin(req, res) {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password required' });
  }

  const { rows } = await pool.query('SELECT * FROM admins WHERE username = $1', [username.trim()]);
  const account = rows[0];
  if (!account) {
    return res.status(401).json({ error: 'Invalid username or password' });
  }

  const valid = bcrypt.compareSync(password, account.password_hash);
  if (!valid) {
    return res.status(401).json({ error: 'Invalid username or password' });
  }

  const token = signToken({
    id: account.id,
    username: account.username,
    role: account.role,
    project: account.project || null,
    custom_role_name: account.custom_role_name || null,
    scope_zone: account.scope_zone || null,
    scope_ward: account.scope_ward || null,
    scope_location: account.scope_location || null,
  });
  res.json({
    token,
    username: account.username,
    role: account.role,
    project: account.project || null,
    custom_role_name: account.custom_role_name || null,
    scope_zone: account.scope_zone || null,
    scope_ward: account.scope_ward || null,
    scope_location: account.scope_location || null,
  });
}

router.post('/login', handleLogin);
// old path, kept working in case anything out there still calls it
router.post('/admin-login', handleLogin);

// POST /api/auth/employee-login  -> employee logs in with just their Employee ID
router.post('/employee-login', async (req, res) => {
  const { employee_id } = req.body;
  if (!employee_id || !employee_id.trim()) {
    return res.status(400).json({ error: 'Employee ID is required' });
  }

  const { rows } = await pool.query('SELECT * FROM employees WHERE employee_id = $1', [employee_id.trim()]);
  const emp = rows[0];
  if (!emp) return res.status(401).json({ error: 'Incorrect Employee ID. Please check and try again.' });
  if (!emp.active) return res.status(403).json({ error: 'This Employee ID is deactivated. Contact admin.' });

  const token = signToken({
    employee_id: emp.employee_id,
    name: emp.name,
    designation: emp.designation,
    role: 'employee',
  });

  res.json({
    token,
    role: 'employee',
    employee: { employee_id: emp.employee_id, name: emp.name, designation: emp.designation, phone: emp.phone },
  });
});

// POST /api/auth/change-password  -> logged-in admin/manager changes own password
router.post('/change-password', async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: 'No token provided' });

  try {
    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (!['admin', 'manager', 'coordinator', 'report_viewer'].includes(decoded.role)) {
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

// ---- manager account management, admin only ----

router.get('/managers', verifyAdmin, async (req, res) => {
  const { rows } = await pool.query(
    "SELECT id, username, project, created_at FROM admins WHERE role = 'manager' ORDER BY id DESC"
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
      "INSERT INTO admins (username, password_hash, role, project) VALUES ($1, $2, 'manager', $3)",
      [username.trim(), hash, project.trim()]
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
  const { rows } = await pool.query("SELECT * FROM admins WHERE id = $1 AND role = 'manager'", [req.params.id]);
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
      'UPDATE admins SET username = $1, project = $2, password_hash = $3 WHERE id = $4',
      [newUsername, newProject, newHash, req.params.id]
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
  const result = await pool.query("DELETE FROM admins WHERE id = $1 AND role = 'manager'", [req.params.id]);
  if (result.rowCount === 0) return res.status(404).json({ error: 'Manager not found' });
  res.json({ message: 'Manager account removed' });
});

// ---- coordinator account management, same permissions as manager, admin only ----

router.get('/coordinator-accounts', verifyAdmin, async (req, res) => {
  const { rows } = await pool.query(
    "SELECT id, username, project, created_at FROM admins WHERE role = 'coordinator' ORDER BY id DESC"
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
      "INSERT INTO admins (username, password_hash, role, project) VALUES ($1, $2, 'coordinator', $3)",
      [username.trim(), hash, project.trim()]
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
  const { rows } = await pool.query("SELECT * FROM admins WHERE id = $1 AND role = 'coordinator'", [req.params.id]);
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
      'UPDATE admins SET username = $1, project = $2, password_hash = $3 WHERE id = $4',
      [newUsername, newProject, newHash, req.params.id]
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
  const result = await pool.query("DELETE FROM admins WHERE id = $1 AND role = 'coordinator'", [req.params.id]);
  if (result.rowCount === 0) return res.status(404).json({ error: 'Coordinator account not found' });
  res.json({ message: 'Coordinator account removed' });
});

// GET /api/auth/me -> whoami, used by the web app to restore session role
router.get('/me', verifyReports, (req, res) => {
  res.json({
    username: req.user.username,
    role: req.user.role,
    project: req.user.project || null,
    custom_role_name: req.user.custom_role_name || null,
    scope_zone: req.user.scope_zone || null,
    scope_ward: req.user.scope_ward || null,
    scope_location: req.user.scope_location || null,
  });
});

// ---- custom role NAMES (Area Officer, Supervisor, etc.), admin only ----
// These are just labels the Admin curates once (Managers tab -> Roles). Every account created
// under one of these labels is internally role = 'report_viewer' (see role-accounts below) —
// custom_role_name only controls what's shown in the UI and what the Admin can pick from.

router.get('/role-types', verifyAdmin, async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM custom_roles ORDER BY name ASC');
  res.json({ count: rows.length, roles: rows });
});

router.post('/role-types', verifyAdmin, async (req, res) => {
  const { name } = req.body;
  if (!name || !name.trim()) {
    return res.status(400).json({ error: 'Role name is required' });
  }
  try {
    await pool.query('INSERT INTO custom_roles (name) VALUES ($1)', [name.trim()]);
    res.json({ message: 'Role added successfully' });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'This role already exists' });
    }
    res.status(500).json({ error: err.message });
  }
});

router.delete('/role-types/:id', verifyAdmin, async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM custom_roles WHERE id = $1', [req.params.id]);
  const role = rows[0];
  if (!role) return res.status(404).json({ error: 'Role not found' });

  const inUse = await pool.query(
    "SELECT COUNT(*)::int AS count FROM admins WHERE role = 'report_viewer' AND custom_role_name = $1",
    [role.name]
  );
  if (inUse.rows[0].count > 0) {
    return res.status(409).json({
      error: `${inUse.rows[0].count} account(s) still use the "${role.name}" role — remove or reassign them first`,
    });
  }

  await pool.query('DELETE FROM custom_roles WHERE id = $1', [req.params.id]);
  res.json({ message: 'Role removed' });
});

// ---- report-only role accounts (Area Officer / Supervisor / any custom role), admin only ----
// Same account model as Manager/Coordinator (username + password + Project), but internally
// role = 'report_viewer' — locked to Reports only (routes/export.js is the only route group
// that accepts this role, see middleware.js verifyReports) — and additionally narrowed to
// specific Zone(s)/Ward(s)/Location(s) within that Project via scope_zone/scope_ward/
// scope_location (comma-separated; blank = no extra narrowing, full Project access).

router.get('/role-accounts', verifyAdmin, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id, username, project, custom_role_name, scope_zone, scope_ward, scope_location, created_at
     FROM admins WHERE role = 'report_viewer' ORDER BY id DESC`
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
      `INSERT INTO admins (username, password_hash, role, project, custom_role_name, scope_zone, scope_ward, scope_location)
       VALUES ($1, $2, 'report_viewer', $3, $4, $5, $6, $7)`,
      [
        username.trim(), hash, project.trim(), custom_role_name.trim(),
        (scope_zone || '').trim() || null, (scope_ward || '').trim() || null, (scope_location || '').trim() || null,
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
  const { rows } = await pool.query("SELECT * FROM admins WHERE id = $1 AND role = 'report_viewer'", [req.params.id]);
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
       scope_ward = $5, scope_location = $6, password_hash = $7 WHERE id = $8`,
      [newUsername, newProject, newRoleName, newScopeZone, newScopeWard, newScopeLocation, newHash, req.params.id]
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
  const result = await pool.query("DELETE FROM admins WHERE id = $1 AND role = 'report_viewer'", [req.params.id]);
  if (result.rowCount === 0) return res.status(404).json({ error: 'Account not found' });
  res.json({ message: 'Account removed' });
});

module.exports = router;
