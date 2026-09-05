const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { verifyAdminOrManager, verifyEmployee, optionalAuth } = require('../middleware');
const { savePhotoAndGetUrl } = require('../photoStorage');
const { computeDayStatus, loadShiftThresholdsMap, loadWeeklyOffMap, loadApprovedLeaveMap } = require('../attendanceStatus');
const { effectiveProjects } = require('../projectScope');
const { validateCompanyCode } = require('../policy');
const { checkRolePermission } = require('../companySettings');
const { checkImpossibleTravel } = require('../gpsAnomalyDetection');
const { emitToCompany } = require('../realtime');

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

// Core punch-processing logic, shared by the single-punch route below AND the batch-sync
// route (for the Android app's offline queue) — extracted so both stay in perfect sync
// with the same geofence/anomaly/duplicate-punch rules instead of two copies drifting
// apart over time. Returns { httpStatus, body } instead of writing to `res` directly, so
// the batch route can loop over many of these without needing a fake response object.
async function runPunch({ employeeId, status, photo, latitude, longitude, accuracy, address, deviceTime, companyId }) {
  if (!employeeId || !status || latitude === undefined || longitude === undefined) {
    return { httpStatus: 400, body: { error: 'employee_id, status, latitude, longitude are required' } };
  }
  if (!['on_duty', 'off_duty'].includes(status)) {
    return { httpStatus: 400, body: { error: "status must be 'on_duty' or 'off_duty'" } };
  }
  if (!photo) {
    return { httpStatus: 400, body: { error: 'Selfie photo is required to mark attendance' } };
  }

  const lat = Number(latitude);
  const lng = Number(longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || (lat === 0 && lng === 0)) {
    return { httpStatus: 400, body: { error: 'Location looks invalid. Please check GPS is on and try again.' } };
  }
  if (lat < 6 || lat > 38 || lng < 68 || lng > 98) {
    return { httpStatus: 400, body: { error: 'Location is outside the expected service area. Please check GPS and try again.' } };
  }
  if (accuracy === undefined || accuracy === null || Number(accuracy) === 0) {
    return { httpStatus: 400, body: { error: 'Location looks artificial (no GPS accuracy reported). Please disable mock location / location simulation and try again.' } };
  }

  const empResult = await pool.query(
    'SELECT * FROM employees WHERE employee_id = $1 AND company_id = $2',
    [employeeId.trim(), companyId]
  );
  const emp = empResult.rows[0];
  if (!emp) return { httpStatus: 404, body: { error: 'Employee ID not found. Contact admin.' } };
  if (!emp.active) return { httpStatus: 403, body: { error: 'Your Employee ID is deactivated. Contact admin.' } };

  let geofenceSite = null;
  if (emp.site_location_id) {
    const { rows } = await pool.query(
      'SELECT name, latitude, longitude, radius_m AS geofence_radius_m FROM site_locations WHERE id = $1 AND company_id = $2',
      [emp.site_location_id, companyId]
    );
    geofenceSite = rows[0] ? { ...rows[0], label: rows[0].name } : null;
  }
  if (!geofenceSite && emp.project) {
    const { rows } = await pool.query(
      'SELECT latitude, longitude, geofence_radius_m FROM projects WHERE company_id = $1 AND name = $2',
      [companyId, emp.project]
    );
    geofenceSite = rows[0] ? { ...rows[0], label: emp.project } : null;
  }
  if (geofenceSite && geofenceSite.latitude != null && geofenceSite.longitude != null) {
    const distanceM = haversineKm(lat, lng, Number(geofenceSite.latitude), Number(geofenceSite.longitude)) * 1000;
    const radiusM = Number(geofenceSite.geofence_radius_m) || 200;
    if (distanceM > radiusM) {
      return {
        httpStatus: 403,
        body: { error: `You are ${Math.round(distanceM)}m away from ${geofenceSite.label} — you must be within ${radiusM}m of the site to ${status === 'on_duty' ? 'punch in' : 'punch out'}.` },
      };
    }
  }

  const anomaly = await checkImpossibleTravel(employeeId.trim(), companyId, lat, lng);
  if (anomaly.anomalous) {
    return {
      httpStatus: 409,
      body: { error: `This location implies you travelled ${Math.round(anomaly.distanceKm)}km in ${Math.round((anomaly.distanceKm / anomaly.speedKmh) * 60)} min (~${Math.round(anomaly.speedKmh)} km/h) — that's flagged as impossible. If this is a genuine GPS glitch, please retry in a moment; repeated failures should be reported to your admin.` },
    };
  }

  const attendance_date = todayDateStr();

  const todaysResult = await pool.query(
    'SELECT status FROM attendance WHERE employee_id = $1 AND company_id = $2 AND attendance_date = $3',
    [employeeId.trim(), companyId, attendance_date]
  );
  const todaysRecords = todaysResult.rows;
  const alreadyOnDuty = todaysRecords.some(r => r.status === 'on_duty');
  const alreadyOffDuty = todaysRecords.some(r => r.status === 'off_duty');

  if (status === 'on_duty' && alreadyOnDuty) {
    return { httpStatus: 409, body: { error: 'Invalid: You have already Punched In today. Only one Punch In per day is allowed.' } };
  }
  if (status === 'off_duty') {
    if (!alreadyOnDuty) {
      return { httpStatus: 409, body: { error: 'Invalid: You must Punch In before you can Punch Out.' } };
    }
    if (alreadyOffDuty) {
      return { httpStatus: 409, body: { error: 'Invalid: You have already Punched Out today. Only one Punch Out per day is allowed.' } };
    }
  }

  const photoUrl = savePhotoAndGetUrl(`${companyId}_${employeeId.trim()}`, photo);

  await pool.query(
    `INSERT INTO attendance
      (employee_id, status, photo, latitude, longitude, address, device_time, attendance_date, company_id)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [employeeId.trim(), status, photoUrl, latitude, longitude, address || '', deviceTime || '', attendance_date, companyId]
  );

  if (status === 'on_duty') {
    await pool.query(
      'UPDATE employees SET live_latitude = $1, live_longitude = $2, live_last_ping_at = NOW() WHERE employee_id = $3 AND company_id = $4',
      [lat, lng, employeeId.trim(), companyId]
    );
  } else {
    await pool.query(
      'UPDATE employees SET live_latitude = NULL, live_longitude = NULL, live_last_ping_at = NULL WHERE employee_id = $1 AND company_id = $2',
      [employeeId.trim(), companyId]
    );
  }

  // Real-time push — the Employee Tracking live map (app.js loadTrackingMap, currently a 30s
  // poll) and the Overview on-duty/off-duty counters update instantly for every connected
  // admin/manager instead of waiting for their next poll tick.
  emitToCompany(companyId, 'tracking:update', {
    employee_id: employeeId.trim(), status,
    latitude: status === 'on_duty' ? lat : null,
    longitude: status === 'on_duty' ? lng : null,
  });

  return { httpStatus: 200, body: { message: `${status.replace('_', ' ')} recorded successfully`, date: attendance_date } };
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

  let company;
  if (isEmployeeToken) {
    company = { id: req.user.company_id };
  } else {
    company = await resolveCompanyFromCode(req.body.company_code);
    if (!company) return res.status(400).json({ error: 'Valid company_code is required' });
  }

  const result = await runPunch({
    employeeId: employee_id, status, photo, latitude, longitude, accuracy, address,
    deviceTime: device_time, companyId: company.id,
  });
  res.status(result.httpStatus).json(result.body);
});

// ---------------------------------------------------------------------------------------
// BATCH PUNCH SYNC — the Android app queues punches locally (Room DB) when it can't reach
// the server (no signal, etc.) and retries them once connectivity returns. Previously it
// retried each queued punch as a separate POST /punch call; this lets it send the whole
// backlog in one request instead, which matters when someone reconnects after being
// offline all day with several queued punches (rare, but a bad connection on a large site
// makes it real) — one round trip instead of N.
// POST /api/attendance/punch/batch  body: { punches: [ {status, photo, latitude, ...}, ... ] }
// ---------------------------------------------------------------------------------------
router.post('/punch/batch', optionalAuth, async (req, res) => {
  const { punches } = req.body;
  if (!Array.isArray(punches) || !punches.length) {
    return res.status(400).json({ error: 'punches must be a non-empty array' });
  }
  if (punches.length > 50) {
    return res.status(400).json({ error: 'Too many punches in one batch (max 50) — this usually indicates a client-side bug rather than a real backlog.' });
  }

  const isEmployeeToken = req.user && req.user.role === 'employee';
  let companyId;
  if (isEmployeeToken) {
    companyId = req.user.company_id;
  } else {
    const company = await resolveCompanyFromCode(req.body.company_code);
    if (!company) return res.status(400).json({ error: 'Valid company_code is required' });
    companyId = company.id;
  }

  // Processed strictly in order (not Promise.all) — each punch's duplicate-check and
  // impossible-travel check depends on the state left behind by the previous one, so
  // running them concurrently could let two punches race past the same "already
  // punched in today" check.
  const results = [];
  for (const p of punches) {
    const employeeId = isEmployeeToken ? req.user.employee_id : p.employee_id;
    try {
      const result = await runPunch({
        employeeId, status: p.status, photo: p.photo, latitude: p.latitude, longitude: p.longitude,
        accuracy: p.accuracy, address: p.address, deviceTime: p.device_time, companyId,
      });
      results.push({ client_id: p.client_id ?? null, ok: result.httpStatus === 200, httpStatus: result.httpStatus, ...result.body });
    } catch (err) {
      results.push({ client_id: p.client_id ?? null, ok: false, httpStatus: 500, error: 'Unexpected server error processing this punch' });
    }
  }

  res.json({ results });
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
  const { latitude, longitude, battery_percent, is_charging } = req.body;

  if (!employee_id || latitude === undefined || longitude === undefined) {
    return res.status(400).json({ error: 'employee_id, latitude, longitude are required' });
  }
  const lat = Number(latitude), lng = Number(longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return res.status(400).json({ error: 'Invalid coordinates' });
  }
  // battery_percent is optional (only the native Android app sends it — the web
  // build has no reliable browser API for this) and clamped defensively.
  const battery = Number.isFinite(Number(battery_percent)) ? Math.max(0, Math.min(100, Math.round(Number(battery_percent)))) : null;
  const charging = typeof is_charging === 'boolean' ? is_charging : null;

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

  // Must run BEFORE overwriting live_latitude/live_longitude below — it compares this
  // new point against whatever is still stored as the "previous" position.
  const anomaly = await checkImpossibleTravel(employee_id.trim(), companyId, lat, lng);

  await pool.query(
    'UPDATE employees SET live_latitude = $1, live_longitude = $2, live_last_ping_at = NOW(), live_battery_percent = $5, live_is_charging = $6 WHERE employee_id = $3 AND company_id = $4',
    [lat, lng, employee_id.trim(), companyId, battery, charging]
  );
  await pool.query(
    'INSERT INTO location_pings (company_id, employee_id, latitude, longitude) VALUES ($1, $2, $3, $4)',
    [companyId, employee_id.trim(), lat, lng]
  );
  emitToCompany(companyId, 'tracking:update', {
    employee_id: employee_id.trim(), status: 'on_duty', latitude: lat, longitude: lng,
    battery_percent: battery, is_charging: charging,
  });
  res.json({ message: 'ok', anomaly: anomaly.anomalous || false });
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
// GET /api/attendance/tracking-map — everything the Employee Tracking live map needs in one
// call: every on-duty employee with a live GPS position, plus every site that has its own
// GPS + geofence saved (Site Management), so the map can draw both pins and geofence circles.
router.get('/tracking-map', verifyAdminOrManager, async (req, res) => {
  const projects = await effectiveProjects(req, pool);
  const companyId = req.user.company_id;

  let empQuery = `SELECT employee_id, name, project, designation, live_latitude, live_longitude, live_last_ping_at,
                          live_battery_percent, live_is_charging
                   FROM employees WHERE company_id = $1 AND live_latitude IS NOT NULL`;
  const empParams = [companyId];
  if (projects && projects.length) { empParams.push(projects); empQuery += ` AND project = ANY($${empParams.length}::text[])`; }
  const employees = (await pool.query(empQuery, empParams)).rows;

  let siteQuery = `SELECT id, name, client, latitude, longitude, geofence_radius_m FROM projects
                    WHERE company_id = $1 AND latitude IS NOT NULL AND longitude IS NOT NULL`;
  const siteParams = [companyId];
  if (projects && projects.length) { siteParams.push(projects); siteQuery += ` AND name = ANY($${siteParams.length}::text[])`; }
  const sites = (await pool.query(siteQuery, siteParams)).rows;

  res.json({ employees, sites });
});

// ---------------------------------------------------------------------------------------
// TRACKING HISTORY — the full route an employee walked on a given day, from punch-in to
// punch-out. Reconstructed from location_pings (already recorded every ~60-90s by the
// Android app's background service while on duty) — previously this data was only ever
// used for the LIVE map; nothing ever queried it back out as a per-day history/route.
//
// Returns two things the admin map draws:
//   - `path`: every raw ping, in order — used to draw the connecting route line.
//   - `stops`: consecutive pings clustered by proximity (<70m) into a single "stop" once
//     the employee stayed within that radius for 3+ minutes — this is what answers
//     "when did they arrive here, when did they leave, how long did they stay", so a
//     right-click anywhere on the route can show that instead of just a raw timestamp.
// ---------------------------------------------------------------------------------------
const STOP_RADIUS_M = 70;
const STOP_MIN_MINUTES = 3;

function detectStops(pings) {
  if (!pings.length) return [];
  const stops = [];
  let cluster = [pings[0]];

  const flush = () => {
    if (cluster.length < 2) return; // need at least 2 pings to know a duration
    const first = cluster[0], last = cluster[cluster.length - 1];
    const durationMinutes = (new Date(last.recorded_at) - new Date(first.recorded_at)) / 60000;
    if (durationMinutes < STOP_MIN_MINUTES) return; // just passing through, not a real stop
    const avgLat = cluster.reduce((s, p) => s + Number(p.latitude), 0) / cluster.length;
    const avgLng = cluster.reduce((s, p) => s + Number(p.longitude), 0) / cluster.length;
    stops.push({
      latitude: avgLat, longitude: avgLng,
      arrived_at: first.recorded_at, left_at: last.recorded_at,
      duration_minutes: Math.round(durationMinutes),
    });
  };

  for (let i = 1; i < pings.length; i++) {
    const p = pings[i];
    const refLat = Number(cluster[0].latitude), refLng = Number(cluster[0].longitude);
    const distM = haversineKm(refLat, refLng, Number(p.latitude), Number(p.longitude)) * 1000;
    if (distM <= STOP_RADIUS_M) {
      cluster.push(p);
    } else {
      flush();
      cluster = [p];
    }
  }
  flush();
  // Mark the last stop as "still here" if it runs right up to the most recent ping and the
  // employee has no punch-out yet — handled by the caller, which knows the punch status.
  return stops;
}

// GET /api/attendance/tracking-history?employee_id=E123&date=2026-08-25
router.get('/tracking-history', verifyAdminOrManager, async (req, res) => {
  const employeeId = (req.query.employee_id || '').trim();
  const date = req.query.date || todayDateStr();
  if (!employeeId) return res.status(400).json({ error: 'employee_id is required' });

  const { rows: empRows } = await pool.query(
    'SELECT employee_id, name, project FROM employees WHERE employee_id = $1 AND company_id = $2',
    [employeeId, req.user.company_id]
  );
  if (!empRows[0]) return res.status(404).json({ error: 'Employee not found' });

  const { rows: shiftRows } = await pool.query(
    `SELECT status, server_time FROM attendance
     WHERE employee_id = $1 AND company_id = $2 AND attendance_date = $3 ORDER BY server_time ASC`,
    [employeeId, req.user.company_id, date]
  );
  const punchIn = shiftRows.find(r => r.status === 'on_duty') || null;
  const punchOut = [...shiftRows].reverse().find(r => r.status === 'off_duty') || null;

  const { rows: pings } = await pool.query(
    `SELECT latitude, longitude, recorded_at FROM location_pings
     WHERE employee_id = $1 AND company_id = $2 AND recorded_at::date = $3
     ORDER BY recorded_at ASC`,
    [employeeId, req.user.company_id, date]
  );

  const stops = detectStops(pings);
  if (stops.length && !punchOut) {
    stops[stops.length - 1].still_here = true;
  }

  res.json({
    employee: empRows[0],
    date,
    shift: { punch_in: punchIn?.server_time || null, punch_out: punchOut?.server_time || null },
    path: pings,
    stops,
  });
});

// GET /api/attendance/my/route-history?date=2026-08-25 — same reconstruction as the admin
// endpoint above (route line + detected stops), but scoped to the logged-in employee's
// OWN day — "where did I go today" self-view in the Android app. No employee_id param
// needed/accepted; always the token holder's own data.
router.get('/my/route-history', verifyEmployee, async (req, res) => {
  const date = req.query.date || todayDateStr();

  const { rows: shiftRows } = await pool.query(
    `SELECT status, server_time FROM attendance
     WHERE employee_id = $1 AND company_id = $2 AND attendance_date = $3 ORDER BY server_time ASC`,
    [req.user.employee_id, req.user.company_id, date]
  );
  const punchIn = shiftRows.find(r => r.status === 'on_duty') || null;
  const punchOut = [...shiftRows].reverse().find(r => r.status === 'off_duty') || null;

  const { rows: pings } = await pool.query(
    `SELECT latitude, longitude, recorded_at FROM location_pings
     WHERE employee_id = $1 AND company_id = $2 AND recorded_at::date = $3
     ORDER BY recorded_at ASC`,
    [req.user.employee_id, req.user.company_id, date]
  );

  const stops = detectStops(pings);
  if (stops.length && !punchOut) {
    stops[stops.length - 1].still_here = true;
  }

  res.json({
    date,
    shift: { punch_in: punchIn?.server_time || null, punch_out: punchOut?.server_time || null },
    path: pings,
    stops,
  });
});

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

// employee — own day-by-day status (P / HD / A / W/O / L) for a date range, for the app's
// calendar view. Reuses the exact same computeDayStatus logic as the admin grid/reports so
// the colors an employee sees always match what the admin sees for the same day.
// GET /api/attendance/my/day-status?from=YYYY-MM-DD&to=YYYY-MM-DD
router.get('/my/day-status', verifyEmployee, async (req, res) => {
  const to = req.query.to || todayDateStr();
  const from = req.query.from || to;
  const companyId = req.user.company_id;
  const employeeId = req.user.employee_id;

  const empResult = await pool.query(
    'SELECT employee_id, doj, project, shift_category FROM employees WHERE employee_id = $1 AND company_id = $2',
    [employeeId, companyId]
  );
  const emp = empResult.rows[0];
  if (!emp) return res.status(404).json({ error: 'Employee not found' });

  const attResult = await pool.query(
    'SELECT attendance_date, status, server_time FROM attendance WHERE employee_id = $1 AND company_id = $2 AND attendance_date >= $3 AND attendance_date <= $4',
    [employeeId, companyId, from, to]
  );
  const thresholdsMap = await loadShiftThresholdsMap(pool, companyId);
  const weeklyOffMap = await loadWeeklyOffMap(pool, companyId);
  const leaveMap = await loadApprovedLeaveMap(pool, from, to, companyId);

  const punchMap = new Map(); // date -> { onDutyTime, offDutyTime }
  attResult.rows.forEach(r => {
    if (!punchMap.has(r.attendance_date)) punchMap.set(r.attendance_date, { onDutyTime: null, offDutyTime: null });
    const entry = punchMap.get(r.attendance_date);
    if (r.status === 'on_duty') entry.onDutyTime = r.server_time;
    else if (r.status === 'off_duty') entry.offDutyTime = r.server_time;
  });

  const offDay = weeklyOffMap[emp.project] ?? 0;
  const dates = [];
  const cur = new Date(from + 'T00:00:00Z');
  const end = new Date(to + 'T00:00:00Z');
  while (cur <= end) { dates.push(cur.toISOString().slice(0, 10)); cur.setUTCDate(cur.getUTCDate() + 1); }

  const statuses = {};
  dates.forEach(d => {
    const joined = !(emp.doj && d < emp.doj);
    const punch = punchMap.get(d) || { onDutyTime: null, offDutyTime: null };
    const isWeeklyOff = new Date(d + 'T00:00:00Z').getUTCDay() === offDay;
    statuses[d] = computeDayStatus({
      onDutyTime: punch.onDutyTime,
      offDutyTime: punch.offDutyTime,
      shiftCategory: emp.shift_category,
      isWeeklyOff,
      joined,
      thresholdsMap,
      isOnApprovedLeave: leaveMap.has(`${employeeId}|${d}`),
    });
  });

  res.json({ from, to, statuses });
});

// GET /api/attendance/anomalies — flagged impossible-travel-speed GPS events, for
// admins/managers to review (e.g. spot a device repeatedly using a spoofed location).
router.get('/anomalies', verifyAdminOrManager, async (req, res) => {
  const { reviewed } = req.query;
  let query = `SELECT a.*, e.name AS employee_name, e.project FROM gps_anomaly_flags a
               LEFT JOIN employees e ON e.employee_id = a.employee_id AND e.company_id = a.company_id
               WHERE a.company_id = $1`;
  const params = [req.user.company_id];
  if (reviewed === 'true' || reviewed === 'false') {
    query += ` AND a.reviewed = $2`;
    params.push(reviewed === 'true');
  }
  query += ' ORDER BY a.created_at DESC LIMIT 200';
  const { rows } = await pool.query(query, params);
  res.json({ anomalies: rows });
});

router.put('/anomalies/:id/mark-reviewed', verifyAdminOrManager, async (req, res) => {
  await pool.query(
    'UPDATE gps_anomaly_flags SET reviewed = TRUE WHERE id = $1 AND company_id = $2',
    [req.params.id, req.user.company_id]
  );
  res.json({ message: 'ok' });
});

module.exports = router;
// Exposed only so the Jest suite can exercise the punch/geofence/anomaly decision logic
// directly (tests/attendance.test.js) without needing to reconstruct a full HTTP+auth
// round trip for every edge case — the router itself is still the real export everywhere else.
module.exports.__runPunchForTests = runPunch;
