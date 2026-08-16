const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { verifyAdminOrManager, verifyEmployee } = require('../middleware');
const { effectiveProjects } = require('../projectScope');
const { getCompanySettings, checkRolePermission } = require('../companySettings');
const { logAction } = require('../auditLog');

const SOS_TYPES = ['accident', 'medical', 'fire', 'security', 'other'];

// ---- employee: press SOS ----
// POST /api/sos  body: { type, latitude?, longitude?, note? }
router.post('/', verifyEmployee, async (req, res) => {
  const settings = await getCompanySettings(pool, req.user.company_id);
  if (!settings.features.sos) return res.status(403).json({ error: 'SOS is not enabled for your company.' });

  const type = SOS_TYPES.includes(req.body.type) ? req.body.type : 'other';
  const { rows: empRows } = await pool.query('SELECT project FROM employees WHERE employee_id = $1 AND company_id = $2', [req.user.employee_id, req.user.company_id]);
  const project = empRows[0] ? empRows[0].project : null;

  const { rows } = await pool.query(
    `INSERT INTO sos_alerts (company_id, employee_id, project, type, latitude, longitude, note, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'open') RETURNING id`,
    [req.user.company_id, req.user.employee_id, project, type,
      req.body.latitude != null ? Number(req.body.latitude) : null,
      req.body.longitude != null ? Number(req.body.longitude) : null,
      (req.body.note || '').trim() || null]
  );
  // SOS is urgent by nature — log it into the regular audit trail too, not just its own table,
  // so it shows up alongside everything else an admin might be reviewing.
  await logAction(req, 'sos_raised', { targetType: 'sos_alert', targetId: rows[0].id, targetLabel: `${req.user.employee_id} — ${type}` });
  res.json({ message: 'SOS sent. Help is on the way.', id: rows[0].id });
});

// ---- employee: see their own past SOS alerts ----
router.get('/my', verifyEmployee, async (req, res) => {
  const { rows } = await pool.query(
    'SELECT * FROM sos_alerts WHERE employee_id = $1 AND company_id = $2 ORDER BY created_at DESC',
    [req.user.employee_id, req.user.company_id]
  );
  res.json({ alerts: rows });
});

// ---- admin/manager/coordinator: live feed of SOS alerts (own project scope) ----
// GET /api/sos?status=open
router.get('/', verifyAdminOrManager, async (req, res) => {
  const allowed = await checkRolePermission(pool, req.user.company_id, req.user.role, 'sos');
  if (!allowed) return res.status(403).json({ error: 'You do not have access to SOS alerts.' });

  const projects = await effectiveProjects(req, pool);
  const params = [req.user.company_id];
  const conditions = ['s.company_id = $1'];
  if (projects && projects.length) { params.push(projects); conditions.push(`s.project = ANY($${params.length}::text[])`); }
  if (req.query.status) { params.push(req.query.status); conditions.push(`s.status = $${params.length}`); }

  const { rows } = await pool.query(
    `SELECT s.*, e.name AS employee_name, e.phone AS employee_phone
     FROM sos_alerts s LEFT JOIN employees e ON e.employee_id = s.employee_id AND e.company_id = s.company_id
     WHERE ${conditions.join(' AND ')} ORDER BY s.created_at DESC LIMIT 200`,
    params
  );
  const openCount = rows.filter(r => r.status === 'open').length;
  res.json({ count: rows.length, openCount, alerts: rows });
});

// ---- admin/manager/coordinator: acknowledge / resolve ----
router.put('/:id/acknowledge', verifyAdminOrManager, async (req, res) => {
  const { rows } = await pool.query(
    "UPDATE sos_alerts SET status = 'acknowledged', acknowledged_by = $1, acknowledged_at = NOW() WHERE id = $2 AND company_id = $3 AND status = 'open' RETURNING id",
    [req.user.username || req.user.role, req.params.id, req.user.company_id]
  );
  if (!rows.length) return res.status(400).json({ error: 'Alert not found or already acknowledged' });
  await logAction(req, 'sos_acknowledged', { targetType: 'sos_alert', targetId: req.params.id });
  res.json({ message: 'Alert acknowledged' });
});

router.put('/:id/resolve', verifyAdminOrManager, async (req, res) => {
  const { rows } = await pool.query(
    "UPDATE sos_alerts SET status = 'resolved', resolution_note = $1, resolved_at = NOW() WHERE id = $2 AND company_id = $3 RETURNING id",
    [(req.body.resolution_note || '').trim() || null, req.params.id, req.user.company_id]
  );
  if (!rows.length) return res.status(404).json({ error: 'Alert not found' });
  await logAction(req, 'sos_resolved', { targetType: 'sos_alert', targetId: req.params.id });
  res.json({ message: 'Alert resolved' });
});

module.exports = router;
