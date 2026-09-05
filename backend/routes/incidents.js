const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { verifyAdminOrManager, verifyEmployee } = require('../middleware');
const { saveAttachmentAndGetUrl } = require('../fileStorage');
const { effectiveProjects } = require('../projectScope');
const { logAction } = require('../auditLog');

const VALID_CATEGORIES = ['security', 'maintenance', 'safety', 'suspicious_activity', 'property_damage', 'other'];
const VALID_SEVERITIES = ['low', 'medium', 'high'];

// ---- employee (self) — submit an incident/duty report, optional photo ----
// POST /api/incidents  body: { category, description, photo? (base64), severity? }
router.post('/', verifyEmployee, async (req, res) => {
  const category = VALID_CATEGORIES.includes(req.body.category) ? req.body.category : 'other';
  const description = (req.body.description || '').trim();
  const severity = VALID_SEVERITIES.includes(req.body.severity) ? req.body.severity : 'low';
  if (!description) return res.status(400).json({ error: 'Please describe the incident' });

  const { rows: empRows } = await pool.query(
    'SELECT project, site_location_id FROM employees WHERE employee_id = $1 AND company_id = $2',
    [req.user.employee_id, req.user.company_id]
  );
  const emp = empRows[0];

  let photoUrl = null;
  if (req.body.photo) {
    photoUrl = saveAttachmentAndGetUrl(`incident_${req.user.employee_id}`, req.body.photo);
  }

  const { rows } = await pool.query(
    `INSERT INTO incident_reports (company_id, employee_id, project, site_location_id, category, description, photo_url, severity)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
    [req.user.company_id, req.user.employee_id, emp?.project || null, emp?.site_location_id || null, category, description, photoUrl, severity]
  );

  res.json({ message: 'Incident report submitted', id: rows[0].id });
});

// GET /api/incidents/my
router.get('/my', verifyEmployee, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id, category, description, photo_url, severity, status, resolution_note, created_at
     FROM incident_reports WHERE employee_id = $1 AND company_id = $2 ORDER BY created_at DESC LIMIT 100`,
    [req.user.employee_id, req.user.company_id]
  );
  res.json({ reports: rows });
});

// ---- admin/manager — list + review incident reports, scoped to their own projects ----
// GET /api/incidents?status=&project=
router.get('/', verifyAdminOrManager, async (req, res) => {
  const scope = await effectiveProjects(pool, req.user);
  let query = `SELECT ir.*, e.name AS employee_name FROM incident_reports ir
               LEFT JOIN employees e ON e.employee_id = ir.employee_id AND e.company_id = ir.company_id
               WHERE ir.company_id = $1`;
  const params = [req.user.company_id];
  if (scope.restricted) {
    params.push(scope.projects);
    query += ` AND ir.project = ANY($${params.length})`;
  }
  if (req.query.status) {
    params.push(req.query.status);
    query += ` AND ir.status = $${params.length}`;
  }
  if (req.query.project) {
    params.push(req.query.project);
    query += ` AND ir.project = $${params.length}`;
  }
  query += ' ORDER BY ir.created_at DESC LIMIT 500';
  const { rows } = await pool.query(query, params);
  res.json({ reports: rows });
});

// PUT /api/incidents/:id/review  body: { status: 'reviewed'|'resolved', resolution_note? }
router.put('/:id/review', verifyAdminOrManager, async (req, res) => {
  const status = ['reviewed', 'resolved', 'open'].includes(req.body.status) ? req.body.status : 'reviewed';
  const result = await pool.query(
    `UPDATE incident_reports SET status = $1, resolution_note = $2, reviewed_by = $3, reviewed_at = NOW()
     WHERE id = $4 AND company_id = $5`,
    [status, req.body.resolution_note || null, req.user.username || req.user.employee_id || 'admin', req.params.id, req.user.company_id]
  );
  if (result.rowCount === 0) return res.status(404).json({ error: 'Incident report not found' });

  await logAction(req, 'incident_reviewed', { targetType: 'incident_report', targetId: req.params.id, targetLabel: `status → ${status}` });
  res.json({ message: 'Incident report updated' });
});

// ---- admin/manager/coordinator: bulk-update a batch of incident reports in one go ----
// PUT /api/incidents/bulk-review  body: { ids: [1,2,3], status: 'reviewed'|'resolved'|'open', resolution_note? }
router.put('/bulk-review', verifyAdminOrManager, async (req, res) => {
  const ids = Array.isArray(req.body.ids) ? req.body.ids.filter((id) => Number.isInteger(Number(id))) : [];
  const status = ['reviewed', 'resolved', 'open'].includes(req.body.status) ? req.body.status : 'reviewed';
  if (!ids.length) return res.status(400).json({ error: 'ids (array of report ids) is required' });

  const result = await pool.query(
    `UPDATE incident_reports SET status = $1, resolution_note = $2, reviewed_by = $3, reviewed_at = NOW()
     WHERE id = ANY($4::int[]) AND company_id = $5`,
    [status, req.body.resolution_note || null, req.user.username || req.user.employee_id || 'admin', ids, req.user.company_id]
  );

  await logAction(req, 'incident_bulk_reviewed', { targetType: 'incident_report', details: `${result.rowCount} report(s) → ${status}` });
  res.json({ message: `${result.rowCount} incident report(s) updated`, updated: result.rowCount });
});

module.exports = router;
