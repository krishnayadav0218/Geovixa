const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { verifyAdmin, verifyAdminOrManager, verifyReports } = require('../middleware');
const { listGroups } = require('../projectGroups');
const { effectiveProjects } = require('../projectScope');

// admin + manager/coordinator/report-only-role can see the list (needed to populate
// dropdowns/filters/pills) — own company only
router.get('/', verifyReports, async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM projects WHERE company_id = $1 ORDER BY name ASC', [req.user.company_id]);
  res.json({ count: rows.length, projects: rows });
});

// GET /api/projects/groups -> distinct Group Names currently in use + their member projects,
// admin only (used to power the "existing groups" suggestions in Manage Projects)
router.get('/groups', verifyAdmin, async (req, res) => {
  const groups = await listGroups(pool, req.user.company_id);
  res.json({ count: groups.length, groups });
});

// only admin can add/edit/remove projects (own company)
router.post('/', verifyAdmin, async (req, res) => {
  const { name, weekly_off_day, group_name } = req.body;
  if (!name || !name.trim()) {
    return res.status(400).json({ error: 'Project name is required' });
  }
  const offDay = weekly_off_day !== undefined && weekly_off_day !== null && weekly_off_day !== ''
    ? Number(weekly_off_day)
    : 0;
  if (!Number.isInteger(offDay) || offDay < 0 || offDay > 6) {
    return res.status(400).json({ error: 'Weekly off day must be 0 (Sunday) through 6 (Saturday)' });
  }
  try {
    await pool.query(
      'INSERT INTO projects (name, weekly_off_day, group_name, company_id) VALUES ($1, $2, $3, $4)',
      [name.trim(), offDay, (group_name || '').trim() || null, req.user.company_id]
    );
    res.json({ message: 'Project added successfully' });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'This project already exists' });
    }
    res.status(500).json({ error: err.message });
  }
});

// admin can fully edit a project — rename it, change its weekly off day, and/or set/clear
// (group / ungroup) its Group Name. Renaming cascades to every place the old name is stored
// (employees.project, admins.project for Manager/Coordinator accounts, salary_slip_requests)
// so nothing is left pointing at a name that no longer exists — all scoped to this company.
router.put('/:id', verifyAdmin, async (req, res) => {
  const { name, weekly_off_day, group_name } = req.body;
  const companyId = req.user.company_id;
  const { rows } = await pool.query('SELECT * FROM projects WHERE id = $1 AND company_id = $2', [req.params.id, companyId]);
  const existing = rows[0];
  if (!existing) return res.status(404).json({ error: 'Project not found' });

  let offDay = existing.weekly_off_day;
  if (weekly_off_day !== undefined && weekly_off_day !== null && weekly_off_day !== '') {
    offDay = Number(weekly_off_day);
    if (!Number.isInteger(offDay) || offDay < 0 || offDay > 6) {
      return res.status(400).json({ error: 'Weekly off day must be 0 (Sunday) through 6 (Saturday)' });
    }
  }

  const newName = (name !== undefined && name.trim()) ? name.trim() : existing.name;
  // group_name === '' (explicitly blank) means "ungroup"; group_name === undefined means "leave as-is"
  const newGroup = group_name !== undefined ? ((group_name || '').trim() || null) : existing.group_name;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    if (newName !== existing.name) {
      const dupe = await client.query('SELECT id FROM projects WHERE name = $1 AND id <> $2 AND company_id = $3', [newName, req.params.id, companyId]);
      if (dupe.rows.length) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'Another project already has this name' });
      }
    }

    await client.query(
      'UPDATE projects SET name = $1, weekly_off_day = $2, group_name = $3 WHERE id = $4 AND company_id = $5',
      [newName, offDay, newGroup, req.params.id, companyId]
    );

    if (newName !== existing.name) {
      await client.query('UPDATE employees SET project = $1 WHERE project = $2 AND company_id = $3', [newName, existing.name, companyId]);
      await client.query('UPDATE admins SET project = $1 WHERE project = $2 AND company_id = $3', [newName, existing.name, companyId]);
      await client.query('UPDATE salary_slip_requests SET project = $1 WHERE project = $2 AND company_id = $3', [newName, existing.name, companyId]);
      await client.query('UPDATE leave_requests SET project = $1 WHERE project = $2 AND company_id = $3', [newName, existing.name, companyId]);
      await client.query('UPDATE grievances SET project = $1 WHERE project = $2 AND company_id = $3', [newName, existing.name, companyId]);
    }

    await client.query('COMMIT');
    res.json({ message: 'Project updated successfully' });
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.code === '23505') {
      return res.status(409).json({ error: 'Another project already has this name' });
    }
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

router.delete('/:id', verifyAdmin, async (req, res) => {
  const result = await pool.query('DELETE FROM projects WHERE id = $1 AND company_id = $2', [req.params.id, req.user.company_id]);
  if (result.rowCount === 0) return res.status(404).json({ error: 'Project not found' });
  res.json({ message: 'Project removed' });
});

// ---------------------------------------------------------------------------------------
// SITE MANAGEMENT — extended fields (client, address, geofence, required manpower,
// supervisor, SLA target) on top of the existing project record.
// ---------------------------------------------------------------------------------------
// PUT /api/projects/:id/site-details  (admin only)
router.put('/:id/site-details', verifyAdmin, async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM projects WHERE id = $1 AND company_id = $2', [req.params.id, req.user.company_id]);
  const existing = rows[0];
  if (!existing) return res.status(404).json({ error: 'Project not found' });

  const { client, address, latitude, longitude, geofence_radius_m, required_manpower, supervisor_employee_id, sla_hours } = req.body;

  if (supervisor_employee_id) {
    const { rows: supRows } = await pool.query(
      'SELECT employee_id FROM employees WHERE employee_id = $1 AND company_id = $2',
      [supervisor_employee_id, req.user.company_id]
    );
    if (!supRows[0]) return res.status(400).json({ error: 'Supervisor employee not found' });
  }

  await pool.query(
    `UPDATE projects SET
       client = $1, address = $2,
       latitude = $3, longitude = $4,
       geofence_radius_m = $5, required_manpower = $6,
       supervisor_employee_id = $7, sla_hours = $8
     WHERE id = $9 AND company_id = $10`,
    [
      (client || '').trim() || null, (address || '').trim() || null,
      latitude !== undefined && latitude !== '' ? Number(latitude) : existing.latitude,
      longitude !== undefined && longitude !== '' ? Number(longitude) : existing.longitude,
      geofence_radius_m !== undefined && geofence_radius_m !== '' ? Number(geofence_radius_m) : existing.geofence_radius_m,
      required_manpower !== undefined && required_manpower !== '' ? Number(required_manpower) : existing.required_manpower,
      (supervisor_employee_id || '').trim() || null,
      sla_hours !== undefined && sla_hours !== '' ? Number(sla_hours) : existing.sla_hours,
      req.params.id, req.user.company_id,
    ]
  );
  res.json({ message: 'Site details updated' });
});

// Shared health-score calculator — same formula used by both the site list and the Live
// Operations Map, so the two views can never disagree about a site's status.
//   Attendance   (0-40 pts): present-today ÷ active employees assigned to this site
//   Manpower     (0-30 pts): present-today ÷ required manpower (full marks if no target set)
//   Complaints   (0-20 pts): -5 for every currently-open grievance at this site, floor 0
//   SLA          (0-10 pts): 0 if any open grievance has been open longer than the site's
//                            sla_hours target (a breach), else full marks
// >=80 -> green (normal), 50-79 -> yellow (shortage), <50 -> red (critical)
function computeSiteHealth({ presentToday, activeAssigned, requiredManpower, openComplaints, slaBreached }) {
  const attendanceScore = activeAssigned > 0 ? Math.min(1, presentToday / activeAssigned) * 40 : 40;
  const manpowerScore = requiredManpower > 0 ? Math.min(1, presentToday / requiredManpower) * 30 : 30;
  const complaintScore = Math.max(0, 20 - openComplaints * 5);
  const slaScore = slaBreached ? 0 : 10;
  const score = Math.round(attendanceScore + manpowerScore + complaintScore + slaScore);
  const status = score >= 80 ? 'green' : score >= 50 ? 'yellow' : 'red';
  return { score, status };
}

// ---------------------------------------------------------------------------------------
// LIVE OPERATIONS MAP — one card per site: required vs present manpower, shortage, health
// score/status color, supervisor, open complaints. Meant to be polled by the frontend for a
// near-real-time board (same polling pattern as the Reliever Management dashboard).
// ---------------------------------------------------------------------------------------
// GET /api/projects/map
router.get('/map', verifyAdminOrManager, async (req, res) => {
  const companyId = req.user.company_id;
  const scopeProjects = await effectiveProjects(req, pool);

  let siteQuery = 'SELECT * FROM projects WHERE company_id = $1';
  const siteParams = [companyId];
  if (scopeProjects && scopeProjects.length) { siteParams.push(scopeProjects); siteQuery += ` AND name = ANY($${siteParams.length}::text[])`; }
  const sites = (await pool.query(siteQuery, siteParams)).rows;
  if (!sites.length) return res.json({ count: 0, sites: [] });

  const today = new Date().toISOString().slice(0, 10);
  const siteNames = sites.map(s => s.name);

  const activeCounts = (await pool.query(
    `SELECT project, COUNT(*)::int AS c FROM employees WHERE company_id = $1 AND active = 1 AND project = ANY($2::text[]) GROUP BY project`,
    [companyId, siteNames]
  )).rows;
  const activeMap = new Map(activeCounts.map(r => [r.project, r.c]));

  // "Present today" = currently punched on_duty (last punch of the day per employee is on_duty).
  // attendance has no project column of its own — join through employees for the site.
  const presentRows = (await pool.query(
    `SELECT DISTINCT ON (a.employee_id) a.employee_id, e.project, a.status
     FROM attendance a
     JOIN employees e ON e.employee_id = a.employee_id AND e.company_id = a.company_id
     WHERE a.company_id = $1 AND a.attendance_date = $2 AND e.project = ANY($3::text[])
     ORDER BY a.employee_id, a.server_time DESC`,
    [companyId, today, siteNames]
  )).rows;
  const presentCountMap = new Map();
  presentRows.filter(r => r.status === 'on_duty').forEach(r => presentCountMap.set(r.project, (presentCountMap.get(r.project) || 0) + 1));

  const openComplaintRows = (await pool.query(
    `SELECT project, COUNT(*)::int AS c, MIN(requested_at) AS oldest
     FROM grievances WHERE company_id = $1 AND status = 'pending' AND project = ANY($2::text[]) GROUP BY project`,
    [companyId, siteNames]
  )).rows;
  const complaintsMap = new Map(openComplaintRows.map(r => [r.project, r]));

  const relieverRows = (await pool.query(
    `SELECT project, COUNT(*)::int AS c FROM reliever_assignments
     WHERE company_id = $1 AND duty_date = $2 AND status = 'accepted' AND project = ANY($3::text[]) GROUP BY project`,
    [companyId, today, siteNames]
  )).rows;
  const relieverMap = new Map(relieverRows.map(r => [r.project, r.c]));

  const supervisorIds = sites.filter(s => s.supervisor_employee_id).map(s => s.supervisor_employee_id);
  let supervisorNames = new Map();
  if (supervisorIds.length) {
    const supRows = (await pool.query(
      'SELECT employee_id, name FROM employees WHERE company_id = $1 AND employee_id = ANY($2::text[])', [companyId, supervisorIds]
    )).rows;
    supervisorNames = new Map(supRows.map(r => [r.employee_id, r.name]));
  }

  const result = sites.map(s => {
    const activeAssigned = activeMap.get(s.name) || 0;
    const presentToday = presentCountMap.get(s.name) || 0;
    const complaint = complaintsMap.get(s.name);
    const openComplaints = complaint ? complaint.c : 0;
    const slaBreached = !!(complaint && (new Date() - new Date(complaint.oldest)) / 36e5 > Number(s.sla_hours || 24));
    const { score, status } = computeSiteHealth({
      presentToday, activeAssigned, requiredManpower: Number(s.required_manpower) || 0, openComplaints, slaBreached,
    });
    return {
      id: s.id, name: s.name, client: s.client, address: s.address,
      latitude: s.latitude != null ? Number(s.latitude) : null,
      longitude: s.longitude != null ? Number(s.longitude) : null,
      required_manpower: Number(s.required_manpower) || 0,
      present_today: presentToday,
      shortage: Math.max(0, (Number(s.required_manpower) || 0) - presentToday),
      active_assigned: activeAssigned,
      reliever_on_duty: relieverMap.get(s.name) || 0,
      open_complaints: openComplaints,
      sla_breached: slaBreached,
      supervisor_employee_id: s.supervisor_employee_id,
      supervisor_name: s.supervisor_employee_id ? (supervisorNames.get(s.supervisor_employee_id) || s.supervisor_employee_id) : null,
      health_score: score,
      status,
    };
  });

  res.json({ count: result.length, date: today, sites: result });
});

// GET /api/projects/:id/detail — click-through detail for one site on the map: full present
// / absent employee lists, current reliever coverage, open complaints.
router.get('/:id/detail', verifyAdminOrManager, async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM projects WHERE id = $1 AND company_id = $2', [req.params.id, req.user.company_id]);
  const site = rows[0];
  if (!site) return res.status(404).json({ error: 'Site not found' });

  const scopeProjects = await effectiveProjects(req, pool);
  if (scopeProjects && scopeProjects.length && !scopeProjects.includes(site.name)) {
    return res.status(403).json({ error: 'This site is not in your project' });
  }

  const companyId = req.user.company_id;
  const today = new Date().toISOString().slice(0, 10);

  const employees = (await pool.query(
    'SELECT employee_id, name, designation, shift_category FROM employees WHERE company_id = $1 AND project = $2 AND active = 1 ORDER BY name',
    [companyId, site.name]
  )).rows;

  const punches = (await pool.query(
    `SELECT DISTINCT ON (a.employee_id) a.employee_id, a.status, a.server_time
     FROM attendance a
     JOIN employees e ON e.employee_id = a.employee_id AND e.company_id = a.company_id
     WHERE a.company_id = $1 AND a.attendance_date = $2 AND e.project = $3
     ORDER BY a.employee_id, a.server_time DESC`,
    [companyId, today, site.name]
  )).rows;
  const punchMap = new Map(punches.map(r => [r.employee_id, r]));

  const present = [], absent = [];
  employees.forEach(e => {
    const p = punchMap.get(e.employee_id);
    if (p && p.status === 'on_duty') present.push({ ...e, since: p.server_time });
    else absent.push(e);
  });

  const complaints = (await pool.query(
    `SELECT id, employee_id, subject, status, requested_at FROM grievances
     WHERE company_id = $1 AND project = $2 ORDER BY requested_at DESC LIMIT 20`,
    [companyId, site.name]
  )).rows;

  const relievers = (await pool.query(
    `SELECT reliever_employee_id, original_employee_id, status FROM reliever_assignments
     WHERE company_id = $1 AND project = $2 AND duty_date = $3`,
    [companyId, site.name, today]
  )).rows;

  res.json({ site, present, absent, complaints, relievers });
});

module.exports = router;
