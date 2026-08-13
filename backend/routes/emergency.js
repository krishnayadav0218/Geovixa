const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { verifyAdminOrManager } = require('../middleware');
const { effectiveProjects } = require('../projectScope');
const { logAction } = require('../auditLog');

// ---- live critical-shortage detection — reuses the exact same present/required numbers as
// the Live Operations Map (routes/projects.js /map), so the two views never disagree. A site
// is "critical" here when it's short-staffed right now (present < required). ----
// GET /api/emergency/status
router.get('/status', verifyAdminOrManager, async (req, res) => {
  const companyId = req.user.company_id;
  const scopeProjects = await effectiveProjects(req, pool);

  let siteQuery = 'SELECT id, name, required_manpower, supervisor_employee_id FROM projects WHERE company_id = $1';
  const siteParams = [companyId];
  if (scopeProjects && scopeProjects.length) { siteParams.push(scopeProjects); siteQuery += ` AND name = ANY($${siteParams.length}::text[])`; }
  const sites = (await pool.query(siteQuery, siteParams)).rows.filter(s => Number(s.required_manpower) > 0);
  if (!sites.length) return res.json({ criticalSites: [] });

  const siteNames = sites.map(s => s.name);
  const today = new Date().toISOString().slice(0, 10);
  const presentRows = (await pool.query(
    `SELECT e.project, COUNT(DISTINCT a.employee_id)::int AS present
     FROM attendance a JOIN employees e ON e.employee_id = a.employee_id AND e.company_id = a.company_id
     WHERE a.company_id = $1 AND a.attendance_date = $2 AND a.status = 'on_duty' AND e.project = ANY($3::text[])
     GROUP BY e.project`,
    [companyId, today, siteNames]
  )).rows;
  const presentMap = new Map(presentRows.map(r => [r.project, r.present]));

  // Already-escalated-and-still-open sites, so the frontend can show "already escalated" instead
  // of a raw "Escalate" button for something already being worked.
  const openEscalations = (await pool.query(
    "SELECT project FROM emergency_escalations WHERE company_id = $1 AND status = 'open'", [companyId]
  )).rows;
  const escalatedSet = new Set(openEscalations.map(r => r.project));

  const criticalSites = sites
    .map(s => ({ ...s, present: presentMap.get(s.name) || 0, shortage: Math.max(0, Number(s.required_manpower) - (presentMap.get(s.name) || 0)) }))
    .filter(s => s.shortage > 0)
    .map(s => ({
      project: s.name, required: Number(s.required_manpower), present: s.present, shortage: s.shortage,
      supervisor_employee_id: s.supervisor_employee_id,
      already_escalated: escalatedSet.has(s.name),
    }))
    .sort((a, b) => b.shortage - a.shortage);

  res.json({ count: criticalSites.length, criticalSites });
});

// ---- senior presses "Escalate" for a shortage — logs who was notified when, for tracking ----
// POST /api/emergency/escalate  body: { project, note? }
router.post('/escalate', verifyAdminOrManager, async (req, res) => {
  const project = (req.body.project || '').trim();
  if (!project) return res.status(400).json({ error: 'project is required' });

  const { rows: siteRows } = await pool.query('SELECT required_manpower FROM projects WHERE company_id = $1 AND name = $2', [req.user.company_id, project]);
  if (!siteRows[0]) return res.status(404).json({ error: 'Site not found' });

  const today = new Date().toISOString().slice(0, 10);
  const { rows: presentRows } = await pool.query(
    `SELECT COUNT(DISTINCT a.employee_id)::int AS present FROM attendance a
     JOIN employees e ON e.employee_id = a.employee_id AND e.company_id = a.company_id
     WHERE a.company_id = $1 AND a.attendance_date = $2 AND a.status = 'on_duty' AND e.project = $3`,
    [req.user.company_id, today, project]
  );
  const shortage = Math.max(0, Number(siteRows[0].required_manpower) - Number(presentRows[0].present));

  const { rows } = await pool.query(
    `INSERT INTO emergency_escalations (company_id, project, shortage, escalated_by, status, note)
     VALUES ($1, $2, $3, $4, 'open', $5) RETURNING id`,
    [req.user.company_id, project, shortage, req.user.username || req.user.role, (req.body.note || '').trim() || null]
  );
  await logAction(req, 'emergency_escalated', { targetType: 'emergency_escalation', targetId: rows[0].id, targetLabel: `${project} — short ${shortage}` });
  res.json({ message: `Escalated — ${project} is short ${shortage} staff. Nearby supervisors/ops manager should be notified.`, id: rows[0].id, shortage });
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
