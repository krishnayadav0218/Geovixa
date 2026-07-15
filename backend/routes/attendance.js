const express = require('express');
const router = express.Router();
const db = require('../db');
const { verifyAdminOrManager, verifyEmployee, optionalAuth } = require('../middleware');
const { savePhotoAndGetUrl } = require('../photoStorage');

function todayDateStr() {
  const d = new Date();
  return d.toISOString().slice(0, 10); // YYYY-MM-DD (server local... using UTC here, fine for consistency)
}

// ---------- PUBLIC / EMPLOYEE: called when employee punches in/out ----------
// POST /api/attendance/punch
// body: { employee_id, status: 'on_duty'|'off_duty', photo (base64 data URI, from selfie camera),
//         latitude, longitude, address, device_time }
// If a valid employee JWT is sent (web app), employee_id is taken from the token for security,
// overriding whatever was sent in the body. The Android app (no login) keeps working as before
// by sending employee_id directly in the body.
router.post('/punch', optionalAuth, (req, res) => {
  const { status, photo, latitude, longitude, address, device_time } = req.body;
  const employee_id = (req.user && req.user.role === 'employee') ? req.user.employee_id : req.body.employee_id;

  if (!employee_id || !status || latitude === undefined || longitude === undefined) {
    return res.status(400).json({ error: 'employee_id, status, latitude, longitude are required' });
  }
  if (!['on_duty', 'off_duty'].includes(status)) {
    return res.status(400).json({ error: "status must be 'on_duty' or 'off_duty'" });
  }
  if (!photo) {
    return res.status(400).json({ error: 'Selfie photo is required to mark attendance' });
  }

  const emp = db.prepare('SELECT * FROM employees WHERE employee_id = ?').get(employee_id.trim());
  if (!emp) return res.status(404).json({ error: 'Employee ID not found. Contact admin.' });
  if (!emp.active) return res.status(403).json({ error: 'Your Employee ID is deactivated. Contact admin.' });

  const attendance_date = todayDateStr();

  // Store the selfie as a file on disk and save only its URL in the DB.
  // Keeps DB rows small and writes fast even with hundreds of punches at once.
  const photoUrl = savePhotoAndGetUrl(employee_id.trim(), photo);

  db.prepare(`INSERT INTO attendance
    (employee_id, status, photo, latitude, longitude, address, device_time, attendance_date)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(employee_id.trim(), status, photoUrl, latitude, longitude, address || '', device_time || '', attendance_date);

  res.json({ message: `${status.replace('_', ' ')} recorded successfully`, date: attendance_date });
});

// GET /api/attendance/today/:employeeId -> app/web checks current status for today
router.get('/today/:employeeId', (req, res) => {
  const rows = db.prepare(
    'SELECT status, server_time FROM attendance WHERE employee_id = ? AND attendance_date = ? ORDER BY server_time ASC'
  ).all(req.params.employeeId.trim(), todayDateStr());
  const last = rows.length ? rows[rows.length - 1] : null;
  res.json({ date: todayDateStr(), records: rows, current_status: last ? last.status : null });
});

// ---------- EMPLOYEE ONLY: own attendance history ----------
// GET /api/attendance/my?from=YYYY-MM-DD&to=YYYY-MM-DD
router.get('/my', verifyEmployee, (req, res) => {
  const { from, to } = req.query;
  const employee_id = req.user.employee_id;

  let query = 'SELECT * FROM attendance WHERE employee_id = ?';
  const params = [employee_id];
  if (from) { query += ' AND attendance_date >= ?'; params.push(from); }
  if (to) { query += ' AND attendance_date <= ?'; params.push(to); }
  query += ' ORDER BY attendance_date DESC, server_time DESC';

  const rows = db.prepare(query).all(...params);
  res.json({ count: rows.length, records: rows });
});

// ---------- ADMIN + MANAGER: view all records ----------

// GET /api/attendance?from=YYYY-MM-DD&to=YYYY-MM-DD&employee_id=xxx
router.get('/', verifyAdminOrManager, (req, res) => {
  const { from, to, employee_id } = req.query;

  let query = `
    SELECT a.*, e.name as employee_name, e.designation
    FROM attendance a
    LEFT JOIN employees e ON e.employee_id = a.employee_id
    WHERE 1=1`;
  const params = [];

  if (from) { query += ' AND a.attendance_date >= ?'; params.push(from); }
  if (to) { query += ' AND a.attendance_date <= ?'; params.push(to); }
  if (employee_id) { query += ' AND a.employee_id = ?'; params.push(employee_id); }

  query += ' ORDER BY a.attendance_date DESC, a.server_time DESC';

  const rows = db.prepare(query).all(...params);
  res.json({ count: rows.length, records: rows });
});

// GET /api/attendance/summary?date=YYYY-MM-DD  -> current On Duty / Off Duty status per employee
// Returns each employee's LATEST punch of the day (with photo), not split by morning/evening.
router.get('/summary', verifyAdminOrManager, (req, res) => {
  const date = req.query.date || todayDateStr();
  const employees = db.prepare('SELECT employee_id, name, designation FROM employees WHERE active = 1').all();
  const records = db.prepare('SELECT * FROM attendance WHERE attendance_date = ? ORDER BY server_time ASC').all(date);

  const summary = employees.map(emp => {
    const empRecords = records.filter(r => r.employee_id === emp.employee_id);
    const last = empRecords.length ? empRecords[empRecords.length - 1] : null;
    return {
      employee_id: emp.employee_id,
      name: emp.name,
      designation: emp.designation,
      status: last ? last.status : null,     // 'on_duty' | 'off_duty' | null (not marked yet)
      photo: last ? last.photo : null,
      address: last ? last.address : null,
      time: last ? last.server_time : null,
      punch_count: empRecords.length,
    };
  });

  res.json({ date, summary });
});

module.exports = router;
