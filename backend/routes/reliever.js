const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { verifyAdminOrManager, verifyEmployee } = require('../middleware');
const { effectiveProjects } = require('../projectScope');
const { getCompanySettings, checkRolePermission } = require('../companySettings');
const { rankWithPython } = require('../mlRankerBridge');
const { logAction } = require('../auditLog');

function isValidDate(d) {
  return /^\d{4}-\d{2}-\d{2}$/.test(d);
}
function todayDateStr() {
  return new Date().toISOString().slice(0, 10);
}

// ---- admin/manager/coordinator: assign a reliever to cover another employee's duty ----
// POST /api/reliever/assign  body: { original_employee_id, reliever_employee_id, duty_date, reason? }
router.post('/assign', verifyAdminOrManager, async (req, res) => {
  const settings = await getCompanySettings(pool, req.user.company_id);
  if (!settings.features.reliever) {
    return res.status(403).json({ error: 'Reliever assignment is not enabled for your company. Contact your admin.' });
  }
  const allowed = await checkRolePermission(pool, req.user.company_id, req.user.role, 'reliever');
  if (!allowed) return res.status(403).json({ error: 'You do not have access to Reliever Assignment.' });

  const original_employee_id = (req.body.original_employee_id || '').trim();
  const reliever_employee_id = (req.body.reliever_employee_id || '').trim();
  const duty_date = (req.body.duty_date || '').trim();
  const reason = (req.body.reason || '').trim();
  // force: true -> a senior (admin/manager/coordinator) directly places the reliever on
  // duty without waiting for their accept/reject — skips straight to 'accepted'. Still fully
  // audit-logged (who forced it), and still visible to the reliever on their own dashboard —
  // it's just not blocking on their confirmation first.
  const force = req.body.force === true;

  if (!original_employee_id || !reliever_employee_id || !isValidDate(duty_date)) {
    return res.status(400).json({ error: 'original_employee_id, reliever_employee_id and duty_date (YYYY-MM-DD) are required' });
  }
  if (original_employee_id === reliever_employee_id) {
    return res.status(400).json({ error: 'Reliever must be a different employee' });
  }

  const companyId = req.user.company_id;
  const { rows } = await pool.query(
    `SELECT employee_id, name, project, active FROM employees WHERE company_id = $1 AND employee_id = ANY($2::text[])`,
    [companyId, [original_employee_id, reliever_employee_id]]
  );
  const original = rows.find(r => r.employee_id === original_employee_id);
  const reliever = rows.find(r => r.employee_id === reliever_employee_id);
  if (!original) return res.status(404).json({ error: 'Original employee not found' });
  if (!reliever) return res.status(404).json({ error: 'Reliever employee not found' });
  if (!reliever.active) return res.status(400).json({ error: 'Reliever employee is deactivated' });

  // Managers/coordinators are locked to their own project(s) — same guard used across
  // leave/grievance/salary routes.
  const projects = await effectiveProjects(req, pool);
  if (projects && projects.length && !projects.includes(original.project)) {
    return res.status(403).json({ error: 'This employee is not in your project' });
  }

  const status = force ? 'accepted' : 'assigned';
  const { rows: inserted } = await pool.query(
    `INSERT INTO reliever_assignments
       (company_id, original_employee_id, reliever_employee_id, project, duty_date, reason, status, assigned_by, responded_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, ${force ? 'NOW()' : 'NULL'})
     RETURNING id`,
    [companyId, original_employee_id, reliever_employee_id, original.project || '', duty_date, reason || null,
      status, req.user.username || req.user.name || req.user.role]
  );

  await logAction(req, force ? 'reliever_force_assigned' : 'reliever_assigned', {
    targetType: 'reliever_assignment', targetId: inserted[0].id,
    targetLabel: `${reliever_employee_id} covering ${original_employee_id} on ${duty_date}${force ? ' (forced)' : ''}`,
  });

  res.json({
    message: force ? 'Reliever force-assigned and placed on duty.' : 'Reliever assigned. Awaiting their accept/reject.',
    id: inserted[0].id,
  });
});

// ---- admin/manager/coordinator: list assignments (own project scope, own company) ----
// GET /api/reliever/assignments?status=&from=&to=
router.get('/assignments', verifyAdminOrManager, async (req, res) => {
  const projects = await effectiveProjects(req, pool);
  const params = [req.user.company_id];
  const conditions = ['a.company_id = $1'];

  if (projects && projects.length) {
    params.push(projects);
    conditions.push(`a.project = ANY($${params.length}::text[])`);
  }
  if (req.query.status) { params.push(req.query.status); conditions.push(`a.status = $${params.length}`); }
  if (req.query.from) { params.push(req.query.from); conditions.push(`a.duty_date >= $${params.length}`); }
  if (req.query.to) { params.push(req.query.to); conditions.push(`a.duty_date <= $${params.length}`); }

  const { rows } = await pool.query(
    `SELECT a.*, orig.name AS original_name, rel.name AS reliever_name
     FROM reliever_assignments a
     LEFT JOIN employees orig ON orig.employee_id = a.original_employee_id AND orig.company_id = a.company_id
     LEFT JOIN employees rel ON rel.employee_id = a.reliever_employee_id AND rel.company_id = a.company_id
     WHERE ${conditions.join(' AND ')}
     ORDER BY a.duty_date DESC, a.id DESC`,
    params
  );
  res.json({ count: rows.length, assignments: rows });
});

// ---- admin/manager/coordinator: cancel an assignment ----
router.put('/assignments/:id/cancel', verifyAdminOrManager, async (req, res) => {
  const { rows } = await pool.query(
    'SELECT * FROM reliever_assignments WHERE id = $1 AND company_id = $2',
    [req.params.id, req.user.company_id]
  );
  const assignment = rows[0];
  if (!assignment) return res.status(404).json({ error: 'Assignment not found' });

  const projects = await effectiveProjects(req, pool);
  if (projects && projects.length && !projects.includes(assignment.project)) {
    return res.status(403).json({ error: 'This assignment is not in your project' });
  }

  await pool.query("UPDATE reliever_assignments SET status = 'cancelled' WHERE id = $1 AND company_id = $2",
    [req.params.id, req.user.company_id]);
  res.json({ message: 'Assignment cancelled' });
});

// ---- employee (self) — assignments where THEY are the reliever, incl. pending ones to act on ----
// GET /api/reliever/my/assignments
router.get('/my/assignments', verifyEmployee, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT a.*, orig.name AS original_name
     FROM reliever_assignments a
     LEFT JOIN employees orig ON orig.employee_id = a.original_employee_id AND orig.company_id = a.company_id
     WHERE a.reliever_employee_id = $1 AND a.company_id = $2
     ORDER BY a.duty_date DESC, a.id DESC`,
    [req.user.employee_id, req.user.company_id]
  );
  res.json({ assignments: rows });
});

// ---- employee (self) — accept/reject a reliever assignment made TO them ----
async function respond(req, res, newStatus) {
  const { rows } = await pool.query(
    'SELECT * FROM reliever_assignments WHERE id = $1 AND company_id = $2',
    [req.params.id, req.user.company_id]
  );
  const assignment = rows[0];
  if (!assignment) return res.status(404).json({ error: 'Assignment not found' });
  if (assignment.reliever_employee_id !== req.user.employee_id) {
    return res.status(403).json({ error: 'This assignment is not addressed to you' });
  }
  if (assignment.status !== 'assigned') {
    return res.status(400).json({ error: `This assignment is already ${assignment.status}` });
  }

  await pool.query(
    'UPDATE reliever_assignments SET status = $1, responded_at = NOW() WHERE id = $2 AND company_id = $3',
    [newStatus, req.params.id, req.user.company_id]
  );
  res.json({ message: `Duty ${newStatus}` });
}
router.put('/my/assignments/:id/accept', verifyEmployee, (req, res) => respond(req, res, 'accepted'));
router.put('/my/assignments/:id/reject', verifyEmployee, (req, res) => respond(req, res, 'rejected'));

// ---- admin/manager/coordinator: LIVE dashboard — who's currently on reliever duty, who's
// free/available right now, with each free employee's last known GPS location so a senior
// can pick the nearest one for a new assignment. Meant to be polled every ~20-30s by the
// frontend for a near-real-time view (no websockets — plain polling keeps this simple and
// robust across the Android app + web browser both). ----
// GET /api/reliever/dashboard?date=YYYY-MM-DD (defaults to today)
router.get('/dashboard', verifyAdminOrManager, async (req, res) => {
  const allowed = await checkRolePermission(pool, req.user.company_id, req.user.role, 'reliever');
  if (!allowed) return res.status(403).json({ error: 'You do not have access to Reliever Management.' });

  const date = (req.query.date && isValidDate(req.query.date)) ? req.query.date : todayDateStr();
  const companyId = req.user.company_id;
  const projects = await effectiveProjects(req, pool);

  let empQuery = `SELECT employee_id, name, designation, phone, project, zone, ward, location, shift_category
                   FROM employees WHERE active = 1 AND company_id = $1`;
  const empParams = [companyId];
  if (projects && projects.length) { empParams.push(projects); empQuery += ` AND project = ANY($${empParams.length}::text[])`; }
  empQuery += ' ORDER BY employee_id ASC';
  const employees = (await pool.query(empQuery, empParams)).rows;
  if (!employees.length) {
    return res.json({ date, summary: { total: 0, relieverOnDuty: 0, relieverPending: 0, onRegularDuty: 0, onLeave: 0, available: 0 }, employees: [] });
  }
  const empIds = employees.map(e => e.employee_id);

  // Today's attendance punches (regular duty) — last punch per employee tells us if they're
  // currently punched in, plus its GPS as their most recent KNOWN location.
  const attToday = (await pool.query(
    'SELECT employee_id, status, latitude, longitude, address, server_time FROM attendance WHERE attendance_date = $1 AND company_id = $2 AND employee_id = ANY($3::text[]) ORDER BY server_time ASC',
    [date, companyId, empIds]
  )).rows;
  const lastPunchToday = new Map(); // employee_id -> last row today
  attToday.forEach(r => lastPunchToday.set(r.employee_id, r));

  // Fallback last-known location: most recent punch EVER (in case someone hasn't punched
  // today but we still want a rough last-seen location for the map/sort).
  const lastPunchEver = (await pool.query(
    `SELECT DISTINCT ON (employee_id) employee_id, latitude, longitude, address, server_time
     FROM attendance WHERE company_id = $1 AND employee_id = ANY($2::text[])
     ORDER BY employee_id, server_time DESC`,
    [companyId, empIds]
  )).rows;
  const lastKnownLoc = new Map();
  lastPunchEver.forEach(r => lastKnownLoc.set(r.employee_id, r));

  // Reliever assignments for this date — accepted ones mean "on reliever duty right now";
  // assigned-but-not-yet-responded means "pending".
  const relieverRows = (await pool.query(
    `SELECT reliever_employee_id, original_employee_id, status FROM reliever_assignments
     WHERE company_id = $1 AND duty_date = $2 AND status IN ('assigned', 'accepted')`,
    [companyId, date]
  )).rows;
  const relieverMap = new Map(); // reliever_employee_id -> { status, original_employee_id }
  relieverRows.forEach(r => relieverMap.set(r.reliever_employee_id, r));

  // Approved leave covering this date.
  const leaveRows = (await pool.query(
    `SELECT employee_id FROM leave_requests WHERE company_id = $1 AND status = 'approved' AND from_date <= $2 AND to_date >= $2`,
    [companyId, date]
  )).rows;
  const onLeaveSet = new Set(leaveRows.map(r => r.employee_id));

  let relieverOnDuty = 0, relieverPending = 0, onRegularDuty = 0, onLeave = 0, available = 0;

  const result = employees.map(emp => {
    const reliever = relieverMap.get(emp.employee_id);
    const punch = lastPunchToday.get(emp.employee_id);
    const loc = punch || lastKnownLoc.get(emp.employee_id) || null;
    const isOnLeave = onLeaveSet.has(emp.employee_id);
    const punchedInNow = punch && punch.status === 'on_duty';

    let status;
    if (reliever && reliever.status === 'accepted') { status = 'reliever_on_duty'; relieverOnDuty++; }
    else if (reliever && reliever.status === 'assigned') { status = 'reliever_pending'; relieverPending++; }
    else if (isOnLeave) { status = 'on_leave'; onLeave++; }
    else if (punchedInNow) { status = 'on_regular_duty'; onRegularDuty++; }
    else { status = 'available'; available++; }

    return {
      employee_id: emp.employee_id,
      name: emp.name,
      designation: emp.designation,
      phone: emp.phone,
      project: emp.project,
      zone: emp.zone,
      ward: emp.ward,
      location: emp.location,
      shift_category: emp.shift_category,
      status,
      covering_for: reliever ? reliever.original_employee_id : null,
      last_lat: loc ? Number(loc.latitude) : null,
      last_lng: loc ? Number(loc.longitude) : null,
      last_address: loc ? loc.address : null,
      last_seen_at: loc ? loc.server_time : null,
    };
  });

  res.json({
    date,
    summary: { total: employees.length, relieverOnDuty, relieverPending, onRegularDuty, onLeave, available },
    employees: result,
  });
});

// ---------------------------------------------------------------------------------------
// AI RELIEVER RANKING — given a site (project) that's short-staffed, ranks every currently
// free/available employee by fitness to cover it: distance (if lat/lng given), attendance
// reliability (last 30 days), shift-category match, and OT eligibility (not already close to
// a weekly OT ceiling). Doesn't call any external AI model — "AI" here means the same kind of
// multi-factor scoring a human dispatcher would do by hand, just automated and instant.
// ---------------------------------------------------------------------------------------
// Core ranking engine — shared by the manual POST /rank endpoint below AND the auto-assign
// scanner (see autoAssignEngine.js), so manual and automatic assignment can never disagree
// about who's "best" for a given shortage.
async function rankRelieversForSite(companyId, project, { lat: fallbackLat, lng: fallbackLng, weeklyOtCeilingHours, limit } = {}) {
  const weeklyOtCeiling = Number(weeklyOtCeilingHours) || 20;
  const today = new Date().toISOString().slice(0, 10);

  const { rows: siteRows } = await pool.query('SELECT * FROM projects WHERE company_id = $1 AND name = $2', [companyId, project]);
  const site = siteRows[0];

  // The reference point for "nearby" is the SHORTAGE SITE's own saved location — not
  // whoever happens to be running this from their browser. A dispatcher opening this from
  // home shouldn't skew every ranking towards their own house. lat/lng args are kept only
  // as a fallback for the rare case a site has no GPS location saved yet.
  const lat = site && site.latitude != null ? Number(site.latitude) : (fallbackLat != null ? Number(fallbackLat) : null);
  const lng = site && site.longitude != null ? Number(site.longitude) : (fallbackLng != null ? Number(fallbackLng) : null);
  if (lat == null || lng == null) {
    const err = new Error(`"${project}" has no GPS location saved yet. Add it under Operations Map → Edit Site Details, so ranking knows what "nearby" means for this site.`);
    err.status = 400;
    throw err;
  }

  const employees = (await pool.query(
    'SELECT employee_id, name, project, shift_category, designation FROM employees WHERE company_id = $1 AND active = 1',
    [companyId]
  )).rows;
  if (!employees.length) return { project, site, candidateCount: 0, ranked: [] };
  const empIds = employees.map(e => e.employee_id);

  // Exclude anyone already on reliever duty today or on approved leave today or currently
  // punched in on their own regular shift — only genuinely free people get ranked.
  const busyReliever = new Set((await pool.query(
    `SELECT reliever_employee_id FROM reliever_assignments WHERE company_id = $1 AND duty_date = $2 AND status IN ('assigned','accepted')`,
    [companyId, today]
  )).rows.map(r => r.reliever_employee_id));
  const busyLeave = new Set((await pool.query(
    `SELECT employee_id FROM leave_requests WHERE company_id = $1 AND status = 'approved' AND from_date <= $2 AND to_date >= $2`,
    [companyId, today]
  )).rows.map(r => r.employee_id));
  const busyRegular = new Set((await pool.query(
    `SELECT DISTINCT ON (employee_id) employee_id, status FROM attendance
     WHERE company_id = $1 AND attendance_date = $2 AND employee_id = ANY($3::text[]) ORDER BY employee_id, server_time DESC`,
    [companyId, today, empIds]
  )).rows.filter(r => r.status === 'on_duty').map(r => r.employee_id));

  // LIVE location (real-time, from location-ping while on_duty) is the primary distance
  // source now — this is the actual fix: ranking used to use a stale one-off attendance-punch
  // GPS point, which could be hours or days old. Falls back to their last attendance punch's
  // GPS as a rough last-known position if they've never sent a live ping.
  const liveLoc = new Map((await pool.query(
    `SELECT employee_id, live_latitude AS latitude, live_longitude AS longitude FROM employees
     WHERE company_id = $1 AND employee_id = ANY($2::text[]) AND live_latitude IS NOT NULL`,
    [companyId, empIds]
  )).rows.map(r => [r.employee_id, r]));
  const lastLoc = new Map((await pool.query(
    `SELECT DISTINCT ON (employee_id) employee_id, latitude, longitude FROM attendance
     WHERE company_id = $1 AND employee_id = ANY($2::text[]) ORDER BY employee_id, server_time DESC`,
    [companyId, empIds]
  )).rows.map(r => [r.employee_id, r]));

  const since30 = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
  const attendance30 = (await pool.query(
    `SELECT employee_id, COUNT(DISTINCT attendance_date) FILTER (WHERE status = 'on_duty') AS present_days
     FROM attendance WHERE company_id = $1 AND employee_id = ANY($2::text[]) AND attendance_date >= $3
     GROUP BY employee_id`,
    [companyId, empIds, since30]
  )).rows;
  const attendanceMap = new Map(attendance30.map(r => [r.employee_id, Number(r.present_days)]));

  const otSince = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
  const otRows = (await pool.query(
    `SELECT employee_id, COALESCE(SUM(ot_hours), 0) AS hrs FROM overtime_records
     WHERE company_id = $1 AND employee_id = ANY($2::text[]) AND work_date >= $3 GROUP BY employee_id`,
    [companyId, empIds, otSince]
  )).rows;
  const otMap = new Map(otRows.map(r => [r.employee_id, Number(r.hrs)]));

  function haversineKm(lat1, lng1, lat2, lng2) {
    const toRad = d => (d * Math.PI) / 180;
    const R = 6371;
    const dLat = toRad(lat2 - lat1), dLng = toRad(lng2 - lng1);
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  const candidates = employees.filter(e =>
    !busyReliever.has(e.employee_id) && !busyLeave.has(e.employee_id) && !busyRegular.has(e.employee_id)
  );

  const ranked = candidates.map(e => {
    const loc = liveLoc.get(e.employee_id) || lastLoc.get(e.employee_id);
    const distanceKm = (lat != null && lng != null && loc && loc.latitude != null)
      ? haversineKm(lat, lng, Number(loc.latitude), Number(loc.longitude)) : null;
    // Distance (0-35): closer is better, anything beyond 20km scores 0. No known location -> neutral half score.
    const distanceScore = distanceKm == null ? 17.5 : Math.max(0, 35 * (1 - Math.min(distanceKm, 20) / 20));
    // Attendance reliability (0-30): present days out of last 30.
    const presentDays = attendanceMap.get(e.employee_id) || 0;
    const attendanceScore = Math.min(1, presentDays / 30) * 30;
    // Shift match (0-20): full marks if they have a shift category on file at all (this
    // codebase doesn't track a distinct "expected shift" per site, so presence of any
    // assigned shift is treated as a match — 0 only for a genuinely unconfigured employee).
    const shiftScore = e.shift_category ? 20 : 0;
    // OT eligibility (0-15): full marks if this week's OT is well under the ceiling, tapering to 0 at/over it.
    const otHrs = otMap.get(e.employee_id) || 0;
    const otScore = Math.max(0, 15 * (1 - Math.min(otHrs, weeklyOtCeiling) / weeklyOtCeiling));

    const totalScore = Math.round(distanceScore + attendanceScore + shiftScore + otScore);
    return {
      employee_id: e.employee_id, name: e.name, project: e.project, designation: e.designation,
      shift_category: e.shift_category, distance_km: distanceKm != null ? Math.round(distanceKm * 10) / 10 : null,
      is_live_location: liveLoc.has(e.employee_id), _loc: loc,
      attendance_30d_pct: Math.round((presentDays / 30) * 100), ot_hours_7d: otHrs,
      score: totalScore, ml_score: null,
      breakdown: { distance: Math.round(distanceScore), attendance: Math.round(attendanceScore), shift: shiftScore, ot_eligibility: Math.round(otScore) },
    };
  });

  // ML-based ranking (spatial NearestNeighbors + a trained LogisticRegression fitness
  // scorer — see ml/rank_relievers.py) — used for every candidate with a known location.
  // Its output REPLACES the sort order (ml_score becomes primary) but the JS `score`/
  // `breakdown` above are always still returned too, both as a sanity-check a human can
  // read and as the automatic fallback if Python/scikit-learn isn't available in this
  // deployment (mlRankerBridge.rankWithPython resolves null in that case — see its own
  // comment for why that's the correct, non-breaking behavior).
  const withLocation = ranked.filter(r => r._loc && r._loc.latitude != null);
  if (withLocation.length) {
    const mlResult = await rankWithPython({
      site: { lat, lng },
      candidates: withLocation.map(r => ({
        employee_id: r.employee_id,
        lat: Number(r._loc.latitude), lng: Number(r._loc.longitude),
        attendance_30d_pct: r.attendance_30d_pct, ot_hours_7d: r.ot_hours_7d,
        has_shift: !!r.shift_category, is_live_location: r.is_live_location,
      })),
      weekly_ot_ceiling_hours: weeklyOtCeiling,
    });
    if (mlResult) {
      const mlByEmpId = new Map(mlResult.map(r => [r.employee_id, r]));
      ranked.forEach(r => {
        const mlRow = mlByEmpId.get(r.employee_id);
        if (mlRow) { r.ml_score = mlRow.ml_score; r.distance_km = mlRow.distance_km; }
      });
    }
  }
  ranked.forEach(r => delete r._loc);

  const usingMl = ranked.some(r => r.ml_score != null);
  ranked.sort((a, b) => usingMl ? (b.ml_score ?? -1) - (a.ml_score ?? -1) : b.score - a.score);

  const medals = ['🥇', '🥈', '🥉'];
  ranked.forEach((r, i) => { r.rank = i + 1; r.medal = medals[i] || null; });

  return { project, site, candidateCount: ranked.length, ranking_method: usingMl ? 'ml' : 'heuristic', ranked: ranked.slice(0, Math.min(limit || 20, 50)) };
}

// POST /api/reliever/rank  body: { project, lat?, lng?, weekly_ot_ceiling_hours?, limit? }
router.post('/rank', verifyAdminOrManager, async (req, res) => {
  const allowed = await checkRolePermission(pool, req.user.company_id, req.user.role, 'reliever');
  if (!allowed) return res.status(403).json({ error: 'You do not have access to Reliever Management.' });

  const project = (req.body.project || '').trim();
  if (!project) return res.status(400).json({ error: 'project is required' });

  try {
    const result = await rankRelieversForSite(req.user.company_id, project, {
      lat: req.body.lat, lng: req.body.lng, weeklyOtCeilingHours: req.body.weekly_ot_ceiling_hours, limit: req.body.limit,
    });
    res.json({ project: result.project, candidateCount: result.candidateCount, ranking_method: result.ranking_method, ranked: result.ranked });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------------------
// AUTO-ASSIGN — the on/off switch: when ON, the server's background loop (see
// autoAssignEngine.js, started from server.js) automatically finds shortage sites, ranks
// the nearest ~5 free employees for each, and force-assigns the best one — no dashboard
// needs to be open. When OFF, everything stays fully manual (the ranking modal above).
// ---------------------------------------------------------------------------------------
// GET /api/reliever/auto-assign-settings
router.get('/auto-assign-settings', verifyAdminOrManager, async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM reliever_auto_assign_settings WHERE company_id = $1', [req.user.company_id]);
  res.json(rows[0] || { company_id: req.user.company_id, enabled: false, radius_km: 15 });
});

// PUT /api/reliever/auto-assign-settings  body: { enabled, radius_km? }  (admin only — this
// changes an operational behavior that moves real people, not just a display preference)
router.put('/auto-assign-settings', verifyAdminOrManager, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Only an Admin can change Auto-Assign settings' });
  const enabled = !!req.body.enabled;
  const radiusKm = req.body.radius_km != null ? Number(req.body.radius_km) : 15;

  await pool.query(
    `INSERT INTO reliever_auto_assign_settings (company_id, enabled, radius_km, updated_by, updated_at)
     VALUES ($1, $2, $3, $4, NOW())
     ON CONFLICT (company_id) DO UPDATE SET enabled = $2, radius_km = $3, updated_by = $4, updated_at = NOW()`,
    [req.user.company_id, enabled, radiusKm, req.user.username || req.user.role]
  );
  await logAction(req, 'reliever_auto_assign_toggled', { targetType: 'company_settings', targetLabel: enabled ? 'enabled' : 'disabled' });
  res.json({ message: `Auto-Assign turned ${enabled ? 'ON' : 'OFF'}`, enabled, radius_km: radiusKm });
});

// POST /api/reliever/auto-assign/run — manual "run it right now" trigger (also fires
// automatically every 5 min in the background while the toggle is ON — this just lets an
// admin see the effect immediately after turning it on, or run a one-off pass with it off).
router.post('/auto-assign/run', verifyAdminOrManager, async (req, res) => {
  try {
    const { runAutoAssignForCompany } = require('../autoAssignEngine');
    const result = await runAutoAssignForCompany(req.user.company_id, { actorUsername: req.user.username || req.user.role });
    if (result.assignments.length) {
      await logAction(req, 'reliever_auto_assign_run', { targetType: 'reliever_assignment', details: `${result.assignments.length} placed` });
    }
    res.json({
      message: result.assignments.length ? `${result.assignments.length} reliever(s) auto-assigned` : 'No shortages found — nothing to assign',
      ...result,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
module.exports.rankRelieversForSite = rankRelieversForSite;
