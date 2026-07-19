const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { pool } = require('../db');
const { verifyAdmin, verifyAdminOrManager } = require('../middleware');
const { validatePassword } = require('../policy');

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

  const token = signToken({ id: account.id, username: account.username, role: account.role, project: account.project || null });
  res.json({ token, username: account.username, role: account.role, project: account.project || null });
}

router.post('/login', handleLogin);
// old path, kept working in case anything out there still calls it
router.post('/admin-login', handleLogin);

// POST /api/auth/employee-login  -> employee logs in with just their Employee ID (old model)
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
    if (!['admin', 'manager', 'coordinator'].includes(decoded.role)) {
      return res.status(403).json({ error: 'Not allowed' });
    }
    const { newPassword } = req.body;
    const check = validatePassword(newPassword);
    if (!check.ok) {
      return res.status(400).json({ error: check.error });
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
  if (!username) {
    return res.status(400).json({ error: 'Username is required' });
  }
  const passCheck = validatePassword(password);
  if (!passCheck.ok) {
    return res.status(400).json({ error: passCheck.error });
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
  if (password !== undefined && password !== '') {
    const passCheck = validatePassword(password);
    if (!passCheck.ok) {
      return res.status(400).json({ error: passCheck.error });
    }
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
  if (!username) {
    return res.status(400).json({ error: 'Username is required' });
  }
  const passCheck = validatePassword(password);
  if (!passCheck.ok) {
    return res.status(400).json({ error: passCheck.error });
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
  if (password !== undefined && password !== '') {
    const passCheck = validatePassword(password);
    if (!passCheck.ok) {
      return res.status(400).json({ error: passCheck.error });
    }
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
router.get('/me', verifyAdminOrManager, (req, res) => {
  res.json({ username: req.user.username, role: req.user.role, project: req.user.project || null });
});

// POST /api/auth/recover-admin -> reset the primary admin's password using a secret
// recovery key set only in server environment variables (never in the database, never
// visible from the app). This exists because previously there was NO way to get back
// into the system if the admin password was lost — only Admin can reset Manager/
// Coordinator passwords, but nobody could reset Admin's own.
// Setup: set ADMIN_RECOVERY_KEY to a long random secret in your .env / Render env vars.
// Leave it unset to disable this route entirely (returns 404).
router.post('/recover-admin', async (req, res) => {
  if (!process.env.ADMIN_RECOVERY_KEY) {
    return res.status(404).json({ error: 'Not found' });
  }
  const { recoveryKey, newPassword } = req.body;
  if (!recoveryKey || recoveryKey !== process.env.ADMIN_RECOVERY_KEY) {
    return res.status(401).json({ error: 'Invalid recovery key' });
  }
  const passCheck = validatePassword(newPassword);
  if (!passCheck.ok) {
    return res.status(400).json({ error: passCheck.error });
  }

  const { rows } = await pool.query("SELECT * FROM admins WHERE role = 'admin' ORDER BY id ASC LIMIT 1");
  const account = rows[0];
  if (!account) {
    return res.status(404).json({ error: 'No admin account exists to recover' });
  }

  const hash = bcrypt.hashSync(newPassword, 10);
  await pool.query('UPDATE admins SET password_hash = $1 WHERE id = $2', [hash, account.id]);
  res.json({ message: `Password reset for admin account '${account.username}'. You can log in now.` });
});

module.exports = router;
