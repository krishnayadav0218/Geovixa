const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { verifyAdminOrManager, verifyEmployee } = require('../middleware');
const { effectiveProjects } = require('../projectScope');
const { notifyEmployee } = require('../notifyEmployee');
const { logAction } = require('../auditLog');

// ---- employee (self) — upcoming schedule ----
// GET /api/roster/my?from=YYYY-MM-DD&to=YYYY-MM-DD
router.get('/my', verifyEmployee, async (req, res) => {
  const from = req.query.from || new Date().toISOString().slice(0, 10);
  const to = req.query.to || new Date(Date.now() + 14 * 86400000).toISOString().slice(0, 10);
  const { rows } = await pool.query(
    `SELECT sr.id, sr.roster_date, sr.project, sr.shift_category, sr.shift_start_time, sr.status, sl.name AS site_name
     FROM shift_roster sr LEFT JOIN site_locations sl ON sl.id = sr.site_location_id
     WHERE sr.employee_id = $1 AND sr.company_id = $2 AND sr.roster_date BETWEEN $3 AND $4
     ORDER BY sr.roster_date ASC`,
    [req.user.employee_id, req.user.company_id, from, to]
  );
  res.json({ roster: rows });
});

// ---- admin/manager — view roster for a date range, optionally filtered by project ----
// GET /api/roster?from=&to=&project=
router.get('/', verifyAdminOrManager, async (req, res) => {
  const scope = await effectiveProjects(pool, req.user);
  const from = req.query.from || new Date().toISOString().slice(0, 10);
  const to = req.query.to || new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);

  let query = `SELECT sr.*, e.name AS employee_name, sl.name AS site_name FROM shift_roster sr
               LEFT JOIN employees e ON e.employee_id = sr.employee_id AND e.company_id = sr.company_id
               LEFT JOIN site_locations sl ON sl.id = sr.site_location_id
               WHERE sr.company_id = $1 AND sr.roster_date BETWEEN $2 AND $3`;
  const params = [req.user.company_id, from, to];
  if (scope.restricted) {
    params.push(scope.projects);
    query += ` AND sr.project = ANY($${params.length})`;
  }
  if (req.query.project) {
    params.push(req.query.project);
    query += ` AND sr.project = $${params.length}`;
  }
  query += ' ORDER BY sr.roster_date ASC, e.name ASC';
  const { rows } = await pool.query(query, params);
  res.json({ roster: rows });
});

// ---- admin/manager — assign one employee to one date/site/shift ----
// POST /api/roster  body: { employee_id, project, site_location_id?, roster_date, shift_category?, shift_start_time? }
router.post('/', verifyAdminOrManager, async (req, res) => {
  const { employee_id, project, site_location_id, roster_date, shift_category, shift_start_time } = req.body;
  if (!employee_id || !roster_date) {
    return res.status(400).json({ error: 'employee_id and roster_date are required' });
  }

  const { rows } = await pool.query(
    `INSERT INTO shift_roster (company_id, employee_id, project, site_location_id, roster_date, shift_category, shift_start_time, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (company_id, employee_id, roster_date)
     DO UPDATE SET project = $3, site_location_id = $4, shift_category = $6, shift_start_time = $7, reminder_sent = FALSE
     RETURNING id`,
    [req.user.company_id, employee_id, project || null, site_location_id || null, roster_date, shift_category || null, shift_start_time || null, req.user.username || 'admin']
  );

  await notifyEmployee(
    req.user.company_id, employee_id, 'roster_assigned',
    'New shift scheduled',
    `You're scheduled for ${roster_date}${shift_start_time ? ` at ${shift_start_time}` : ''}${project ? ` — ${project}` : ''}.`
  );
  await logAction(req, 'roster_assigned', { targetType: 'shift_roster', targetId: rows[0].id, targetLabel: `${employee_id} → ${roster_date}` });

  res.json({ message: 'Roster entry saved', id: rows[0].id });
});

// ---- admin/manager — bulk-assign the same shift to many employees at once ----
// POST /api/roster/bulk  body: { employee_ids: [...], project, site_location_id?, roster_date, shift_category?, shift_start_time? }
router.post('/bulk', verifyAdminOrManager, async (req, res) => {
  const { employee_ids, project, site_location_id, roster_date, shift_category, shift_start_time } = req.body;
  if (!Array.isArray(employee_ids) || !employee_ids.length || !roster_date) {
    return res.status(400).json({ error: 'employee_ids (array) and roster_date are required' });
  }
  let saved = 0;
  for (const employeeId of employee_ids) {
    await pool.query(
      `INSERT INTO shift_roster (company_id, employee_id, project, site_location_id, roster_date, shift_category, shift_start_time, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (company_id, employee_id, roster_date)
       DO UPDATE SET project = $3, site_location_id = $4, shift_category = $6, shift_start_time = $7, reminder_sent = FALSE`,
      [req.user.company_id, employeeId, project || null, site_location_id || null, roster_date, shift_category || null, shift_start_time || null, req.user.username || 'admin']
    );
    await notifyEmployee(
      req.user.company_id, employeeId, 'roster_assigned', 'New shift scheduled',
      `You're scheduled for ${roster_date}${shift_start_time ? ` at ${shift_start_time}` : ''}${project ? ` — ${project}` : ''}.`
    );
    saved++;
  }
  res.json({ message: `${saved} roster entries saved` });
});

// DELETE /api/roster/:id
router.delete('/:id', verifyAdminOrManager, async (req, res) => {
  const result = await pool.query('DELETE FROM shift_roster WHERE id = $1 AND company_id = $2', [req.params.id, req.user.company_id]);
  if (result.rowCount === 0) return res.status(404).json({ error: 'Roster entry not found' });
  res.json({ message: 'Roster entry removed' });
});

module.exports = router;
