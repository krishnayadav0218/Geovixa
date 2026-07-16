const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { pool } = require('../db');
const { verifyAdmin, verifyAdminOrManager } = require('../middleware');

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

  const token = signToken({ id: account.id, username: account.username, role: account.role });
  res.json({ token, username: account.username, role: account.role });
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
    if (!['admin', 'manager', 'krystal'].includes(decoded.role)) {
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
    "SELECT id, username, created_at FROM admins WHERE role = 'manager' ORDER BY id DESC"
  );
  res.json({ count: rows.length, managers: rows });
});

router.post('/managers', verifyAdmin, async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password || password.length < 6) {
    return res.status(400).json({ error: 'Username and password (min 6 characters) are required' });
  }
  try {
    const hash = bcrypt.hashSync(password, 10);
    await pool.query(
      "INSERT INTO admins (username, password_hash, role) VALUES ($1, $2, 'manager')",
      [username.trim(), hash]
    );
    res.json({ message: 'Manager account created successfully' });
  } catch (err) {
    if (err.code === '23505') { // postgres unique_violation
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

// ---- krystal account management, same permissions as manager, admin only ----

router.get('/krystal-accounts', verifyAdmin, async (req, res) => {
  const { rows } = await pool.query(
    "SELECT id, username, created_at FROM admins WHERE role = 'krystal' ORDER BY id DESC"
  );
  res.json({ count: rows.length, accounts: rows });
});

router.post('/krystal-accounts', verifyAdmin, async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password || password.length < 6) {
    return res.status(400).json({ error: 'Username and password (min 6 characters) are required' });
  }
  try {
    const hash = bcrypt.hashSync(password, 10);
    await pool.query(
      "INSERT INTO admins (username, password_hash, role) VALUES ($1, $2, 'krystal')",
      [username.trim(), hash]
    );
    res.json({ message: 'Krystal account created successfully' });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'This username already exists' });
    }
    res.status(500).json({ error: err.message });
  }
});

router.delete('/krystal-accounts/:id', verifyAdmin, async (req, res) => {
  const result = await pool.query("DELETE FROM admins WHERE id = $1 AND role = 'krystal'", [req.params.id]);
  if (result.rowCount === 0) return res.status(404).json({ error: 'Krystal account not found' });
  res.json({ message: 'Krystal account removed' });
});

// GET /api/auth/me -> whoami, used by the web app to restore session role
router.get('/me', verifyAdminOrManager, (req, res) => {
  res.json({ username: req.user.username, role: req.user.role });
});

module.exports = router;
