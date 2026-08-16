const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { verifyAdminOrManager } = require('../middleware');
const { effectiveProjects } = require('../projectScope');
const { logAction } = require('../auditLog');

// ---- live critical-shortage detection — checks BOTH whole-project shortage (projects.
// required_manpower) AND per-sub-location shortage (site_locations.required_manpower). A
// project's overall headcount can look fine while one specific building within it is short —
// project-level totals alone hide that, so both levels are always checked together. ----
// GET /api/emergency/status
router.get('/status', verifyAdminOrManager, async (req, res) => {
  const companyId = req.user.company_id;
  const scopeProjects = await effectiveProjects(req, pool);
  const today = new Date().toISOString().slice(0, 10);

  const openEscalations = (await pool.query(
    "SELECT project, site_location_id FROM emergency_escalations WHERE company_id = $1 AND status = 'open'", [companyId]
  )).rows;
  const escalatedProjectSet = new Set(openEscalations.filter(e => !e.site_location_id).map(r => r.project));
  const escalatedLocationSet = new Set(openEscalations.filter(e => e.site_location_id).map(r => r.site_location_id));

  const criticalSites = [];

  // --- Project-level shortages ---
  let siteQuery = 'SELECT id, name, required_manpower, supervisor_employee_id FROM projects WHERE company_id = $1';
  const siteParams = [companyId];
  if (scopeProjects && scopeProjects.length) { siteParams.push(scopeProjects); siteQuery += ` AND name = ANY($${siteParams.length}::text[])`; }
  const projSites = (await pool.query(siteQuery, siteParams)).rows.filter(s => Number(s.required_manpower) > 0);

  if (projSites.length) {
    const siteNames = projSites.map(s => s.name);
    const presentRows = (await pool.query(
      `SELECT e.project, COUNT(DISTINCT a.employee_id)::int AS present
       FROM attendance a JOIN employees e ON e.employee_id = a.employee_id AND e.company_id = a.company_id
       WHERE a.company_id = $1 AND a.attendance_date = $2 AND a.status = 'on_duty' AND e.project = ANY($3::text[])
       GROUP BY e.project`,
      [companyId, today, siteNames]
    )).rows;
    const presentMap = new Map(presentRows.map(r => [r.project, r.present]));

    projSites.forEach(s => {
      const present = presentMap.get(s.name) || 0;
      const shortage = Math.max(0, Number(s.required_manpower) - present);
      if (shortage > 0) {
        criticalSites.push({
          project: s.name, location: null, site_location_id: null,
          required: Number(s.required_manpower), present, shortage,
          supervisor_employee_id: s.supervisor_employee_id,
          already_escalated: escalatedProjectSet.has(s.name),
        });
      }
    });
  }

  // --- Sub-location-level shortages ---
  let locQuery = 'SELECT id, project, name, required_manpower FROM site_locations WHERE company_id = $1';
  const locParams = [companyId];
  if (scopeProjects && scopeProjects.length) { locParams.push(scopeProjects); locQuery += ` AND project = ANY($${locParams.length}::text[])`; }
  const locations = (await pool.query(locQuery, locParams)).rows.filter(l => Number(l.required_manpower) > 0);

  if (locations.length) {
    const locIds = locations.map(l => l.id);
    const presentRows = (await pool.query(
      `SELECT e.site_location_id, COUNT(DISTINCT a.employee_id)::int AS present
       FROM attendance a JOIN employees e ON e.employee_id = a.employee_id AND e.company_id = a.company_id
       WHERE a.company_id = $1 AND a.attendance_date = $2 AND a.status = 'on_duty' AND e.site_location_id = ANY($3::int[])
       GROUP BY e.site_location_id`,
      [companyId, today, locIds]
    )).rows;
    const presentMap = new Map(presentRows.map(r => [r.site_location_id, r.present]));

    locations.forEach(l => {
      const present = presentMap.get(l.id) || 0;
      const shortage = Math.max(0, Number(l.required_manpower) - present);
      if (shortage > 0) {
        criticalSites.push({
          project: l.project, location: l.name, site_location_id: l.id,
          required: Number(l.required_manpower), present, shortage,
          supervisor_employee_id: null,
          already_escalated: escalatedLocationSet.has(l.id),
        });
      }
    });
  }

  criticalSites.sort((a, b) => b.shortage - a.shortage);
  res.json({ count: criticalSites.length, criticalSites });
});

// ---- senior presses "Escalate" for a shortage — logs who was notified when, for tracking.
// Pass site_location_id to escalate a specific sub-location's shortage instead of the whole
// project. ----
// POST /api/emergency/escalate  body: { project, site_location_id?, note? }
router.post('/escalate', verifyAdminOrManager, async (req, res) => {
  const project = (req.body.project || '').trim();
  const siteLocationId = req.body.site_location_id ? Number(req.body.site_location_id) : null;
  if (!project) return res.status(400).json({ error: 'project is required' });

  const today = new Date().toISOString().slice(0, 10);
  let requiredManpower, present, locationName = null;

  if (siteLocationId) {
    const { rows: locRows } = await pool.query(
      'SELECT name, required_manpower FROM site_locations WHERE id = $1 AND company_id = $2 AND project = $3',
      [siteLocationId, req.user.company_id, project]
    );
    if (!locRows[0]) return res.status(404).json({ error: 'Location not found' });
    requiredManpower = Number(locRows[0].required_manpower);
    locationName = locRows[0].name;
    const { rows: presentRows } = await pool.query(
      `SELECT COUNT(DISTINCT a.employee_id)::int AS present FROM attendance a
       JOIN employees e ON e.employee_id = a.employee_id AND e.company_id = a.company_id
       WHERE a.company_id = $1 AND a.attendance_date = $2 AND a.status = 'on_duty' AND e.site_location_id = $3`,
      [req.user.company_id, today, siteLocationId]
    );
    present = Number(presentRows[0].present);
  } else {
    const { rows: siteRows } = await pool.query('SELECT required_manpower FROM projects WHERE company_id = $1 AND name = $2', [req.user.company_id, project]);
    if (!siteRows[0]) return res.status(404).json({ error: 'Site not found' });
    requiredManpower = Number(siteRows[0].required_manpower);
    const { rows: presentRows } = await pool.query(
      `SELECT COUNT(DISTINCT a.employee_id)::int AS present FROM attendance a
       JOIN employees e ON e.employee_id = a.employee_id AND e.company_id = a.company_id
       WHERE a.company_id = $1 AND a.attendance_date = $2 AND a.status = 'on_duty' AND e.project = $3`,
      [req.user.company_id, today, project]
    );
    present = Number(presentRows[0].present);
  }
  const shortage = Math.max(0, requiredManpower - present);
  const label = locationName ? `${project} — ${locationName}` : project;

  const { rows } = await pool.query(
    `INSERT INTO emergency_escalations (company_id, project, site_location_id, location_name, shortage, escalated_by, status, note)
     VALUES ($1, $2, $3, $4, $5, $6, 'open', $7) RETURNING id`,
    [req.user.company_id, project, siteLocationId, locationName, shortage, req.user.username || req.user.role, (req.body.note || '').trim() || null]
  );
  await logAction(req, 'emergency_escalated', { targetType: 'emergency_escalation', targetId: rows[0].id, targetLabel: `${label} — short ${shortage}` });
  res.json({ message: `Escalated — ${label} is short ${shortage} staff. Nearby supervisors/ops manager should be notified.`, id: rows[0].id, shortage });
});

// ---- resolve an escalation once it's handled ----
router.put('/escalations/:id/resolve', verifyAdminOrManager, async (req, res) => {
  const { rows } = await pool.query(
    "UPDATE emergency_escalations SET status = 'resolved', resolved_at = NOW() WHERE id = $1 AND company_id = $2 RETURNING id",
    [req.params.id, req.user.company_id]
  );
  if (!rows.length) return res.status(404).json({ error: 'Escalation not found' });
  await logAction(req, 'emergency_escalation_resolved', { targetType: 'emergency_escalation', targetId: req.params.id });
  res.json({ message: 'Escalation marked resolved' });
});

router.get('/escalations', verifyAdminOrManager, async (req, res) => {
  const { rows } = await pool.query(
    'SELECT * FROM emergency_escalations WHERE company_id = $1 ORDER BY created_at DESC LIMIT 100',
    [req.user.company_id]
  );
  res.json({ escalations: rows });
});

module.exports = router;
