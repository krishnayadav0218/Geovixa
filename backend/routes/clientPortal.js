const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { verifyClient } = require('../middleware');
const PDFDocument = require('pdfkit');

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

// ---------------------------------------------------------------------------------------
// MONTHLY SLA REPORT — a summarized, auto-computed report per site per calendar month:
// attendance %, shortage days (days where present headcount < required_manpower),
// incidents logged, complaints raised/resolved, maintenance tickets. Previously a client
// had no single monthly summary — only the live "today" detail view above.
// ---------------------------------------------------------------------------------------
async function buildMonthlyReport(companyId, project, month) {
  const [year, mon] = month.split('-').map(Number);
  const fromDate = `${month}-01`;
  const toDate = new Date(year, mon, 0).toISOString().slice(0, 10); // last day of month

  const requiredRow = (await pool.query(
    'SELECT required_manpower FROM projects WHERE company_id = $1 AND name = $2',
    [companyId, project]
  )).rows[0];
  const requiredManpower = requiredRow?.required_manpower || 0;

  const empIds = (await pool.query(
    'SELECT employee_id FROM employees WHERE company_id = $1 AND project = $2',
    [companyId, project]
  )).rows.map(r => r.employee_id);

  let attendancePct = null;
  let shortageDays = 0;
  if (empIds.length) {
    const { rows } = await pool.query(
      `SELECT COUNT(DISTINCT (employee_id, attendance_date)) FILTER (WHERE status = 'on_duty') AS present_days,
              COUNT(DISTINCT attendance_date) AS total_days
       FROM attendance WHERE company_id = $1 AND employee_id = ANY($2::text[]) AND attendance_date BETWEEN $3 AND $4`,
      [companyId, empIds, fromDate, toDate]
    );
    const totalPossible = (rows[0].total_days || 0) * empIds.length;
    attendancePct = totalPossible > 0 ? Math.round((rows[0].present_days / totalPossible) * 1000) / 10 : null;

    if (requiredManpower > 0) {
      const dayCounts = (await pool.query(
        `SELECT attendance_date, COUNT(DISTINCT employee_id)::int AS present
         FROM attendance WHERE company_id = $1 AND employee_id = ANY($2::text[]) AND status = 'on_duty'
           AND attendance_date BETWEEN $3 AND $4
         GROUP BY attendance_date`,
        [companyId, empIds, fromDate, toDate]
      )).rows;
      shortageDays = dayCounts.filter(d => d.present < requiredManpower).length;
    }
  }

  const incidentCount = (await pool.query(
    `SELECT COUNT(*)::int AS c FROM incident_reports WHERE company_id = $1 AND project = $2 AND created_at::date BETWEEN $3 AND $4`,
    [companyId, project, fromDate, toDate]
  )).rows[0].c;

  const complaints = (await pool.query(
    `SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE status = 'resolved')::int AS resolved
     FROM grievances WHERE company_id = $1 AND project = $2 AND requested_at::date BETWEEN $3 AND $4`,
    [companyId, project, fromDate, toDate]
  )).rows[0];

  const tickets = (await pool.query(
    `SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE status = 'resolved')::int AS resolved
     FROM maintenance_tickets WHERE company_id = $1 AND project = $2 AND created_at::date BETWEEN $3 AND $4`,
    [companyId, project, fromDate, toDate]
  )).rows[0];

  return {
    project, month, required_manpower: requiredManpower,
    attendance_pct: attendancePct, shortage_days: shortageDays,
    incidents: incidentCount,
    complaints_total: complaints.total, complaints_resolved: complaints.resolved,
    tickets_total: tickets.total, tickets_resolved: tickets.resolved,
  };
}

// GET /api/client-portal/sites/:project/report?month=YYYY-MM
router.get('/sites/:project/report', verifyClient, async (req, res) => {
  const project = req.params.project;
  if (!clientSites(req).includes(project)) return res.status(403).json({ error: 'This site is not assigned to your account' });
  const month = req.query.month || new Date().toISOString().slice(0, 7);
  const report = await buildMonthlyReport(req.user.company_id, project, month);
  res.json(report);
});

// GET /api/client-portal/sites/:project/report/pdf?month=YYYY-MM
router.get('/sites/:project/report/pdf', verifyClient, async (req, res) => {
  const project = req.params.project;
  if (!clientSites(req).includes(project)) return res.status(403).json({ error: 'This site is not assigned to your account' });
  const month = req.query.month || new Date().toISOString().slice(0, 7);
  const report = await buildMonthlyReport(req.user.company_id, project, month);

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="SLA_Report_${project}_${month}.pdf"`);
  const doc = new PDFDocument({ size: 'A4', margin: 50 });
  doc.pipe(res);

  doc.fillColor('#071A2C').fontSize(20).font('Helvetica-Bold').text('Monthly SLA Report');
  doc.fontSize(11).font('Helvetica').fillColor('#64748B').text(`${project} — ${month}`);
  doc.moveDown(1);
  doc.strokeColor('#E3E8EF').lineWidth(1).moveTo(50, doc.y).lineTo(545, doc.y).stroke();
  doc.moveDown(1);

  const rows = [
    ['Attendance %', report.attendance_pct !== null ? `${report.attendance_pct}%` : 'N/A'],
    ['Required Manpower', String(report.required_manpower)],
    ['Days with Shortage', String(report.shortage_days)],
    ['Incidents Logged', String(report.incidents)],
    ['Complaints Raised', String(report.complaints_total)],
    ['Complaints Resolved', String(report.complaints_resolved)],
    ['Maintenance Tickets Raised', String(report.tickets_total)],
    ['Maintenance Tickets Resolved', String(report.tickets_resolved)],
  ];
  doc.font('Helvetica').fontSize(11);
  rows.forEach(([label, value]) => {
    doc.fillColor('#64748B').text(label, 50, doc.y, { continued: true, width: 260 });
    doc.fillColor('#0F1720').font('Helvetica-Bold').text(value);
    doc.font('Helvetica');
    doc.moveDown(0.5);
  });

  doc.end();
});

module.exports = router;
