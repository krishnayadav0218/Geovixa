const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../db');
const { verifyAdmin, verifyAdminOrManager } = require('../middleware');

function signToken(payload, expiresIn = '12h') {
  return jwt.sign(payload, process.env.JWT_SECRET, { expiresIn });
}

// ---------------------------------------------------------------------------
// POST /api/auth/login  -> used by BOTH Admin and Manager (username + password)
// ---------------------------------------------------------------------------
function handleLogin(req, res) {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password required' });
  }

  const account = db.prepare('SELECT * FROM admins WHERE username = ?').get(username.trim());
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
// Kept for backward compatibility with anything still calling the old path.
router.post('/admin-login', handleLogin);

// ---------------------------------------------------------------------------
// POST /api/auth/employee-login  -> Employee logs in with ONLY their Employee ID
// ---------------------------------------------------------------------------
router.post('/employee-login', (req, res) => {
  const { employee_id } = req.body;
  if (!employee_id || !employee_id.trim()) {
    return res.status(400).json({ error: 'Employee ID is required' });
  }

  const emp = db.prepare('SELECT * FROM employees WHERE employee_id = ?').get(employee_id.trim());
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

// ---------------------------------------------------------------------------
// POST /api/auth/change-password  -> logged-in admin/manager changes own password
// ---------------------------------------------------------------------------
router.post('/change-password', (req, res) => {
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
    db.prepare('UPDATE admins SET password_hash = ? WHERE id = ?').run(hash, decoded.id);
    res.json({ message: 'Password updated successfully' });
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
});

// ---------------------------------------------------------------------------
// MANAGER ACCOUNT MANAGEMENT -> Admin only
// ---------------------------------------------------------------------------

// GET /api/auth/managers -> list all manager accounts
router.get('/managers', verifyAdmin, (req, res) => {
  const managers = db.prepare("SELECT id, username, created_at FROM admins WHERE role = 'manager' ORDER BY id DESC").all();
  res.json({ count: managers.length, managers });
});

// POST /api/auth/managers -> create a new manager account
router.post('/managers', verifyAdmin, (req, res) => {
  const { username, password } = req.body;
  if (!username || !password || password.length < 6) {
    return res.status(400).json({ error: 'Username and password (min 6 characters) are required' });
  }
  try {
    const hash = bcrypt.hashSync(password, 10);
    db.prepare("INSERT INTO admins (username, password_hash, role) VALUES (?, ?, 'manager')")
      .run(username.trim(), hash);
    res.json({ message: 'Manager account created successfully' });
  } catch (err) {
    if (err.message.includes('UNIQUE')) {
      return res.status(409).json({ error: 'This username already exists' });
    }
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/auth/managers/:id -> remove a manager account
router.delete('/managers/:id', verifyAdmin, (req, res) => {
  const info = db.prepare("DELETE FROM admins WHERE id = ? AND role = 'manager'").run(req.params.id);
  if (info.changes === 0) return res.status(404).json({ error: 'Manager not found' });
  res.json({ message: 'Manager account removed' });
});

// ---------------------------------------------------------------------------
// KRYSTAL ACCOUNT MANAGEMENT -> Admin only. Same permission level as Manager
// (view attendance + download reports), just a separate branded login/identity.
// ---------------------------------------------------------------------------

// GET /api/auth/krystal-accounts -> list all Krystal accounts
router.get('/krystal-accounts', verifyAdmin, (req, res) => {
  const accounts = db.prepare("SELECT id, username, created_at FROM admins WHERE role = 'krystal' ORDER BY id DESC").all();
  res.json({ count: accounts.length, accounts });
});

// POST /api/auth/krystal-accounts -> create a new Krystal account
router.post('/krystal-accounts', verifyAdmin, (req, res) => {
  const { username, password } = req.body;
  if (!username || !password || password.length < 6) {
    return res.status(400).json({ error: 'Username and password (min 6 characters) are required' });
  }
  try {
    const hash = bcrypt.hashSync(password, 10);
    db.prepare("INSERT INTO admins (username, password_hash, role) VALUES (?, ?, 'krystal')")
      .run(username.trim(), hash);
    res.json({ message: 'Krystal account created successfully' });
  } catch (err) {
    if (err.message.includes('UNIQUE')) {
      return res.status(409).json({ error: 'This username already exists' });
    }
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/auth/krystal-accounts/:id -> remove a Krystal account
router.delete('/krystal-accounts/:id', verifyAdmin, (req, res) => {
  const info = db.prepare("DELETE FROM admins WHERE id = ? AND role = 'krystal'").run(req.params.id);
  if (info.changes === 0) return res.status(404).json({ error: 'Krystal account not found' });
  res.json({ message: 'Krystal account removed' });
});

// GET /api/auth/me -> whoami (admin/manager), useful for the web app to restore session role
router.get('/me', verifyAdminOrManager, (req, res) => {
  res.json({ username: req.user.username, role: req.user.role });
});

module.exports = router;
