const express = require('express');
const router = express.Router();
const ExcelJS = require('exceljs');
const { pool } = require('../db');
const { verifyAdminOrManager, verifyEmployee } = require('../middleware');
const { effectiveProjects } = require('../projectScope');
const { getCompanySettings, getCompanyBranding, filenameSafe, checkRolePermission } = require('../companySettings');
const { loadShiftThresholdsMap } = require('../attendanceStatus');
const { computeOtHours, loadOtRateMap } = require('../otCalculator');
const { logAction } = require('../auditLog');

function isValidDate(d) {
  return /^\d{4}-\d{2}-\d{2}$/.test(d);
}
function todayDateStr() {
  return new Date().toISOString().slice(0, 10);
}

// ---- admin/manager/coordinator: scan attendance for a date range and (re)compute OT ----
// Idempotent — re-running for the same range just recalculates 'pending' records (never
// touches ones already approved/rejected/paid, so HR decisions are never silently overwritten).
// POST /api/overtime/generate  body: { from, to }
router.post('/generate', verifyAdminOrManager, async (req, res) => {
  const settings = await getCompanySettings(pool, req.user.company_id);
  if (!settings.features.overtime) {
    return res.status(403).json({ error: 'Overtime is not enabled for your company. Contact your admin.' });
  }
  const allowed = await checkRolePermission(pool, req.user.company_id, req.user.role, 'overtime');
  if (!allowed) return res.status(403).json({ error: 'You do not have access to Overtime.' });

  const to = req.body.to || todayDateStr();
  const from = req.body.from || to;
  if (!isValidDate(from) || !isValidDate(to)) {
    return res.status(400).json({ error: 'from/to (YYYY-MM-DD) are required' });
  }
  const companyId = req.user.company_id;
  const projects = await effectiveProjects(req, pool);

  let empQuery = 'SELECT employee_id, project, shift_category FROM employees WHERE active = 1 AND company_id = $1';
  const empParams = [companyId];
  if (projects && projects.length) { empParams.push(projects); empQuery += ` AND project = ANY($${empParams.length}::text[])`; }
  const empResult = await pool.query(empQuery, empParams);
  const employees = empResult.rows;
  if (!employees.length) return res.json({ message: 'No employees in scope', created: 0, updated: 0 });

  const empIds = employees.map(e => e.employee_id);
  const attResult = await pool.query(
    `SELECT employee_id, attendance_date, status, server_time FROM attendance
     WHERE attendance_date >= $1 AND attendance_date <= $2 AND company_id = $3 AND employee_id = ANY($4::text[])`,
    [from, to, companyId, empIds]
  );

  const thresholdsMap = await loadShiftThresholdsMap(pool, companyId);
  const otRateMap = await loadOtRateMap(pool, companyId);

  const punchMap = new Map(); // employee_id|date -> { onDutyTime, offDutyTime }
  attResult.rows.forEach(r => {
    const key = `${r.employee_id}|${r.attendance_date}`;
    if (!punchMap.has(key)) punchMap.set(key, { onDutyTime: null, offDutyTime: null });
    const entry = punchMap.get(key);
    if (r.status === 'on_duty') entry.onDutyTime = r.server_time;
    else if (r.status === 'off_duty') entry.offDutyTime = r.server_time;
  });

  const dates = [];
  const cur = new Date(from + 'T00:00:00Z');
  const end = new Date(to + 'T00:00:00Z');
  while (cur <= end) { dates.push(cur.toISOString().slice(0, 10)); cur.setUTCDate(cur.getUTCDate() + 1); }

  let created = 0, updated = 0, skipped = 0;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const emp of employees) {
      for (const d of dates) {
        const punch = punchMap.get(`${emp.employee_id}|${d}`);
        if (!punch) continue;
        const { workedHours, otHours } = computeOtHours({
          onDutyTime: punch.onDutyTime, offDutyTime: punch.offDutyTime,
          shiftCategory: emp.shift_category, thresholdsMap,
        });
        if (otHours <= 0) continue;

        const rate = otRateMap[emp.shift_category] || 0;
        const amount = Math.round(otHours * rate * 100) / 100;
        const fullHours = (thresholdsMap[emp.shift_category] || {}).full ?? null;

        // Never touch a record HR has already acted on (approved/rejected/paid) — only
        // insert new ones or refresh still-'pending' ones (e.g. a late punch correction).
        const result = await client.query(
          `INSERT INTO overtime_records
             (company_id, employee_id, project, work_date, shift_category, full_hours, worked_hours, ot_hours, rate_per_hour, ot_amount, status)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'pending')
           ON CONFLICT (company_id, employee_id, work_date) DO UPDATE
             SET worked_hours = EXCLUDED.worked_hours, ot_hours = EXCLUDED.ot_hours,
                 rate_per_hour = EXCLUDED.rate_per_hour, ot_amount = EXCLUDED.ot_amount,
                 full_hours = EXCLUDED.full_hours, shift_category = EXCLUDED.shift_category
           WHERE overtime_records.status = 'pending'
           RETURNING (xmax = 0) AS inserted`,
          [companyId, emp.employee_id, emp.project || '', d, emp.shift_category || '', fullHours, workedHours, otHours, rate, amount]
        );
        if (result.rowCount === 0) { skipped++; continue; }
        if (result.rows[0].inserted) created++; else updated++;
      }
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    return res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }

  res.json({ message: `OT calculated for ${from} to ${to}`, created, updated, skipped });
});

// ---- admin/manager/coordinator: list OT records (own project scope, own company) ----
// GET /api/overtime/requests?status=&from=&to=&project=
router.get('/requests', verifyAdminOrManager, async (req, res) => {
  const allowed = await checkRolePermission(pool, req.user.company_id, req.user.role, 'overtime');
  if (!allowed) return res.status(403).json({ error: 'You do not have access to Overtime.' });

  const projects = await effectiveProjects(req, pool);
  const params = [req.user.company_id];
  const conditions = ['o.company_id = $1'];
  if (projects && projects.length) { params.push(projects); conditions.push(`o.project = ANY($${params.length}::text[])`); }
  if (req.query.status) { params.push(req.query.status); conditions.push(`o.status = $${params.length}`); }
  if (req.query.from) { params.push(req.query.from); conditions.push(`o.work_date >= $${params.length}`); }
  if (req.query.to) { params.push(req.query.to); conditions.push(`o.work_date <= $${params.length}`); }

  const { rows } = await pool.query(
    `SELECT o.*, e.name AS employee_name
     FROM overtime_records o
     LEFT JOIN employees e ON e.employee_id = o.employee_id AND e.company_id = o.company_id
     WHERE ${conditions.join(' AND ')}
     ORDER BY o.work_date DESC, o.id DESC`,
    params
  );
  const totalOtAmount = rows.reduce((sum, r) => sum + Number(r.ot_amount || 0), 0);
  res.json({ count: rows.length, totalOtAmount, requests: rows });
});

// ---- admin/manager/coordinator: approve/reject one OT record ----
async function review(req, res, newStatus) {
  const allowed = await checkRolePermission(pool, req.user.company_id, req.user.role, 'overtime');
  if (!allowed) return res.status(403).json({ error: 'You do not have access to Overtime.' });

  const { rows } = await pool.query('SELECT * FROM overtime_records WHERE id = $1 AND company_id = $2', [req.params.id, req.user.company_id]);
  const record = rows[0];
  if (!record) return res.status(404).json({ error: 'OT record not found' });
  if (record.status !== 'pending') return res.status(400).json({ error: `This OT record is already ${record.status}` });

  const projects = await effectiveProjects(req, pool);
  if (projects && projects.length && !projects.includes(record.project)) {
    return res.status(403).json({ error: 'This record is not in your project' });
  }

  await pool.query(
    'UPDATE overtime_records SET status = $1, approved_by = $2, approved_at = NOW() WHERE id = $3 AND company_id = $4',
    [newStatus, req.user.username || req.user.name || req.user.role, req.params.id, req.user.company_id]
  );
  await logAction(req, `overtime_${newStatus}`, {
    targetType: 'overtime_record', targetId: record.id,
    targetLabel: `${record.employee_id} — ${record.work_date} — ${record.ot_hours}h`,
  });
  res.json({ message: `OT ${newStatus}` });
}
router.put('/requests/:id/approve', verifyAdminOrManager, (req, res) => review(req, res, 'approved'));
router.put('/requests/:id/reject', verifyAdminOrManager, (req, res) => review(req, res, 'rejected'));

// ---- admin/manager/coordinator: bulk-approve every currently-pending record in scope ----
// PUT /api/overtime/requests/bulk-approve  body: { ids: [1,2,3] }  (or omit ids to approve all pending in scope)
router.put('/requests/bulk-approve', verifyAdminOrManager, async (req, res) => {
  const allowed = await checkRolePermission(pool, req.user.company_id, req.user.role, 'overtime');
  if (!allowed) return res.status(403).json({ error: 'You do not have access to Overtime.' });

  const projects = await effectiveProjects(req, pool);
  const params = [req.user.username || req.user.name || req.user.role, req.user.company_id];
  let query = `UPDATE overtime_records SET status = 'approved', approved_by = $1, approved_at = NOW()
               WHERE company_id = $2 AND status = 'pending'`;
  if (projects && projects.length) { params.push(projects); query += ` AND project = ANY($${params.length}::text[])`; }
  if (Array.isArray(req.body.ids) && req.body.ids.length) { params.push(req.body.ids); query += ` AND id = ANY($${params.length}::int[])`; }
  query += ' RETURNING id';

  const { rows } = await pool.query(query, params);
  await logAction(req, 'overtime_bulk_approved', { targetType: 'overtime_record', details: `${rows.length} record(s)` });
  res.json({ message: `${rows.length} OT record(s) approved`, approved: rows.length });
});

// ---- admin/manager/coordinator: download an Excel report of OT records ----
router.get('/requests/export/excel', verifyAdminOrManager, async (req, res) => {
  const projects = await effectiveProjects(req, pool);
  const params = [req.user.company_id];
  const conditions = ['o.company_id = $1'];
  if (projects && projects.length) { params.push(projects); conditions.push(`o.project = ANY($${params.length}::text[])`); }
  if (req.query.status) { params.push(req.query.status); conditions.push(`o.status = $${params.length}`); }
  if (req.query.from) { params.push(req.query.from); conditions.push(`o.work_date >= $${params.length}`); }
  if (req.query.to) { params.push(req.query.to); conditions.push(`o.work_date <= $${params.length}`); }

  const { rows } = await pool.query(
    `SELECT o.*, e.name AS employee_name, e.designation
     FROM overtime_records o
     LEFT JOIN employees e ON e.employee_id = o.employee_id AND e.company_id = o.company_id
     WHERE ${conditions.join(' AND ')} ORDER BY o.work_date DESC`,
    params
  );
  const branding = await getCompanyBranding(pool, req.user.company_id);

  const workbook = new ExcelJS.Workbook();
  workbook.creator = branding.name;
  const sheet = workbook.addWorksheet('Overtime');
  sheet.columns = [
    { header: 'Employee ID', key: 'employee_id', width: 14 },
    { header: 'Name', key: 'name', width: 22 },
    { header: 'Project', key: 'project', width: 16 },
    { header: 'Date', key: 'work_date', width: 12 },
    { header: 'Shift Category', key: 'shift_category', width: 16 },
    { header: 'Worked Hrs', key: 'worked_hours', width: 12 },
    { header: 'OT Hrs', key: 'ot_hours', width: 10 },
    { header: 'Rate/Hr', key: 'rate_per_hour', width: 10 },
    { header: 'OT Amount', key: 'ot_amount', width: 12 },
    { header: 'Status', key: 'status', width: 12 },
    { header: 'Approved By', key: 'approved_by', width: 16 },
    { header: 'Approved At', key: 'approved_at', width: 20 },
  ];
  sheet.getRow(1).font = { bold: true };
  sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD9E1F2' } };
  rows.forEach(r => sheet.addRow({
    employee_id: r.employee_id, name: r.employee_name || '', project: r.project || '',
    work_date: r.work_date, shift_category: r.shift_category || '',
    worked_hours: Number(r.worked_hours) || 0, ot_hours: Number(r.ot_hours) || 0,
    rate_per_hour: Number(r.rate_per_hour) || 0, ot_amount: Number(r.ot_amount) || 0,
    status: r.status, approved_by: r.approved_by || '',
    approved_at: r.approved_at ? new Date(r.approved_at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }) : '',
  }));

  const filename = `${filenameSafe(branding.name)}_Overtime_Report.xlsx`;
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  await workbook.xlsx.write(res);
  res.end();
});

// ---- admin only: generate a payment batch — groups every approved+unpaid OT record in
// scope into one bank-upload Excel file (Employee bank a/c, IFSC, amount), and marks those
// records 'paid'. This is the "Option 1" HR-controlled payment flow described in the brief:
// HR reviews/approves OT first, then downloads this file and uploads it to their bank portal
// themselves — no money actually moves through this app. ----
// POST /api/overtime/payment-batch  (admin only — this moves money, so no manager/coordinator)
router.post('/payment-batch', verifyAdminOrManager, async (req, res) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Only an Admin can generate a payment batch' });
  }
  const companyId = req.user.company_id;

  const { rows } = await pool.query(
    `SELECT o.*, e.name AS employee_name, e.bank_account_holder, e.bank_account_number, e.bank_ifsc, e.bank_name
     FROM overtime_records o
     LEFT JOIN employees e ON e.employee_id = o.employee_id AND e.company_id = o.company_id
     WHERE o.company_id = $1 AND o.status = 'approved'
     ORDER BY o.employee_id, o.work_date`,
    [companyId]
  );
  if (!rows.length) return res.status(400).json({ error: 'No approved-and-unpaid OT records to pay out' });

  // Group by employee — one payment line per employee (sum of all their approved OT days),
  // since a bank transfer/NEFT line is per account, not per day.
  const byEmployee = new Map();
  rows.forEach(r => {
    const key = r.employee_id;
    if (!byEmployee.has(key)) {
      byEmployee.set(key, {
        employee_id: r.employee_id, name: r.employee_name || '',
        bank_account_holder: r.bank_account_holder || r.employee_name || '',
        bank_account_number: r.bank_account_number || '', bank_ifsc: r.bank_ifsc || '',
        bank_name: r.bank_name || '', total_hours: 0, total_amount: 0, days: 0, recordIds: [],
      });
    }
    const g = byEmployee.get(key);
    g.total_hours += Number(r.ot_hours) || 0;
    g.total_amount += Number(r.ot_amount) || 0;
    g.days += 1;
    g.recordIds.push(r.id);
  });
  const lines = Array.from(byEmployee.values());

  const missingBank = lines.filter(l => !l.bank_account_number || !l.bank_ifsc);
  if (missingBank.length) {
    return res.status(400).json({
      error: `${missingBank.length} employee(s) are missing bank details and were left out of this batch. ` +
        `Add Account Number + IFSC for them first, then generate the batch again.`,
      missing: missingBank.map(l => ({ employee_id: l.employee_id, name: l.name })),
    });
  }

  const totalAmount = Math.round(lines.reduce((s, l) => s + l.total_amount, 0) * 100) / 100;
  const allRecordIds = lines.flatMap(l => l.recordIds);

  const client = await pool.connect();
  let batchId;
  try {
    await client.query('BEGIN');
    const { rows: batchRows } = await client.query(
      `INSERT INTO payment_batches (company_id, created_by, record_count, total_amount, status)
       VALUES ($1, $2, $3, $4, 'generated') RETURNING id`,
      [companyId, req.user.username || req.user.name || 'admin', allRecordIds.length, totalAmount]
    );
    batchId = batchRows[0].id;
    await client.query(
      `UPDATE overtime_records SET status = 'paid', payment_batch_id = $1 WHERE id = ANY($2::int[]) AND company_id = $3`,
      [batchId, allRecordIds, companyId]
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    return res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }

  await logAction(req, 'overtime_payment_batch_generated', {
    targetType: 'payment_batch', targetId: batchId,
    details: { employees: lines.length, records: allRecordIds.length, totalAmount },
  });

  // Build the bank-upload Excel file — a generic column layout close to what most Indian
  // bank NEFT/RTGS bulk-upload templates expect (Account Holder, Account No, IFSC, Amount,
  // Narration). Exact column names can be tweaked to match a specific bank's template later.
  const branding = await getCompanyBranding(pool, companyId);
  const workbook = new ExcelJS.Workbook();
  workbook.creator = branding.name;
  const sheet = workbook.addWorksheet('Payment Batch');
  sheet.columns = [
    { header: 'Employee ID', key: 'employee_id', width: 14 },
    { header: 'Beneficiary Name', key: 'bank_account_holder', width: 24 },
    { header: 'Account Number', key: 'bank_account_number', width: 20 },
    { header: 'IFSC', key: 'bank_ifsc', width: 14 },
    { header: 'Bank Name', key: 'bank_name', width: 20 },
    { header: 'OT Days', key: 'days', width: 10 },
    { header: 'OT Hours', key: 'total_hours', width: 10 },
    { header: 'Amount (INR)', key: 'total_amount', width: 14 },
    { header: 'Narration', key: 'narration', width: 30 },
  ];
  sheet.getRow(1).font = { bold: true };
  sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD9E1F2' } };
  lines.forEach(l => sheet.addRow({
    employee_id: l.employee_id, bank_account_holder: l.bank_account_holder,
    bank_account_number: l.bank_account_number, bank_ifsc: l.bank_ifsc, bank_name: l.bank_name,
    days: l.days, total_hours: Math.round(l.total_hours * 100) / 100,
    total_amount: Math.round(l.total_amount * 100) / 100,
    narration: `OT Payment - Batch #${batchId}`,
  }));
  sheet.addRow({});
  const totalRow = sheet.addRow({ bank_account_holder: 'TOTAL', total_amount: totalAmount });
  totalRow.font = { bold: true };

  const filename = `${filenameSafe(branding.name)}_OT_Payment_Batch_${batchId}.xlsx`;
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  await workbook.xlsx.write(res);
  res.end();
});

// ---- admin/manager/coordinator: list past payment batches ----
router.get('/payment-batches', verifyAdminOrManager, async (req, res) => {
  const { rows } = await pool.query(
    'SELECT * FROM payment_batches WHERE company_id = $1 ORDER BY created_at DESC',
    [req.user.company_id]
  );
  res.json({ batches: rows });
});

// ---- employee (self) — own OT history + payment status ----
// GET /api/overtime/my/records
router.get('/my/records', verifyEmployee, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT work_date, shift_category, worked_hours, ot_hours, rate_per_hour, ot_amount, status, approved_at
     FROM overtime_records WHERE employee_id = $1 AND company_id = $2 ORDER BY work_date DESC`,
    [req.user.employee_id, req.user.company_id]
  );
  res.json({ records: rows });
});

module.exports = router;
