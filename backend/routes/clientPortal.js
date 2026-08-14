const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { verifyClient } = require('../middleware');

// Every route here is scoped to req.user.projects (set at client-login time from
// client_sites) — a client can NEVER see a site they weren't explicitly assigned, and never
// sees salary, bank details, personal phone numbers, or anything else HR-confidential —
// only what the spec calls out: manpower, attendance, shortage, complaints, SLA, performance.
function clientSites(req) {
  return Array.isArray(req.user.projects) ? req.user.projects : [];
}

// GET /api/client-portal/sites — overview card per assigned site
router.get('/sites', verifyClient, async (req, res) => {
  const siteNames = clientSites(req);
  if (!siteNames.length) return res.json({ sites: [] });
  const companyId = req.user.company_id;

  const sites = (await pool.query(
    'SELECT id, name, address, required_manpower FROM projects WHERE company_id = $1 AND name = ANY($2::text[])',
    [companyId, siteNames]
  )).rows;

  const today = new Date().toISOString().slice(0, 10);
  const activeCounts = new Map((await pool.query(
    'SELECT project, COUNT(*)::int AS c FROM employees WHERE company_id = $1 AND active = 1 AND project = ANY($2::text[]) GROUP BY project',
    [companyId, siteNames]
  )).rows.map(r => [r.project, r.c]));

  const presentRows = (await pool.query(
    `SELECT e.project, COUNT(DISTINCT a.employee_id)::int AS present
     FROM attendance a JOIN employees e ON e.employee_id = a.employee_id AND e.company_id = a.company_id
     WHERE a.company_id = $1 AND a.attendance_date = $2 AND a.status = 'on_duty' AND e.project = ANY($3::text[])
     GROUP BY e.project`,
    [companyId, today, siteNames]
  )).rows;
  const presentMap = new Map(presentRows.map(r => [r.project, r.present]));

  const openComplaints = new Map((await pool.query(
    `SELECT project, COUNT(*)::int AS c FROM grievances WHERE company_id = $1 AND status = 'pending' AND project = ANY($2::text[]) GROUP BY project`,
    [companyId, siteNames]
  )).rows.map(r => [r.project, r.c]));

  const openTickets = new Map((await pool.query(
    `SELECT project, COUNT(*)::int AS c FROM maintenance_tickets
     WHERE company_id = $1 AND status NOT IN ('resolved','verified','closed') AND project = ANY($2::text[]) GROUP BY project`,
    [companyId, siteNames]
  )).rows.map(r => [r.project, r.c]));

  const result = sites.map(s => {
    const required = Number(s.required_manpower) || 0;
    const present = presentMap.get(s.name) || 0;
    return {
      project: s.name, address: s.address,
      required_manpower: required, present_today: present,
      shortage: Math.max(0, required - present),
      deployed_employees: activeCounts.get(s.name) || 0,
      open_complaints: openComplaints.get(s.name) || 0,
      open_maintenance_tickets: openTickets.get(s.name) || 0,
    };
  });
  res.json({ date: today, sites: result });
});

// GET /api/client-portal/sites/:project/detail — deployment (name+designation only, no
// phone/bank), attendance %, absenteeism, complaints, SLA
router.get('/sites/:project/detail', verifyClient, async (req, res) => {
  const project = req.params.project;
  if (!clientSites(req).includes(project)) return res.status(403).json({ error: 'This site is not assigned to your account' });
  const companyId = req.user.company_id;
  const today = new Date().toISOString().slice(0, 10);

  const employees = (await pool.query(
    'SELECT employee_id, name, designation, shift_category FROM employees WHERE company_id = $1 AND project = $2 AND active = 1 ORDER BY name',
    [companyId, project]
  )).rows;

  const punches = new Map((await pool.query(
    `SELECT DISTINCT ON (a.employee_id) a.employee_id, a.status FROM attendance a
     JOIN employees e ON e.employee_id = a.employee_id AND e.company_id = a.company_id
     WHERE a.company_id = $1 AND a.attendance_date = $2 AND e.project = $3
     ORDER BY a.employee_id, a.server_time DESC`,
    [companyId, today, project]
  )).rows.map(r => [r.employee_id, r.status]));

  const deployment = employees.map(e => ({
    name: e.name, designation: e.designation, shift_category: e.shift_category,
    status_today: punches.get(e.employee_id) === 'on_duty' ? 'present' : 'absent',
  }));

  // 30-day attendance % across the whole site (not per-employee — that would edge toward
  // individually-identifiable HR data, which the client shouldn't get).
  const since30 = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
  const empIds = employees.map(e => e.employee_id);
  let attendancePct = null;
  if (empIds.length) {
    const { rows } = await pool.query(
      `SELECT COUNT(DISTINCT (employee_id, attendance_date)) FILTER (WHERE status = 'on_duty') AS present_days,
              COUNT(DISTINCT attendance_date) AS total_days
       FROM attendance WHERE company_id = $1 AND employee_id = ANY($2::text[]) AND attendance_date >= $3`,
      [companyId, empIds, since30]
    );
    const totalPossible = (rows[0].total_days || 0) * empIds.length;
    attendancePct = totalPossible > 0 ? Math.round((rows[0].present_days / totalPossible) * 1000) / 10 : null;
  }

  const complaints = (await pool.query(
    `SELECT subject, status, requested_at FROM grievances WHERE company_id = $1 AND project = $2 ORDER BY requested_at DESC LIMIT 20`,
    [companyId, project]
  )).rows;

  const tickets = (await pool.query(
    `SELECT category, subject, priority, status, created_at, resolved_at, sla_hours FROM maintenance_tickets
     WHERE company_id = $1 AND project = $2 ORDER BY created_at DESC LIMIT 20`,
    [companyId, project]
  )).rows;

  res.json({ project, deployment, attendance_30d_pct: attendancePct, complaints, tickets });
});

module.exports = router;
