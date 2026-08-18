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

module.exports = router;
