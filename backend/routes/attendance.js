const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { verifyAdminOrManager, verifyEmployee, optionalAuth } = require('../middleware');
const { savePhotoAndGetUrl } = require('../photoStorage');
const { computeDayStatus, loadShiftThresholdsMap, loadWeeklyOffMap, loadApprovedLeaveMap } = require('../attendanceStatus');
const { effectiveProjects } = require('../projectScope');
const { validateCompanyCode } = require('../policy');
const { checkRolePermission } = require('../companySettings');

// Returns TODAY's calendar date in India Standard Time (Asia/Kolkata), no matter what
// timezone the server machine itself is running in (Render/Railway containers run in UTC).
// Using plain UTC here was the root cause of "wrong date/time" bugs: IST is UTC+5:30, so
// for the first ~5.5 hours of every IST day, a UTC-based date would still show YESTERDAY's
// date — which could misclassify a punch's attendance_date and mess up the "only show
// today's history" and "one punch-in/out per day" logic right around midnight.
function todayDateStr() {
  return istDateStr(new Date());
}

function istDateStr(date) {
  // en-CA locale gives YYYY-MM-DD directly, which is exactly the format this app stores.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

// Resolves a Company Code query/body param into an active company row, or null.
async function resolveCompanyFromCode(rawCode) {
  const check = validateCompanyCode(rawCode);
  if (!check.ok) return null;
  const { rows } = await pool.query('SELECT * FROM companies WHERE UPPER(code) = $1', [check.code]);
  const company = rows[0];
  if (!company || !company.active) return null;
  return company;
}

// POST /api/attendance/punch
// body: { employee_id, status: 'on_duty'|'off_duty', photo (base64 selfie), latitude, longitude, address, device_time }
// If a valid employee JWT is present (web app), employee_id + company_id come from the token
// instead of the body, for security. The Android app has no login step so it just sends
// employee_id + company_code directly in the body.
router.post('/punch', optionalAuth, async (req, res) => {
  const { status, photo, latitude, longitude, accuracy, address, device_time } = req.body;
  const isEmployeeToken = req.user && req.user.role === 'employee';
  const employee_id = isEmployeeToken ? req.user.employee_id : req.body.employee_id;

  if (!employee_id || !status || latitude === undefined || longitude === undefined) {
    return res.status(400).json({ error: 'employee_id, status, latitude, longitude are required' });
  }
  if (!['on_duty', 'off_duty'].includes(status)) {
    return res.status(400).json({ error: "status must be 'on_duty' or 'off_duty'" });
  }
  if (!photo) {
    return res.status(400).json({ error: 'Selfie photo is required to mark attendance' });
  }

  // Resolve which company this punch belongs to — from the employee's own JWT if they're
  // logged in via the web app, otherwise from a company_code sent directly in the body
  // (legacy Android app).
  let company;
  if (isEmployeeToken) {
    company = { id: req.user.company_id };
  } else {
    company = await resolveCompanyFromCode(req.body.company_code);
    if (!company) return res.status(400).json({ error: 'Valid company_code is required' });
  }

  // Server-side anti-mock-location check — this used to only run in the browser's own JS,
  // which anyone could skip entirely by calling this endpoint directly (e.g. from a script or
  // a modified copy of the app). Re-checking here closes that gap: it's now enforced no matter
  // what client is talking to the API. Mirrors the same reasoning as the frontend check —
  // accuracy === 0/missing essentially never happens on a real GPS/network fix.
  const lat = Number(latitude);
  const lng = Number(longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || (lat === 0 && lng === 0)) {
    return res.status(400).json({ error: 'Location looks invalid. Please check GPS is on and try again.' });
  }
  // Loose India bounding box — generous enough to never block a real employee inside the
  // country, but still catches garbage/placeholder coordinates a spoofing tool might send.
  if (lat < 6 || lat > 38 || lng < 68 || lng > 98) {
    return res.status(400).json({ error: 'Location is outside the expected service area. Please check GPS and try again.' });
  }
  if (accuracy === undefined || accuracy === null || Number(accuracy) === 0) {
    return res.status(400).json({ error: 'Location looks artificial (no GPS accuracy reported). Please disable mock location / location simulation and try again.' });
  }

  const empResult = await pool.query(
    'SELECT * FROM employees WHERE employee_id = $1 AND company_id = $2',
    [employee_id.trim(), company.id]
  );
  const emp = empResult.rows[0];
  if (!emp) return res.status(404).json({ error: 'Employee ID not found. Contact admin.' });
  if (!emp.active) return res.status(403).json({ error: 'Your Employee ID is deactivated. Contact admin.' });

  const attendance_date = todayDateStr();

  // only one punch-in and one punch-out per employee per day — stops duplicate/spam punches
  const todaysResult = await pool.query(
    'SELECT status FROM attendance WHERE employee_id = $1 AND company_id = $2 AND attendance_date = $3',
    [employee_id.trim(), company.id, attendance_date]
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
  const photoUrl = savePhotoAndGetUrl(`${company.id}_${employee_id.trim()}`, photo);

  await pool.query(
    `INSERT INTO attendance
      (employee_id, status, photo, latitude, longitude, address, device_time, attendance_date, company_id)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [employee_id.trim(), status, photoUrl, latitude, longitude, address || '', device_time || '', attendance_date, company.id]
  );

  // Start/stop live location tracking exactly in step with on/off duty — on_duty seeds the
  // "current position" with the punch-in point itself (so a search right after punch-in
  // isn't empty even before the first ping arrives); off_duty clears it so an employee who's
  // gone home never shows up in a "who's nearby" search.
  if (status === 'on_duty') {
    await pool.query(
      'UPDATE employees SET live_latitude = $1, live_longitude = $2, live_last_ping_at = NOW() WHERE employee_id = $3 AND company_id = $4',
      [lat, lng, employee_id.trim(), company.id]
    );
  } else {
    await pool.query(
      'UPDATE employees SET live_latitude = NULL, live_longitude = NULL, live_last_ping_at = NULL WHERE employee_id = $1 AND company_id = $2',
      [employee_id.trim(), company.id]
    );
  }

  res.json({ message: `${status.replace('_', ' ')} recorded successfully`, date: attendance_date });
});

// ---------------------------------------------------------------------------------------
// LIVE LOCATION TRACKING — the employee's app calls this repeatedly (e.g. every 1-2 minutes)
// for as long as they're on_duty. Rejected if they're not currently on_duty, so a stale app
// left open after punch-out (or before punch-in) can't keep reporting a position.
// ---------------------------------------------------------------------------------------
// POST /api/attendance/location-ping  body: { latitude, longitude, employee_id?, company_code? }
router.post('/location-ping', optionalAuth, async (req, res) => {
  const isEmployeeToken = req.user && req.user.role === 'employee';
  const employee_id = isEmployeeToken ? req.user.employee_id : req.body.employee_id;
  const { latitude, longitude } = req.body;

  if (!employee_id || latitude === undefined || longitude === undefined) {
    return res.status(400).json({ error: 'employee_id, latitude, longitude are required' });
  }
  const lat = Number(latitude), lng = Number(longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return res.status(400).json({ error: 'Invalid coordinates' });
  }

  let companyId;
  if (isEmployeeToken) {
    companyId = req.user.company_id;
  } else {
    const company = await resolveCompanyFromCode(req.body.company_code);
    if (!company) return res.status(400).json({ error: 'Valid company_code is required' });
    companyId = company.id;
  }

  const { rows } = await pool.query(
    'SELECT status FROM attendance WHERE employee_id = $1 AND company_id = $2 AND attendance_date = $3 ORDER BY server_time DESC LIMIT 1',
    [employee_id.trim(), companyId, todayDateStr()]
  );
  if (!rows[0] || rows[0].status !== 'on_duty') {
    return res.status(409).json({ error: 'You must be punched in (on duty) for location tracking to run' });
  }

  await pool.query(
    'UPDATE employees SET live_latitude = $1, live_longitude = $2, live_last_ping_at = NOW() WHERE employee_id = $3 AND company_id = $4',
    [lat, lng, employee_id.trim(), companyId]
  );
  await pool.query(
    'INSERT INTO location_pings (company_id, employee_id, latitude, longitude) VALUES ($1, $2, $3, $4)',
    [companyId, employee_id.trim(), lat, lng]
  );
  res.json({ message: 'ok' });
});

function haversineKm(lat1, lng1, lat2, lng2) {
  const toRad = d => (d * Math.PI) / 180;
  const R = 6371;
  const dLat = toRad(lat2 - lat1), dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ---------------------------------------------------------------------------------------
// NEARBY SEARCH — "who's currently on-duty near this point/site" — the actual feature request:
// site-wise search of who's nearby, using each on-duty employee's LIVE (real-time) position.
// ---------------------------------------------------------------------------------------
// GET /api/attendance/nearby?lat=&lng=&radius_km=10
router.get('/nearby', verifyAdminOrManager, async (req, res) => {
  const lat = Number(req.query.lat), lng = Number(req.query.lng);
  const radiusKm = Number(req.query.radius_km) || 10;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return res.status(400).json({ error: 'lat and lng are required' });

  const projects = await effectiveProjects(req, pool);
  let query = `SELECT employee_id, name, project, designation, phone, live_latitude, live_longitude, live_last_ping_at
               FROM employees WHERE company_id = $1 AND live_latitude IS NOT NULL`;
  const params = [req.user.company_id];
  if (projects && projects.length) { params.push(projects); query += ` AND project = ANY($${params.length}::text[])`; }

  const rows = (await pool.query(query, params)).rows;
  const nearby = rows
    .map(e => ({ ...e, distance_km: Math.round(haversineKm(lat, lng, e.live_latitude, e.live_longitude) * 100) / 100 }))
    .filter(e => e.distance_km <= radiusKm)
    .sort((a, b) => a.distance_km - b.distance_km);

  res.json({ count: nearby.length, employees: nearby });
});

// GET /api/attendance/nearby-site/:project?radius_km=10 — same, but centered on a site's own
// saved coordinates (Site Management) instead of an arbitrary point.
router.get('/nearby-site/:project', verifyAdminOrManager, async (req, res) => {
  const { rows: siteRows } = await pool.query('SELECT latitude, longitude FROM projects WHERE company_id = $1 AND name = $2', [req.user.company_id, req.params.project]);
  const site = siteRows[0];
  if (!site || site.latitude == null || site.longitude == null) {
    return res.status(400).json({ error: 'This site has no GPS location set yet — add it under Site Management first.' });
  }
  const lat = Number(site.latitude), lng = Number(site.longitude);
  const radiusKm = Number(req.query.radius_km) || 10;

  const projects = await effectiveProjects(req, pool);
  let query = `SELECT employee_id, name, project, designation, phone, live_latitude, live_longitude, live_last_ping_at
               FROM employees WHERE company_id = $1 AND live_latitude IS NOT NULL`;
  const params = [req.user.company_id];
  if (projects && projects.length) { params.push(projects); query += ` AND project = ANY($${params.length}::text[])`; }

  const rows = (await pool.query(query, params)).rows;
  const nearby = rows
    .map(e => ({ ...e, distance_km: Math.round(haversineKm(lat, lng, e.live_latitude, e.live_longitude) * 100) / 100 }))
    .filter(e => e.distance_km <= radiusKm)
    .sort((a, b) => a.distance_km - b.distance_km);

  res.json({ count: nearby.length, site_lat: lat, site_lng: lng, employees: nearby });
});

// GET /api/attendance/today/:employeeId?company_code=XXXX -> app/web checks current status for today
router.get('/today/:employeeId', optionalAuth, async (req, res) => {
  let companyId;
  if (req.user && req.user.role === 'employee') {
    companyId = req.user.company_id;
  } else {
    const company = await resolveCompanyFromCode(req.query.company_code);
    if (!company) return res.status(400).json({ error: 'Valid company_code is required' });
    companyId = company.id;
  }

  const { rows } = await pool.query(
    `SELECT status, server_time, photo, attendance_date, address, latitude, longitude
     FROM attendance WHERE employee_id = $1 AND company_id = $2 AND attendance_date = $3 ORDER BY server_time ASC`,
    [req.params.employeeId.trim(), companyId, todayDateStr()]
  );
  const last = rows.length ? rows[rows.length - 1] : null;
  res.json({ date: todayDateStr(), records: rows, current_status: last ? last.status : null });
});

// employee only — own attendance history
// GET /api/attendance/my?from=YYYY-MM-DD&to=YYYY-MM-DD
router.get('/my', verifyEmployee, async (req, res) => {
  const { from, to } = req.query;
  const employee_id = req.user.employee_id;

  let query = 'SELECT * FROM attendance WHERE employee_id = $1 AND company_id = $2';
  const params = [employee_id, req.user.company_id];
  if (from) { params.push(from); query += ` AND attendance_date >= $${params.length}`; }
  if (to) { params.push(to); query += ` AND attendance_date <= $${params.length}`; }
  query += ' ORDER BY attendance_date DESC, server_time DESC';

  const { rows } = await pool.query(query, params);
  res.json({ count: rows.length, records: rows });
});

// admin + manager — view everything (own company only)
// GET /api/attendance?from=YYYY-MM-DD&to=YYYY-MM-DD&employee_id=xxx&project=xxx
// (manager/coordinator's own project always wins, ignoring the project param)
router.get('/', verifyAdminOrManager, async (req, res) => {
  // Gates only this records-listing endpoint (the "Attendance Log" tab) — deliberately NOT
  // /summary below, since that one also powers the Overview tab, which is always visible
  // regardless of role_permissions.
  const allowed = await checkRolePermission(pool, req.user.company_id, req.user.role, 'attendance');
  if (!allowed) return res.status(403).json({ error: 'You do not have access to the Attendance Log section.' });

  const { from, to, employee_id } = req.query;
  const projects = await effectiveProjects(req, pool);

  let query = `
    SELECT a.*, e.name as employee_name, e.designation, e.project
    FROM attendance a
    LEFT JOIN employees e ON e.employee_id = a.employee_id AND e.company_id = a.company_id
    WHERE a.company_id = $1`;
  const params = [req.user.company_id];

  if (from) { params.push(from); query += ` AND a.attendance_date >= $${params.length}`; }
  if (to) { params.push(to); query += ` AND a.attendance_date <= $${params.length}`; }
  if (employee_id) { params.push(employee_id); query += ` AND a.employee_id = $${params.length}`; }
  if (projects && projects.length) { params.push(projects); query += ` AND e.project = ANY($${params.length}::text[])`; }

  query += ' ORDER BY a.attendance_date DESC, a.server_time DESC';

  const { rows } = await pool.query(query, params);
  res.json({ count: rows.length, records: rows });
});

// GET /api/attendance/summary?date=YYYY-MM-DD&project=xxx -> latest punch of the day per employee
// (manager/coordinator's own project always wins, ignoring the project param)
router.get('/summary', verifyAdminOrManager, async (req, res) => {
  const date = req.query.date || todayDateStr();
  const projects = await effectiveProjects(req, pool);
  let empQuery = 'SELECT employee_id, name, designation, project FROM employees WHERE active = 1 AND company_id = $1';
  const empParams = [req.user.company_id];
  if (projects && projects.length) { empParams.push(projects); empQuery += ` AND project = ANY($${empParams.length}::text[])`; }
  const empResult = await pool.query(empQuery, empParams);
  const recResult = await pool.query(
    'SELECT * FROM attendance WHERE attendance_date = $1 AND company_id = $2 ORDER BY server_time ASC',
    [date, req.user.company_id]
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
      project: emp.project,
      status: last ? last.status : null, // on_duty | off_duty | null (not marked yet)
      photo: last ? last.photo : null,
      address: last ? last.address : null,
      time: last ? last.server_time : null,
      punch_count: empRecords.length,
    };
  });

  res.json({ date, summary });
});

// GET /api/attendance/grid?from=YYYY-MM-DD&to=YYYY-MM-DD&project=xxx
// Date-wise P/HD/A matrix for the Reports tab.
//   P   = worked full shift hours (per employee's shift category)
//   HD  = worked at least half-shift hours but punched out before completing a full shift
//   A   = only punched IN (never punched OUT), or worked less than half-shift hours, or no punch at all (non-weekly-off day)
//   W/O = no punch, and it's that employee's project's configured weekly-off day
//   L   = employee has an APPROVED leave application covering this date (overrides P/HD/A)
//   -   = date is before the employee's Date of Joining
router.get('/grid', verifyAdminOrManager, async (req, res) => {
  const to = req.query.to || todayDateStr();
  const from = req.query.from || to;
  const projects = await effectiveProjects(req, pool);
  const companyId = req.user.company_id;

  let empQuery = 'SELECT employee_id, name, designation, location, doj, project, shift_category FROM employees WHERE active = 1 AND company_id = $1';
  const empParams = [companyId];
  if (projects && projects.length) { empParams.push(projects); empQuery += ` AND project = ANY($${empParams.length}::text[])`; }
  empQuery += ' ORDER BY employee_id ASC';

  const empResult = await pool.query(empQuery, empParams);
  const attResult = await pool.query(
    'SELECT employee_id, attendance_date, status, server_time FROM attendance WHERE attendance_date >= $1 AND attendance_date <= $2 AND company_id = $3',
    [from, to, companyId]
  );
  const thresholdsMap = await loadShiftThresholdsMap(pool, companyId);
  const weeklyOffMap = await loadWeeklyOffMap(pool, companyId); // { projectName: weekly_off_day (0-6) }
  const leaveMap = await loadApprovedLeaveMap(pool, from, to, companyId); // Set of "employee_id|date" on approved leave

  const employees = empResult.rows;
  const rows = attResult.rows;

  // Group punches by employee+date so we know both the on_duty and off_duty time for that day.
  const punchMap = new Map(); // key: employee_id|date -> { onDutyTime, offDutyTime }
  rows.forEach(r => {
    const key = `${r.employee_id}|${r.attendance_date}`;
    if (!punchMap.has(key)) punchMap.set(key, { onDutyTime: null, offDutyTime: null });
    const entry = punchMap.get(key);
    if (r.status === 'on_duty') entry.onDutyTime = r.server_time;
    else if (r.status === 'off_duty') entry.offDutyTime = r.server_time;
  });

  const dates = [];
  const cur = new Date(from + 'T00:00:00Z');
  const end = new Date(to + 'T00:00:00Z');
  while (cur <= end) {
    dates.push(cur.toISOString().slice(0, 10));
    cur.setUTCDate(cur.getUTCDate() + 1);
  }

  const grid = employees.map(emp => {
    const days = {};
    const offDay = weeklyOffMap[emp.project] ?? 0; // defaults to Sunday if the employee has no project set
    dates.forEach(d => {
      const joined = !(emp.doj && d < emp.doj);
      const punch = punchMap.get(`${emp.employee_id}|${d}`) || { onDutyTime: null, offDutyTime: null };
      const isWeeklyOff = new Date(d + 'T00:00:00Z').getUTCDay() === offDay;
      days[d] = computeDayStatus({
        onDutyTime: punch.onDutyTime,
        offDutyTime: punch.offDutyTime,
        shiftCategory: emp.shift_category,
        isWeeklyOff,
        joined,
        thresholdsMap,
        isOnApprovedLeave: leaveMap.has(`${emp.employee_id}|${d}`),
      });
    });
    return { ...emp, days };
  });

  res.json({ from, to, dates, employees: grid });
});

module.exports = router;
