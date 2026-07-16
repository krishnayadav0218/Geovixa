const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { verifyAdminOrManager, verifyEmployee, optionalAuth } = require('../middleware');
const { savePhotoAndGetUrl } = require('../photoStorage');

function todayDateStr() {
  const d = new Date();
  return d.toISOString().slice(0, 10); // YYYY-MM-DD, using UTC — fine as long as it's consistent
}

// POST /api/attendance/punch
// body: { employee_id, status: 'on_duty'|'off_duty', photo (base64 selfie), latitude, longitude, address, device_time }
// If a valid employee JWT is present (web app), employee_id comes from the token instead of the
// body, for security. The Android app has no login step so it just sends employee_id directly.
router.post('/punch', optionalAuth, async (req, res) => {
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

  const empResult = await pool.query('SELECT * FROM employees WHERE employee_id = $1', [employee_id.trim()]);
  const emp = empResult.rows[0];
  if (!emp) return res.status(404).json({ error: 'Employee ID not found. Contact admin.' });
  if (!emp.active) return res.status(403).json({ error: 'Your Employee ID is deactivated. Contact admin.' });

  const attendance_date = todayDateStr();

  // only one punch-in and one punch-out per employee per day — stops duplicate/spam punches
  const todaysResult = await pool.query(
    'SELECT status FROM attendance WHERE employee_id = $1 AND attendance_date = $2',
    [employee_id.trim(), attendance_date]
  );
  const todaysRecords = todaysResult.rows;

  const alreadyOnDuty = todaysRecords.some(r => r.status === 'on_duty');
  const alreadyOffDuty = todaysRecords.some(r => r.status === 'off_duty');

  if (status === 'on_duty' && alreadyOnDuty) {
    return res.status(409).json({ error: 'Invalid: You have already Punched In today. Only one Punch In per day is allowed.' });
  }
  if (status === 'off_duty') {
    if (!alreadyOnDuty) {
      return res.status(409).json({ error: 'Invalid: You must Punch In before you can Punch Out.' });
    }
    if (alreadyOffDuty) {
      return res.status(409).json({ error: 'Invalid: You have already Punched Out today. Only one Punch Out per day is allowed.' });
    }
  }

  // selfie gets written to disk, only the URL goes in the DB — keeps rows small and writes fast
  const photoUrl = savePhotoAndGetUrl(employee_id.trim(), photo);

  await pool.query(
    `INSERT INTO attendance
      (employee_id, status, photo, latitude, longitude, address, device_time, attendance_date)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [employee_id.trim(), status, photoUrl, latitude, longitude, address || '', device_time || '', attendance_date]
  );

  res.json({ message: `${status.replace('_', ' ')} recorded successfully`, date: attendance_date });
});

// GET /api/attendance/today/:employeeId -> app/web checks current status for today
router.get('/today/:employeeId', async (req, res) => {
  const { rows } = await pool.query(
    'SELECT status, server_time FROM attendance WHERE employee_id = $1 AND attendance_date = $2 ORDER BY server_time ASC',
    [req.params.employeeId.trim(), todayDateStr()]
  );
  const last = rows.length ? rows[rows.length - 1] : null;
  res.json({ date: todayDateStr(), records: rows, current_status: last ? last.status : null });
});

// employee only — own attendance history
// GET /api/attendance/my?from=YYYY-MM-DD&to=YYYY-MM-DD
router.get('/my', verifyEmployee, async (req, res) => {
  const { from, to } = req.query;
  const employee_id = req.user.employee_id;

  let query = 'SELECT * FROM attendance WHERE employee_id = $1';
  const params = [employee_id];
  if (from) { params.push(from); query += ` AND attendance_date >= $${params.length}`; }
  if (to) { params.push(to); query += ` AND attendance_date <= $${params.length}`; }
  query += ' ORDER BY attendance_date DESC, server_time DESC';

  const { rows } = await pool.query(query, params);
  res.json({ count: rows.length, records: rows });
});

// admin + manager — view everything
// GET /api/attendance?from=YYYY-MM-DD&to=YYYY-MM-DD&employee_id=xxx
router.get('/', verifyAdminOrManager, async (req, res) => {
  const { from, to, employee_id } = req.query;

  let query = `
    SELECT a.*, e.name as employee_name, e.designation
    FROM attendance a
    LEFT JOIN employees e ON e.employee_id = a.employee_id
    WHERE 1=1`;
  const params = [];

  if (from) { params.push(from); query += ` AND a.attendance_date >= $${params.length}`; }
  if (to) { params.push(to); query += ` AND a.attendance_date <= $${params.length}`; }
  if (employee_id) { params.push(employee_id); query += ` AND a.employee_id = $${params.length}`; }

  query += ' ORDER BY a.attendance_date DESC, a.server_time DESC';

  const { rows } = await pool.query(query, params);
  res.json({ count: rows.length, records: rows });
});

// GET /api/attendance/summary?date=YYYY-MM-DD -> latest punch of the day per employee
router.get('/summary', verifyAdminOrManager, async (req, res) => {
  const date = req.query.date || todayDateStr();
  const empResult = await pool.query('SELECT employee_id, name, designation FROM employees WHERE active = 1');
  const recResult = await pool.query(
    'SELECT * FROM attendance WHERE attendance_date = $1 ORDER BY server_time ASC',
    [date]
  );

  const employees = empResult.rows;
  const records = recResult.rows;

  const summary = employees.map(emp => {
    const empRecords = records.filter(r => r.employee_id === emp.employee_id);
    const last = empRecords.length ? empRecords[empRecords.length - 1] : null;
    return {
      employee_id: emp.employee_id,
      name: emp.name,
      designation: emp.designation,
      status: last ? last.status : null, // on_duty | off_duty | null (not marked yet)
      photo: last ? last.photo : null,
      address: last ? last.address : null,
      time: last ? last.server_time : null,
      punch_count: empRecords.length,
    };
  });

  res.json({ date, summary });
});

// GET /api/attendance/grid?from=YYYY-MM-DD&to=YYYY-MM-DD
// Date-wise P/A matrix for the Reports tab. "P" = at least one punch that day, "A" = none.
router.get('/grid', verifyAdminOrManager, async (req, res) => {
  const to = req.query.to || todayDateStr();
  const from = req.query.from || to;

  const empResult = await pool.query(
    'SELECT employee_id, name, designation, location, doj FROM employees WHERE active = 1 ORDER BY employee_id ASC'
  );
  const attResult = await pool.query(
    'SELECT employee_id, attendance_date FROM attendance WHERE attendance_date >= $1 AND attendance_date <= $2',
    [from, to]
  );

  const employees = empResult.rows;
  const rows = attResult.rows;

  const presentSet = new Set(rows.map(r => `${r.employee_id}|${r.attendance_date}`));

  const dates = [];
  const cur = new Date(from + 'T00:00:00Z');
  const end = new Date(to + 'T00:00:00Z');
  while (cur <= end) {
    dates.push(cur.toISOString().slice(0, 10));
    cur.setUTCDate(cur.getUTCDate() + 1);
  }

  const grid = employees.map(emp => {
    const days = {};
    dates.forEach(d => {
      if (emp.doj && d < emp.doj) {
        days[d] = '-'; // not joined yet, not a real absence
      } else {
        days[d] = presentSet.has(`${emp.employee_id}|${d}`) ? 'P' : 'A';
      }
    });
    return { ...emp, days };
  });

  res.json({ from, to, dates, employees: grid });
});

module.exports = router;
