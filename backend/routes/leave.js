const express = require('express');
const router = express.Router();
const ExcelJS = require('exceljs');
const { pool } = require('../db');
const { verifyAdminOrManager, verifyEmployee } = require('../middleware');
const { saveAttachmentAndGetUrl } = require('../fileStorage');
const { effectiveProjects } = require('../projectScope');

function isValidDate(d) {
  return /^\d{4}-\d{2}-\d{2}$/.test(d);
}

// Inclusive day count between two YYYY-MM-DD calendar-date strings (UTC, no time component
// — same reasoning as the isWeekday() helpers elsewhere in this codebase).
function daysInclusive(from, to) {
  const f = new Date(from + 'T00:00:00Z');
  const t = new Date(to + 'T00:00:00Z');
  return Math.round((t - f) / 86400000) + 1;
}

// ---- employee (self) — raise a leave application: date range + reason + optional attachment ----
// POST /api/leave/my/request  body: { from_date, to_date, reason, attachment? (base64 data URI) }
router.post('/my/request', verifyEmployee, async (req, res) => {
  const from_date = (req.body.from_date || '').trim();
  const to_date = (req.body.to_date || '').trim();
  const reason = (req.body.reason || '').trim();
  const attachment = req.body.attachment || null;

  if (!isValidDate(from_date) || !isValidDate(to_date)) {
    return res.status(400).json({ error: 'from_date and to_date (YYYY-MM-DD) are required' });
  }
  if (to_date < from_date) {
    return res.status(400).json({ error: '"To Date" cannot be before "From Date"' });
  }
  if (!reason) {
    return res.status(400).json({ error: 'Please enter a reason for the leave' });
  }

  const { rows } = await pool.query('SELECT * FROM employees WHERE employee_id = $1', [req.user.employee_id]);
  const emp = rows[0];
  if (!emp) return res.status(404).json({ error: 'Employee not found' });

  let attachmentUrl = null;
  try {
    attachmentUrl = saveAttachmentAndGetUrl(emp.employee_id, attachment);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  await pool.query(
    `INSERT INTO leave_requests (employee_id, from_date, to_date, reason, attachment_url, project, status)
     VALUES ($1, $2, $3, $4, $5, $6, 'pending')`,
    [emp.employee_id, from_date, to_date, reason, attachmentUrl, emp.project || '']
  );
  res.json({ message: 'Leave application submitted. It will be reviewed by your admin/coordinator.' });
});

// ---- employee (self) — list own past leave applications + statuses ----
// GET /api/leave/my/requests
router.get('/my/requests', verifyEmployee, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id, from_date, to_date, reason, attachment_url, status, requested_at, reviewed_at, reviewed_by
     FROM leave_requests WHERE employee_id = $1 ORDER BY requested_at DESC`,
    [req.user.employee_id]
  );
  res.json({ requests: rows });
});

// ---- admin/manager/coordinator: list leave applications, scoped to their own project(s)
// (admin sees every project unless ?project=/?status= is passed to narrow it down) ----
// Same project-scoping behaviour as Salary Slip Requests — a manager/coordinator only ever
// sees (and can act on) their own project's leave requests; admin can see/filter everything.
// GET /api/leave/requests?status=pending&project=MTDC
router.get('/requests', verifyAdminOrManager, async (req, res) => {
  const projects = await effectiveProjects(req, pool);
  const params = [];
  const conditions = [];

  if (projects && projects.length) {
    params.push(projects);
    conditions.push(`r.project = ANY($${params.length}::text[])`);
  }
  if (req.query.status) { params.push(req.query.status); conditions.push(`r.status = $${params.length}`); }

  let query = `
    SELECT r.id, r.employee_id, r.from_date, r.to_date, r.reason, r.attachment_url, r.project, r.status,
           r.requested_at, r.reviewed_at, r.reviewed_by, e.name AS employee_name, e.designation AS employee_designation
    FROM leave_requests r
    LEFT JOIN employees e ON e.employee_id = r.employee_id
  `;
  if (conditions.length) query += ' WHERE ' + conditions.join(' AND ');
  query += ' ORDER BY r.requested_at DESC';

  const { rows } = await pool.query(query, params);
  res.json({ count: rows.length, requests: rows });
});

// ---- admin/manager/coordinator: approve/reject a leave application (only within their own
// project scope — same lock as Salary Slip Requests) ----
async function reviewRequest(req, res, newStatus) {
  const { rows } = await pool.query('SELECT * FROM leave_requests WHERE id = $1', [req.params.id]);
  const request = rows[0];
  if (!request) return res.status(404).json({ error: 'Request not found' });

  const projects = await effectiveProjects(req, pool);
  if (projects && projects.length && !projects.includes(request.project)) {
    return res.status(403).json({ error: 'This request is not in your project' });
  }

  await pool.query(
    'UPDATE leave_requests SET status = $1, reviewed_at = NOW(), reviewed_by = $2 WHERE id = $3',
    [newStatus, req.user.username || req.user.name || req.user.role, req.params.id]
  );
  res.json({ message: `Leave application ${newStatus}` });
}
router.put('/requests/:id/approve', verifyAdminOrManager, (req, res) => reviewRequest(req, res, 'approved'));
router.put('/requests/:id/reject', verifyAdminOrManager, (req, res) => reviewRequest(req, res, 'rejected'));

// ---- admin/manager/coordinator: download an Excel report of leave applications ----
// Same project scoping as GET /requests above, plus the same optional status filter, plus
// an optional from/to date range filtered against the application's own from_date.
// GET /api/leave/requests/export/excel?status=&project=&from=&to=
router.get('/requests/export/excel', verifyAdminOrManager, async (req, res) => {
  const projects = await effectiveProjects(req, pool);
  const params = [];
  const conditions = [];
  if (projects && projects.length) {
    params.push(projects);
    conditions.push(`r.project = ANY($${params.length}::text[])`);
  }
  if (req.query.status) { params.push(req.query.status); conditions.push(`r.status = $${params.length}`); }
  if (req.query.from) { params.push(req.query.from); conditions.push(`r.from_date >= $${params.length}`); }
  if (req.query.to) { params.push(req.query.to); conditions.push(`r.from_date <= $${params.length}`); }

  let query = `
    SELECT r.employee_id, e.name AS employee_name, r.project, r.from_date, r.to_date, r.reason,
           r.attachment_url, r.status, r.requested_at, r.reviewed_at, r.reviewed_by
    FROM leave_requests r
    LEFT JOIN employees e ON e.employee_id = r.employee_id
  `;
  if (conditions.length) query += ' WHERE ' + conditions.join(' AND ');
  query += ' ORDER BY r.requested_at DESC';

  const { rows } = await pool.query(query, params);

  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Geovixa';
  const sheet = workbook.addWorksheet('Leave Requests');

  sheet.columns = [
    { header: 'Employee ID', key: 'employee_id', width: 14 },
    { header: 'Name', key: 'name', width: 22 },
    { header: 'Project', key: 'project', width: 16 },
    { header: 'From Date', key: 'from_date', width: 12 },
    { header: 'To Date', key: 'to_date', width: 12 },
    { header: 'Days', key: 'days', width: 8 },
    { header: 'Reason', key: 'reason', width: 34 },
    { header: 'Attachment', key: 'attachment', width: 30 },
    { header: 'Status', key: 'status', width: 12 },
    { header: 'Requested At', key: 'requested_at', width: 20 },
    { header: 'Reviewed At', key: 'reviewed_at', width: 20 },
    { header: 'Reviewed By', key: 'reviewed_by', width: 16 },
  ];
  sheet.getRow(1).font = { bold: true };
  sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD9E1F2' } };

  rows.forEach(r => {
    sheet.addRow({
      employee_id: r.employee_id,
      name: r.employee_name || '',
      project: r.project || '',
      from_date: r.from_date,
      to_date: r.to_date,
      days: daysInclusive(r.from_date, r.to_date),
      reason: r.reason || '',
      attachment: r.attachment_url ? `${req.protocol}://${req.get('host')}${r.attachment_url}` : '',
      status: r.status,
      requested_at: r.requested_at ? new Date(r.requested_at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }) : '',
      reviewed_at: r.reviewed_at ? new Date(r.reviewed_at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }) : '',
      reviewed_by: r.reviewed_by || '',
    });
  });

  const filename = `Geovixa_Leave_Requests_Report.xlsx`;
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  await workbook.xlsx.write(res);
  res.end();
});

module.exports = router;
