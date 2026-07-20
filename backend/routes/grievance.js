const express = require('express');
const router = express.Router();
const ExcelJS = require('exceljs');
const { pool } = require('../db');
const { verifyAdminOrManager, verifyEmployee } = require('../middleware');
const { saveAttachmentAndGetUrl } = require('../fileStorage');
const { effectiveProjects } = require('../projectScope');

const VALID_CATEGORIES = [
  'Salary/Payment Issue',
  'Attendance Issue',
  'Work Environment',
  'Harassment/Misconduct',
  'Equipment/Facility',
  'Other',
];

// ---- employee (self) — raise a grievance/complaint: category + subject + description +
// optional attachment (screenshot/photo proof) ----
// POST /api/grievance/my/submit  body: { category, subject, description, attachment? (base64 data URI) }
router.post('/my/submit', verifyEmployee, async (req, res) => {
  const category = (req.body.category || '').trim();
  const subject = (req.body.subject || '').trim();
  const description = (req.body.description || '').trim();
  const attachment = req.body.attachment || null;

  if (!VALID_CATEGORIES.includes(category)) {
    return res.status(400).json({ error: 'Please select a valid category' });
  }
  if (!subject) {
    return res.status(400).json({ error: 'Please enter a short subject' });
  }
  if (!description) {
    return res.status(400).json({ error: 'Please describe the problem' });
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
    `INSERT INTO grievances (employee_id, project, category, subject, description, attachment_url, status)
     VALUES ($1, $2, $3, $4, $5, $6, 'pending')`,
    [emp.employee_id, emp.project || '', category, subject, description, attachmentUrl]
  );
  res.json({ message: 'Your complaint has been submitted. Your admin/coordinator will review it shortly.' });
});

// ---- employee (self) — list own past grievances + statuses ----
// GET /api/grievance/my/list
router.get('/my/list', verifyEmployee, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id, category, subject, description, attachment_url, status, resolution_note,
            requested_at, reviewed_at, reviewed_by
     FROM grievances WHERE employee_id = $1 ORDER BY requested_at DESC`,
    [req.user.employee_id]
  );
  res.json({ requests: rows });
});

// ---- admin/manager/coordinator: list grievances, scoped to their own project(s) — same
// project-scoping behaviour as Leave Requests / Salary Slip Requests ----
// GET /api/grievance/list?status=pending&category=&project=MTDC
router.get('/list', verifyAdminOrManager, async (req, res) => {
  const projects = await effectiveProjects(req, pool);
  const params = [];
  const conditions = [];

  if (projects && projects.length) {
    params.push(projects);
    conditions.push(`g.project = ANY($${params.length}::text[])`);
  }
  if (req.query.status) { params.push(req.query.status); conditions.push(`g.status = $${params.length}`); }
  if (req.query.category) { params.push(req.query.category); conditions.push(`g.category = $${params.length}`); }

  let query = `
    SELECT g.id, g.employee_id, g.project, g.category, g.subject, g.description, g.attachment_url,
           g.status, g.resolution_note, g.requested_at, g.reviewed_at, g.reviewed_by,
           e.name AS employee_name, e.designation AS employee_designation
    FROM grievances g
    LEFT JOIN employees e ON e.employee_id = g.employee_id
  `;
  if (conditions.length) query += ' WHERE ' + conditions.join(' AND ');
  query += ' ORDER BY g.requested_at DESC';

  const { rows } = await pool.query(query, params);
  res.json({ count: rows.length, requests: rows });
});

// ---- admin/manager/coordinator: move a grievance to in_review / resolved / rejected, with
// an optional resolution note visible to the employee (only within their own project scope —
// same lock as Leave Requests / Salary Slip Requests) ----
async function reviewGrievance(req, res, newStatus) {
  const { rows } = await pool.query('SELECT * FROM grievances WHERE id = $1', [req.params.id]);
  const grievance = rows[0];
  if (!grievance) return res.status(404).json({ error: 'Complaint not found' });

  const projects = await effectiveProjects(req, pool);
  if (projects && projects.length && !projects.includes(grievance.project)) {
    return res.status(403).json({ error: 'This complaint is not in your project' });
  }

  const note = (req.body && req.body.resolution_note) ? req.body.resolution_note.trim() : null;

  await pool.query(
    'UPDATE grievances SET status = $1, reviewed_at = NOW(), reviewed_by = $2, resolution_note = COALESCE($3, resolution_note) WHERE id = $4',
    [newStatus, req.user.username || req.user.name || req.user.role, note, req.params.id]
  );
  res.json({ message: `Complaint marked as ${newStatus.replace('_', ' ')}` });
}
router.put('/:id/in-review', verifyAdminOrManager, (req, res) => reviewGrievance(req, res, 'in_review'));
router.put('/:id/resolve', verifyAdminOrManager, (req, res) => reviewGrievance(req, res, 'resolved'));
router.put('/:id/reject', verifyAdminOrManager, (req, res) => reviewGrievance(req, res, 'rejected'));

// ---- admin/manager/coordinator: download an Excel report of grievances ----
// GET /api/grievance/export/excel?status=&category=&project=
router.get('/export/excel', verifyAdminOrManager, async (req, res) => {
  const projects = await effectiveProjects(req, pool);
  const params = [];
  const conditions = [];
  if (projects && projects.length) {
    params.push(projects);
    conditions.push(`g.project = ANY($${params.length}::text[])`);
  }
  if (req.query.status) { params.push(req.query.status); conditions.push(`g.status = $${params.length}`); }
  if (req.query.category) { params.push(req.query.category); conditions.push(`g.category = $${params.length}`); }

  let query = `
    SELECT g.employee_id, e.name AS employee_name, g.project, g.category, g.subject, g.description,
           g.attachment_url, g.status, g.resolution_note, g.requested_at, g.reviewed_at, g.reviewed_by
    FROM grievances g
    LEFT JOIN employees e ON e.employee_id = g.employee_id
  `;
  if (conditions.length) query += ' WHERE ' + conditions.join(' AND ');
  query += ' ORDER BY g.requested_at DESC';

  const { rows } = await pool.query(query, params);

  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Krystal Connect';
  const sheet = workbook.addWorksheet('Grievances');

  sheet.columns = [
    { header: 'Employee ID', key: 'employee_id', width: 14 },
    { header: 'Name', key: 'name', width: 22 },
    { header: 'Project', key: 'project', width: 16 },
    { header: 'Category', key: 'category', width: 22 },
    { header: 'Subject', key: 'subject', width: 26 },
    { header: 'Description', key: 'description', width: 40 },
    { header: 'Attachment', key: 'attachment', width: 30 },
    { header: 'Status', key: 'status', width: 12 },
    { header: 'Resolution Note', key: 'resolution_note', width: 30 },
    { header: 'Submitted At', key: 'requested_at', width: 20 },
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
      category: r.category,
      subject: r.subject,
      description: r.description || '',
      attachment: r.attachment_url ? `${req.protocol}://${req.get('host')}${r.attachment_url}` : '',
      status: r.status,
      resolution_note: r.resolution_note || '',
      requested_at: r.requested_at ? new Date(r.requested_at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }) : '',
      reviewed_at: r.reviewed_at ? new Date(r.reviewed_at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }) : '',
      reviewed_by: r.reviewed_by || '',
    });
  });

  const filename = `Krystal_Connect_Grievances_Report.xlsx`;
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  await workbook.xlsx.write(res);
  res.end();
});

module.exports = router;
