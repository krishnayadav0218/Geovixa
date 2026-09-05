const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { verifyAdminOrManager } = require('../middleware');
const { effectiveProjects } = require('../projectScope');

function clampDays(raw) {
  const n = Number(raw) || 30;
  return Math.min(Math.max(n, 7), 180);
}

// GET /api/analytics/attendance-trend?days=30
// One point per calendar day: how many distinct employees punched on_duty that day. This is
// the same `attendance` table the Attendance Log tab already reads, just grouped by date —
// no new tracking, purely a different view of existing data.
router.get('/attendance-trend', verifyAdminOrManager, async (req, res) => {
  const days = clampDays(req.query.days);
  const projects = await effectiveProjects(req, pool);
  const params = [req.user.company_id, days];
  let query = `
    SELECT attendance_date AS date, COUNT(DISTINCT employee_id)::int AS present_count
    FROM attendance
    WHERE company_id = $1 AND status = 'on_duty'
      AND attendance_date >= TO_CHAR(NOW() - ($2 || ' days')::interval, 'YYYY-MM-DD')`;
  if (projects && projects.length) {
    params.push(projects);
    query += ` AND employee_id IN (SELECT employee_id FROM employees WHERE company_id = $1 AND project = ANY($${params.length}::text[]))`;
  }
  query += ' GROUP BY attendance_date ORDER BY attendance_date ASC';

  const { rows } = await pool.query(query, params);
  res.json({ days, points: rows });
});

// GET /api/analytics/overtime-cost-trend?days=30
// One point per calendar day: total ot_amount recorded (any status) for that work_date —
// lets Ops see cost building up day by day rather than only the single lifetime total shown
// on the Overtime tab today.
router.get('/overtime-cost-trend', verifyAdminOrManager, async (req, res) => {
  const days = clampDays(req.query.days);
  const projects = await effectiveProjects(req, pool);
  const params = [req.user.company_id, days];
  let query = `
    SELECT work_date AS date, COALESCE(SUM(ot_amount), 0)::float AS total_amount
    FROM overtime_records
    WHERE company_id = $1 AND work_date >= TO_CHAR(NOW() - ($2 || ' days')::interval, 'YYYY-MM-DD')`;
  if (projects && projects.length) {
    params.push(projects);
    query += ` AND project = ANY($${params.length}::text[])`;
  }
  query += ' GROUP BY work_date ORDER BY work_date ASC';

  const { rows } = await pool.query(query, params);
  res.json({ days, points: rows });
});

// GET /api/analytics/project-cost-comparison?days=30
// One bar per project: total OT cost for that project over the window — the most direct
// "which site is costing the most in overtime" comparison the existing OT data supports.
router.get('/project-cost-comparison', verifyAdminOrManager, async (req, res) => {
  const days = clampDays(req.query.days);
  const projects = await effectiveProjects(req, pool);
  const params = [req.user.company_id, days];
  let query = `
    SELECT COALESCE(project, 'Unassigned') AS project, COALESCE(SUM(ot_amount), 0)::float AS total_amount
    FROM overtime_records
    WHERE company_id = $1 AND work_date >= TO_CHAR(NOW() - ($2 || ' days')::interval, 'YYYY-MM-DD')`;
  if (projects && projects.length) {
    params.push(projects);
    query += ` AND project = ANY($${params.length}::text[])`;
  }
  query += ' GROUP BY project ORDER BY total_amount DESC LIMIT 15';

  const { rows } = await pool.query(query, params);
  res.json({ days, projects: rows });
});

module.exports = router;
