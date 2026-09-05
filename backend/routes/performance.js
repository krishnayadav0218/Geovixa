const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { verifyAdminOrManager } = require('../middleware');
const { effectiveProjects } = require('../projectScope');
const { loadShiftThresholdsMap, getThresholds } = require('../attendanceStatus');

// Composite 0-100 score per employee over the last 30 days:
//   Attendance   (0-50 pts): days present ÷ working days in range
//   Punctuality  (0-30 pts): of the days present, how many had a FULL day's hours (not half)
//   Conduct      (0-20 pts): -5 per grievance raised about them... this system's grievances
//                            are raised BY an employee, not about one, so conduct instead
//                            uses -10 per SOS/incident in the window as a very light signal,
//                            floor 0 (most employees will simply have 20/20 here)
// >=85 Excellent, >=70 Good, >=50 Average, else Needs Improvement.
function scoreCategory(score) {
  if (score >= 85) return 'Excellent';
  if (score >= 70) return 'Good';
  if (score >= 50) return 'Average';
  return 'Needs Improvement';
}

// GET /api/performance?project=&days=30
router.get('/', verifyAdminOrManager, async (req, res) => {
  const companyId = req.user.company_id;
  const days = Math.min(Number(req.query.days) || 30, 90);
  const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  const scopeProjects = await effectiveProjects(req, pool);

  let empQuery = 'SELECT employee_id, name, project, designation, shift_category FROM employees WHERE company_id = $1 AND active = 1';
  const empParams = [companyId];
  if (req.query.project) { empParams.push(req.query.project); empQuery += ` AND project = $${empParams.length}`; }
  if (scopeProjects && scopeProjects.length) { empParams.push(scopeProjects); empQuery += ` AND project = ANY($${empParams.length}::text[])`; }
  const employees = (await pool.query(empQuery, empParams)).rows;
  if (!employees.length) return res.json({ count: 0, employees: [] });
  const empIds = employees.map(e => e.employee_id);

  // Every day's punches in range, grouped so we can compute worked-hours per employee per day.
  const attRows = (await pool.query(
    `SELECT employee_id, attendance_date, status, server_time FROM attendance
     WHERE company_id = $1 AND employee_id = ANY($2::text[]) AND attendance_date >= $3
     ORDER BY employee_id, attendance_date, server_time`,
    [companyId, empIds, since]
  )).rows;
  const thresholdsMap = await loadShiftThresholdsMap(pool, companyId);

  // Group into { employee_id: { date: { onDutyTime, offDutyTime } } }
  const byEmpDate = new Map();
  attRows.forEach(r => {
    const key = r.employee_id;
    if (!byEmpDate.has(key)) byEmpDate.set(key, new Map());
    const dateMap = byEmpDate.get(key);
    if (!dateMap.has(r.attendance_date)) dateMap.set(r.attendance_date, {});
    const entry = dateMap.get(r.attendance_date);
    if (r.status === 'on_duty') entry.onDutyTime = r.server_time;
    else if (r.status === 'off_duty') entry.offDutyTime = r.server_time;
  });

  // SOS alerts in window, as the light "conduct" signal.
  const sosRows = (await pool.query(
    `SELECT employee_id, COUNT(*)::int AS c FROM sos_alerts
     WHERE company_id = $1 AND employee_id = ANY($2::text[]) AND created_at >= $3 GROUP BY employee_id`,
    [companyId, empIds, since]
  )).rows;
  const sosMap = new Map(sosRows.map(r => [r.employee_id, r.c]));

  // Working days in range = distinct calendar days elapsed (weekends/holidays aren't tracked
  // separately in this system, so this is "days since X" — a simple, consistent denominator
  // rather than a false precision about which days were actually scheduled).
  const workingDays = days;

  const results = employees.map(e => {
    const dateMap = byEmpDate.get(e.employee_id) || new Map();
    const presentDays = dateMap.size;
    let fullDays = 0;
    dateMap.forEach((entry, date) => {
      if (entry.onDutyTime && entry.offDutyTime) {
        const workedHours = (new Date(entry.offDutyTime) - new Date(entry.onDutyTime)) / 36e5;
        const { full } = getThresholds(e.shift_category, thresholdsMap) || { full: 8 };
        if (workedHours >= full) fullDays++;
      }
    });

    const attendanceScore = Math.min(1, presentDays / workingDays) * 50;
    const punctualityScore = presentDays > 0 ? (fullDays / presentDays) * 30 : 0;
    const sosCount = sosMap.get(e.employee_id) || 0;
    const conductScore = Math.max(0, 20 - sosCount * 10);

    const score = Math.round(attendanceScore + punctualityScore + conductScore);
    return {
      employee_id: e.employee_id, name: e.name, project: e.project, designation: e.designation,
      attendance_pct: Math.round((presentDays / workingDays) * 100),
      present_days: presentDays, working_days: workingDays,
      on_time_pct: presentDays > 0 ? Math.round((fullDays / presentDays) * 100) : 0,
      absences: Math.max(0, workingDays - presentDays),
      sos_count: sosCount,
      score, category: scoreCategory(score),
    };
  }).sort((a, b) => b.score - a.score);

  res.json({ count: results.length, days, employees: results });
});

// ---------------------------------------------------------------------------------------
// MANAGER REVIEWS — qualitative rating + free-text feedback, additive to (never replacing)
// the auto-computed score above. A manager can only be reviewing employees within their own
// project scope, same as everywhere else in this file.
// ---------------------------------------------------------------------------------------

// POST /api/performance/reviews  body: { employee_id, period_label, rating (1-5), strengths?, areas_to_improve?, feedback? }
router.post('/reviews', verifyAdminOrManager, async (req, res) => {
  const { employee_id, period_label, rating, strengths, areas_to_improve, feedback } = req.body;
  if (!employee_id || !period_label) return res.status(400).json({ error: 'employee_id and period_label are required' });
  const ratingNum = Number(rating);
  if (!Number.isInteger(ratingNum) || ratingNum < 1 || ratingNum > 5) {
    return res.status(400).json({ error: 'rating must be a whole number from 1 to 5' });
  }

  const companyId = req.user.company_id;
  const scopeProjects = await effectiveProjects(req, pool);
  const empCheckParams = [employee_id, companyId];
  let empCheckQuery = 'SELECT employee_id, project FROM employees WHERE employee_id = $1 AND company_id = $2';
  if (scopeProjects && scopeProjects.length) { empCheckParams.push(scopeProjects); empCheckQuery += ` AND project = ANY($${empCheckParams.length}::text[])`; }
  const empCheck = await pool.query(empCheckQuery, empCheckParams);
  if (!empCheck.rows.length) return res.status(404).json({ error: 'Employee not found or outside your assigned project scope' });

  const { rows } = await pool.query(
    `INSERT INTO performance_reviews (company_id, employee_id, period_label, rating, strengths, areas_to_improve, feedback, reviewed_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id, created_at`,
    [companyId, employee_id, period_label.trim(), ratingNum, strengths || null, areas_to_improve || null, feedback || null, req.user.username || req.user.employee_id || 'manager']
  );

  res.json({ message: 'Review saved', id: rows[0].id, created_at: rows[0].created_at });
});

// GET /api/performance/reviews?employee_id=EMP001   — full review history for one employee
// GET /api/performance/reviews                       — every review in scope, most recent first
router.get('/reviews', verifyAdminOrManager, async (req, res) => {
  const companyId = req.user.company_id;
  const scopeProjects = await effectiveProjects(req, pool);
  const params = [companyId];
  let query = `
    SELECT pr.id, pr.employee_id, e.name AS employee_name, pr.period_label, pr.rating,
           pr.strengths, pr.areas_to_improve, pr.feedback, pr.reviewed_by, pr.created_at
    FROM performance_reviews pr
    LEFT JOIN employees e ON e.employee_id = pr.employee_id AND e.company_id = pr.company_id
    WHERE pr.company_id = $1`;
  if (req.query.employee_id) { params.push(req.query.employee_id); query += ` AND pr.employee_id = $${params.length}`; }
  if (scopeProjects && scopeProjects.length) { params.push(scopeProjects); query += ` AND e.project = ANY($${params.length}::text[])`; }
  query += ' ORDER BY pr.created_at DESC LIMIT 200';

  const { rows } = await pool.query(query, params);
  res.json({ count: rows.length, reviews: rows });
});

module.exports = router;
