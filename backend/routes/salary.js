const express = require('express');
const router = express.Router();
const PDFDocument = require('pdfkit');
const { pool } = require('../db');
const { verifyAdmin, verifyAdminOrManager, verifyEmployee } = require('../middleware');
const { computeDayStatus, loadShiftThresholdsMap, loadWeeklyOffMap } = require('../attendanceStatus');
const { effectiveProjects } = require('../projectScope');

// A date string (YYYY-MM-DD) falls on the given weekday (0=Sun..6=Sat)? Checked in UTC —
// same reasoning as export.js: these are plain calendar-date strings, not real timestamps.
function isWeekday(dateStr, weekday) {
  return new Date(dateStr + 'T00:00:00Z').getUTCDay() === weekday;
}

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

// Current calendar month (YYYY-MM) in India Standard Time — same +5:30 shift trick used in
// routes/attendance.js's todayDateStr(), so "this month" lines up with what employees in
// India actually consider the current month, regardless of the server's own timezone.
function currentIstMonth() {
  const ist = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
  return `${ist.getUTCFullYear()}-${String(ist.getUTCMonth() + 1).padStart(2, '0')}`;
}

// The last `n` months (YYYY-MM), most recent first, counting back from the current IST
// month inclusive. Used to cap how far back an employee can request a salary slip for.
function lastNMonths(n) {
  const [y, m] = currentIstMonth().split('-').map(Number);
  const months = [];
  for (let i = 0; i < n; i++) {
    const d = new Date(Date.UTC(y, m - 1 - i, 1));
    months.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`);
  }
  return months;
}

// month: 'YYYY-MM'. Returns { year, monthNum, daysInMonth, from, to }.
function monthRange(month) {
  const [year, monthNum] = month.split('-').map(Number);
  const daysInMonth = new Date(Date.UTC(year, monthNum, 0)).getUTCDate();
  const from = `${month}-01`;
  const to = `${month}-${String(daysInMonth).padStart(2, '0')}`;
  return { year, monthNum, daysInMonth, from, to };
}

// Builds the full salary slip for one employee for one calendar month — attendance summary
// (P/HD/A/W-O/-) day by day using the exact same rules as the Reports grid/Excel exports
// (see attendanceStatus.js), then prorates the fixed monthly salary components by how many
// of those days were actually payable.
//   payableDays = full-present days + (half days x 0.5) + weekly-off days (paid, not deducted)
//   ratio       = payableDays / daysInMonth
//   earned Basic/HRA/Allowances = each fixed component x ratio
//   deductions are NOT prorated — treated as a fixed monthly deduction (e.g. PF/ESIC)
//   netPay = earnedGross - deductions
// This is a standard, simplified payroll convention — admins can adjust the fixed monthly
// components (Basic/HRA/Allowances/Deductions) any time from the Employees tab.
async function buildSalarySlip(employee, month) {
  const { daysInMonth, from, to } = monthRange(month);

  const [salResult, attResult, thresholdsMap, weeklyOffMap] = await Promise.all([
    pool.query('SELECT * FROM salaries WHERE employee_id = $1', [employee.employee_id]),
    pool.query(
      'SELECT attendance_date, status, server_time FROM attendance WHERE employee_id = $1 AND attendance_date >= $2 AND attendance_date <= $3',
      [employee.employee_id, from, to]
    ),
    loadShiftThresholdsMap(pool),
    loadWeeklyOffMap(pool),
  ]);

  const sal = salResult.rows[0] || { basic_salary: 0, hra: 0, other_allowances: 0, deductions: 0, pf: 0, esic: 0 };
  const offDay = weeklyOffMap[employee.project] ?? 0;

  // group punches by date, same pattern as the grid/export endpoints
  const punchMap = new Map();
  attResult.rows.forEach(r => {
    if (!punchMap.has(r.attendance_date)) punchMap.set(r.attendance_date, { onDutyTime: null, offDutyTime: null });
    const entry = punchMap.get(r.attendance_date);
    if (r.status === 'on_duty') entry.onDutyTime = r.server_time;
    else if (r.status === 'off_duty') entry.offDutyTime = r.server_time;
  });

  let totalP = 0, totalHD = 0, totalA = 0, totalWO = 0, totalNA = 0;
  for (let day = 1; day <= daysInMonth; day++) {
    const d = `${month}-${String(day).padStart(2, '0')}`;
    const joined = !(employee.doj && d < employee.doj);
    const punch = punchMap.get(d) || { onDutyTime: null, offDutyTime: null };
    const status = computeDayStatus({
      onDutyTime: punch.onDutyTime,
      offDutyTime: punch.offDutyTime,
      shiftCategory: employee.shift_category,
      isWeeklyOff: isWeekday(d, offDay),
      joined,
      thresholdsMap,
    });
    if (status === 'P') totalP++;
    else if (status === 'HD') totalHD++;
    else if (status === 'A') totalA++;
    else if (status === 'W/O') totalWO++;
    else totalNA++; // '-' — before Date of Joining
  }

  const payableDays = totalP + totalHD * 0.5 + totalWO;
  const ratio = daysInMonth > 0 ? payableDays / daysInMonth : 0;

  const basic = round2(sal.basic_salary);
  const hra = round2(sal.hra);
  const otherAllowances = round2(sal.other_allowances);
  const otherDeductions = round2(sal.deductions);
  const pf = round2(sal.pf);
  const esic = round2(sal.esic);
  const totalDeductions = round2(otherDeductions + pf + esic);

  const earnedBasic = round2(basic * ratio);
  const earnedHra = round2(hra * ratio);
  const earnedAllowances = round2(otherAllowances * ratio);
  const earnedGross = round2(earnedBasic + earnedHra + earnedAllowances);
  const netPay = round2(earnedGross - totalDeductions);

  return {
    employee_id: employee.employee_id,
    name: employee.name,
    designation: employee.designation || '',
    project: employee.project || '',
    month,
    daysInMonth,
    attendance: { present: totalP, halfDay: totalHD, absent: totalA, weeklyOff: totalWO, notApplicable: totalNA, payableDays },
    salaryStructure: { basic, hra, otherAllowances, deductions: otherDeductions, pf, esic },
    earnings: { basic: earnedBasic, hra: earnedHra, otherAllowances: earnedAllowances, grossEarned: earnedGross },
    // `deductions` stays the TOTAL (other + pf + esic) for backward compatibility with
    // anything that just reads slip.deductions; deductionsBreakdown gives the split.
    deductions: totalDeductions,
    deductionsBreakdown: { other: otherDeductions, pf, esic, total: totalDeductions },
    netPay,
  };
}

function streamSlipPdf(res, slip) {
  const filename = `Salary_Slip_${slip.employee_id}_${slip.month}.pdf`;
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

  const doc = new PDFDocument({ size: 'A4', margin: 50 });
  doc.pipe(res);

  // ---- header ----
  doc.fillColor('#071A2C').fontSize(20).font('Helvetica-Bold').text('Krystal Connect', { align: 'left' });
  doc.fontSize(11).font('Helvetica').fillColor('#64748B').text('Salary Slip', { align: 'left' });
  doc.moveDown(0.3);
  doc.fillColor('#0B93D6').fontSize(12).font('Helvetica-Bold')
    .text(`For the month of ${slip.month}`, { align: 'left' });
  doc.moveDown(1);
  doc.strokeColor('#E3E8EF').lineWidth(1).moveTo(50, doc.y).lineTo(545, doc.y).stroke();
  doc.moveDown(0.8);

  // ---- employee details ----
  doc.fillColor('#0F1720').fontSize(11).font('Helvetica-Bold').text('Employee Details');
  doc.moveDown(0.3);
  doc.font('Helvetica').fontSize(10);
  const detailRows = [
    ['Employee ID', slip.employee_id],
    ['Name', slip.name],
    ['Designation', slip.designation || '-'],
    ['Project', slip.project || '-'],
  ];
  detailRows.forEach(([label, value]) => {
    doc.fillColor('#64748B').text(label, 50, doc.y, { continued: true, width: 150 });
    doc.fillColor('#0F1720').text('  ' + value);
  });
  doc.moveDown(1);

  // ---- attendance summary ----
  doc.fillColor('#0F1720').fontSize(11).font('Helvetica-Bold').text('Attendance Summary');
  doc.moveDown(0.3);
  doc.font('Helvetica').fontSize(10).fillColor('#0F1720');
  const a = slip.attendance;
  doc.text(
    `Days in Month: ${slip.daysInMonth}    Present: ${a.present}    Half Day: ${a.halfDay}    Absent: ${a.absent}    Weekly Off: ${a.weeklyOff}    Payable Days: ${a.payableDays}`
  );
  doc.moveDown(1);

  // ---- earnings / deductions table ----
  doc.fillColor('#0F1720').fontSize(11).font('Helvetica-Bold').text('Earnings & Deductions');
  doc.moveDown(0.4);

  const tableTop = doc.y;
  const col1 = 50, col2 = 320, colWidth = 175;
  doc.font('Helvetica-Bold').fontSize(10);
  doc.fillColor('#64748B').text('Component', col1, tableTop);
  doc.text('Amount (Rs.)', col2, tableTop, { width: colWidth, align: 'right' });
  doc.moveDown(0.4);
  doc.strokeColor('#E3E8EF').moveTo(50, doc.y).lineTo(545, doc.y).stroke();
  doc.moveDown(0.4);

  doc.font('Helvetica').fontSize(10).fillColor('#0F1720');
  const rows = [
    ['Basic Salary (earned)', slip.earnings.basic],
    ['HRA (earned)', slip.earnings.hra],
    ['Other Allowances (earned)', slip.earnings.otherAllowances],
  ];
  rows.forEach(([label, amount]) => {
    const y = doc.y;
    doc.text(label, col1, y);
    doc.text(amount.toFixed(2), col2, y, { width: colWidth, align: 'right' });
    doc.moveDown(0.5);
  });

  doc.font('Helvetica-Bold');
  let y = doc.y;
  doc.text('Gross Earned', col1, y);
  doc.text(slip.earnings.grossEarned.toFixed(2), col2, y, { width: colWidth, align: 'right' });
  doc.moveDown(0.5);

  doc.font('Helvetica').fillColor('#DC2626');
  const db = slip.deductionsBreakdown || { other: slip.deductions, pf: 0, esic: 0, total: slip.deductions };
  const deductionRows = [
    ['Other Deductions', db.other],
    ['PF', db.pf],
    ['ESIC', db.esic],
  ];
  deductionRows.forEach(([label, amount]) => {
    const dy = doc.y;
    doc.text(label, col1, dy);
    doc.text((Number(amount) || 0).toFixed(2), col2, dy, { width: colWidth, align: 'right' });
    doc.moveDown(0.5);
  });
  doc.font('Helvetica-Bold').fillColor('#DC2626');
  y = doc.y;
  doc.text('Total Deductions', col1, y);
  doc.text(db.total.toFixed(2), col2, y, { width: colWidth, align: 'right' });
  doc.moveDown(0.6);

  doc.strokeColor('#E3E8EF').moveTo(50, doc.y).lineTo(545, doc.y).stroke();
  doc.moveDown(0.5);

  doc.font('Helvetica-Bold').fontSize(12).fillColor('#0B93D6');
  y = doc.y;
  doc.text('Net Pay', col1, y);
  doc.text(`Rs. ${slip.netPay.toFixed(2)}`, col2, y, { width: colWidth, align: 'right' });

  doc.moveDown(2);
  doc.font('Helvetica').fontSize(8).fillColor('#94A3B8')
    .text('This is a system-generated salary slip and does not require a signature.', 50, doc.y, { align: 'center', width: 495 });

  doc.end();
}

// ---- employee (self) — the last 3 months they're allowed to request a slip for ----
// GET /api/salary/my/requestable-months
router.get('/my/requestable-months', verifyEmployee, (req, res) => {
  res.json({ months: lastNMonths(3) });
});

// ---- employee (self) — list of their own past requests + statuses ----
// GET /api/salary/my/slip-requests
router.get('/my/slip-requests', verifyEmployee, async (req, res) => {
  const { rows } = await pool.query(
    'SELECT id, month, status, requested_at, reviewed_at FROM salary_slip_requests WHERE employee_id = $1 ORDER BY month DESC',
    [req.user.employee_id]
  );
  res.json({ requests: rows });
});

// ---- employee (self) — raise a request for a given month's salary slip ----
// The employee can no longer view/download a slip directly; a request has to be raised
// here first, then approved by their project's coordinator (or a manager/admin) before
// the slip becomes viewable. Capped to the last 3 months so old requests can't pile up.
// POST /api/salary/my/slip-request  body: { month: 'YYYY-MM' }
router.post('/my/slip-request', verifyEmployee, async (req, res) => {
  const month = (req.body.month || '').trim();
  if (!month || !/^\d{4}-\d{2}$/.test(month)) return res.status(400).json({ error: 'month=YYYY-MM is required' });

  if (!lastNMonths(3).includes(month)) {
    return res.status(400).json({ error: 'You can only request a salary slip for the last 3 months' });
  }

  const { rows } = await pool.query('SELECT * FROM employees WHERE employee_id = $1', [req.user.employee_id]);
  const emp = rows[0];
  if (!emp) return res.status(404).json({ error: 'Employee not found' });

  try {
    await pool.query(
      `INSERT INTO salary_slip_requests (employee_id, month, project, status)
       VALUES ($1, $2, $3, 'pending')`,
      [emp.employee_id, month, emp.project || '']
    );
    res.json({ message: `Request raised for ${month}. It will be reviewed by your project's coordinator.` });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'You already have a request for this month — check its status below.' });
    }
    res.status(500).json({ error: err.message });
  }
});

// Small helper shared by the two "my slip" routes below — looks up the request for this
// employee+month and turns its status into a clear message when it isn't approved yet.
async function requireApprovedRequest(employeeId, month) {
  const { rows } = await pool.query(
    'SELECT status FROM salary_slip_requests WHERE employee_id = $1 AND month = $2',
    [employeeId, month]
  );
  const status = rows[0] && rows[0].status;
  if (status === 'approved') return { ok: true };
  if (status === 'pending') return { ok: false, error: "Your request for this month is still pending your coordinator's approval." };
  if (status === 'rejected') return { ok: false, error: 'Your request for this month was rejected by your coordinator.' };
  return { ok: false, error: 'Please raise a request for this month first — your coordinator needs to approve it before you can view the slip.' };
}

// ---- employee (self) — view own computed salary slip for a month ----
// GET /api/salary/my/slip?month=YYYY-MM
// IMPORTANT: this must be registered before the generic '/:employeeId/slip' route below,
// otherwise Express would match "my" as an employeeId and wrongly require admin/manager auth.
router.get('/my/slip', verifyEmployee, async (req, res) => {
  const month = req.query.month;
  if (!month || !/^\d{4}-\d{2}$/.test(month)) return res.status(400).json({ error: 'month=YYYY-MM query param is required' });

  const approval = await requireApprovedRequest(req.user.employee_id, month);
  if (!approval.ok) return res.status(403).json({ error: approval.error });

  const { rows } = await pool.query('SELECT * FROM employees WHERE employee_id = $1', [req.user.employee_id]);
  const emp = rows[0];
  if (!emp) return res.status(404).json({ error: 'Employee not found' });

  const slip = await buildSalarySlip(emp, month);
  res.json({ slip });
});

// ---- employee (self) — download own salary slip PDF ----
// GET /api/salary/my/slip/pdf?month=YYYY-MM
router.get('/my/slip/pdf', verifyEmployee, async (req, res) => {
  const month = req.query.month;
  if (!month || !/^\d{4}-\d{2}$/.test(month)) return res.status(400).json({ error: 'month=YYYY-MM query param is required' });

  const approval = await requireApprovedRequest(req.user.employee_id, month);
  if (!approval.ok) return res.status(403).json({ error: approval.error });

  const { rows } = await pool.query('SELECT * FROM employees WHERE employee_id = $1', [req.user.employee_id]);
  const emp = rows[0];
  if (!emp) return res.status(404).json({ error: 'Employee not found' });

  const slip = await buildSalarySlip(emp, month);
  streamSlipPdf(res, slip);
});

// ---- admin/manager/coordinator: list salary slip requests, scoped to their own project(s)
// (admin sees every project unless ?project=/?status= is passed to narrow it down) ----
// GET /api/salary/requests?status=pending
router.get('/requests', verifyAdminOrManager, async (req, res) => {
  const projects = await effectiveProjects(req, pool);
  const params = [];
  const conditions = [];

  if (projects && projects.length) {
    params.push(projects);
    conditions.push(`r.project = ANY($${params.length}::text[])`);
  }
  if (req.query.status) {
    params.push(req.query.status);
    conditions.push(`r.status = $${params.length}`);
  }

  let query = `
    SELECT r.id, r.employee_id, r.month, r.project, r.status, r.requested_at, r.reviewed_at, r.reviewed_by,
           e.name AS employee_name
    FROM salary_slip_requests r
    LEFT JOIN employees e ON e.employee_id = r.employee_id
  `;
  if (conditions.length) query += ' WHERE ' + conditions.join(' AND ');
  query += ' ORDER BY r.requested_at DESC';

  const { rows } = await pool.query(query, params);
  res.json({ count: rows.length, requests: rows });
});

// ---- admin/manager/coordinator: approve/reject a request (only within their own project scope) ----
async function reviewRequest(req, res, newStatus) {
  const { rows } = await pool.query('SELECT * FROM salary_slip_requests WHERE id = $1', [req.params.id]);
  const request = rows[0];
  if (!request) return res.status(404).json({ error: 'Request not found' });

  const projects = await effectiveProjects(req, pool);
  if (projects && projects.length && !projects.includes(request.project)) {
    return res.status(403).json({ error: 'This request is not in your project' });
  }

  await pool.query(
    'UPDATE salary_slip_requests SET status = $1, reviewed_at = NOW(), reviewed_by = $2 WHERE id = $3',
    [newStatus, req.user.username || req.user.name || req.user.role, req.params.id]
  );
  res.json({ message: `Request ${newStatus}` });
}

router.put('/requests/:id/approve', verifyAdminOrManager, (req, res) => reviewRequest(req, res, 'approved'));
router.put('/requests/:id/reject', verifyAdminOrManager, (req, res) => reviewRequest(req, res, 'rejected'));

// ---- admin/manager: view an employee's fixed monthly salary structure ----
router.get('/:employeeId', verifyAdminOrManager, async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM salaries WHERE employee_id = $1', [req.params.employeeId.trim()]);
  const sal = rows[0] || { employee_id: req.params.employeeId.trim(), basic_salary: 0, hra: 0, other_allowances: 0, deductions: 0, pf: 0, esic: 0 };
  res.json({ salary: sal });
});

// ---- admin only: set/update an employee's fixed monthly salary structure ----
router.put('/:employeeId', verifyAdmin, async (req, res) => {
  const employeeId = req.params.employeeId.trim();
  const { basic_salary, hra, other_allowances, deductions, pf, esic } = req.body;

  const empResult = await pool.query('SELECT employee_id FROM employees WHERE employee_id = $1', [employeeId]);
  if (!empResult.rows[0]) return res.status(404).json({ error: 'Employee not found' });

  await pool.query(
    `INSERT INTO salaries (employee_id, basic_salary, hra, other_allowances, deductions, pf, esic, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
     ON CONFLICT (employee_id) DO UPDATE SET
       basic_salary = EXCLUDED.basic_salary,
       hra = EXCLUDED.hra,
       other_allowances = EXCLUDED.other_allowances,
       deductions = EXCLUDED.deductions,
       pf = EXCLUDED.pf,
       esic = EXCLUDED.esic,
       updated_at = NOW()`,
    [employeeId, Number(basic_salary) || 0, Number(hra) || 0, Number(other_allowances) || 0, Number(deductions) || 0, Number(pf) || 0, Number(esic) || 0]
  );
  res.json({ message: 'Salary structure updated' });
});

// ---- admin/manager: view any employee's computed salary slip for a month ----
// GET /api/salary/:employeeId/slip?month=YYYY-MM
router.get('/:employeeId/slip', verifyAdminOrManager, async (req, res) => {
  const month = req.query.month;
  if (!month || !/^\d{4}-\d{2}$/.test(month)) return res.status(400).json({ error: 'month=YYYY-MM query param is required' });

  const { rows } = await pool.query('SELECT * FROM employees WHERE employee_id = $1', [req.params.employeeId.trim()]);
  const emp = rows[0];
  if (!emp) return res.status(404).json({ error: 'Employee not found' });

  const slip = await buildSalarySlip(emp, month);
  res.json({ slip });
});

// ---- admin/manager: download any employee's salary slip PDF ----
router.get('/:employeeId/slip/pdf', verifyAdminOrManager, async (req, res) => {
  const month = req.query.month;
  if (!month || !/^\d{4}-\d{2}$/.test(month)) return res.status(400).json({ error: 'month=YYYY-MM query param is required' });

  const { rows } = await pool.query('SELECT * FROM employees WHERE employee_id = $1', [req.params.employeeId.trim()]);
  const emp = rows[0];
  if (!emp) return res.status(404).json({ error: 'Employee not found' });

  const slip = await buildSalarySlip(emp, month);
  streamSlipPdf(res, slip);
});

// exposed for testing only — server.js just does app.use('/api/salary', salaryRoutes),
// which still works fine since Router is a function and this is an extra property on it.
router.buildSalarySlip = buildSalarySlip;

module.exports = router;
