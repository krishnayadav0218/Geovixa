const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { verifyAdminOrManager, verifyEmployee } = require('../middleware');
const { effectiveProjects } = require('../projectScope');
const { getCompanySettings, checkRolePermission } = require('../companySettings');
const { logAction } = require('../auditLog');

const CATEGORIES = ['electrical', 'plumbing', 'hvac', 'civil', 'carpentry', 'fire_safety', 'equipment', 'other'];
const PRIORITIES = ['low', 'medium', 'high', 'critical'];
// open -> assigned -> in_progress -> resolved -> verified -> closed
const STATUS_FLOW = ['open', 'assigned', 'in_progress', 'resolved', 'verified', 'closed'];

async function requireFeature(req, res) {
  const settings = await getCompanySettings(pool, req.user.company_id);
  if (!settings.features.maintenance) {
    res.status(403).json({ error: 'Maintenance Management is not enabled for your company. Contact your admin.' });
    return false;
  }
  const allowed = await checkRolePermission(pool, req.user.company_id, req.user.role, 'maintenance');
  if (!allowed) {
    res.status(403).json({ error: 'You do not have access to Maintenance Management.' });
    return false;
  }
  return true;
}

// ---- admin/manager/coordinator: raise a ticket (a supervisor spotting an issue) ----
// POST /api/maintenance  body: { project, category, subject, description?, priority?, sla_hours? }
router.post('/', verifyAdminOrManager, async (req, res) => {
  if (!(await requireFeature(req, res))) return;

  const project = (req.body.project || '').trim();
  const category = (req.body.category || '').trim();
  const subject = (req.body.subject || '').trim();
  const priority = PRIORITIES.includes(req.body.priority) ? req.body.priority : 'medium';

  if (!project || !subject) return res.status(400).json({ error: 'project and subject are required' });
  if (category && !CATEGORIES.includes(category)) {
    return res.status(400).json({ error: `category must be one of: ${CATEGORIES.join(', ')}` });
  }

  const projects = await effectiveProjects(req, pool);
  if (projects && projects.length && !projects.includes(project)) {
    return res.status(403).json({ error: 'This site is not in your project' });
  }

  // Default SLA target comes from the site's own sla_hours (Site Management) unless overridden.
  let slaHours = req.body.sla_hours ? Number(req.body.sla_hours) : null;
  if (!slaHours) {
    const { rows } = await pool.query('SELECT sla_hours FROM projects WHERE company_id = $1 AND name = $2', [req.user.company_id, project]);
    slaHours = rows[0] ? Number(rows[0].sla_hours) : 24;
  }

  const { rows: inserted } = await pool.query(
    `INSERT INTO maintenance_tickets (company_id, project, category, subject, description, priority, sla_hours, raised_by, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'open') RETURNING id`,
    [req.user.company_id, project, category || 'other', subject, (req.body.description || '').trim() || null,
      priority, slaHours, req.user.username || req.user.role]
  );
  await logAction(req, 'maintenance_ticket_raised', { targetType: 'maintenance_ticket', targetId: inserted[0].id, targetLabel: subject });
  res.json({ message: 'Ticket raised', id: inserted[0].id });
});

// ---- list tickets (own project scope), with SLA-breach flag computed live ----
// GET /api/maintenance?status=&project=&priority=
router.get('/', verifyAdminOrManager, async (req, res) => {
  if (!(await requireFeature(req, res))) return;

  const projects = await effectiveProjects(req, pool);
  const params = [req.user.company_id];
  const conditions = ['company_id = $1'];
  if (projects && projects.length) { params.push(projects); conditions.push(`project = ANY($${params.length}::text[])`); }
  if (req.query.status) { params.push(req.query.status); conditions.push(`status = $${params.length}`); }
  if (req.query.project) { params.push(req.query.project); conditions.push(`project = $${params.length}`); }
  if (req.query.priority) { params.push(req.query.priority); conditions.push(`priority = $${params.length}`); }

  const { rows } = await pool.query(
    `SELECT * FROM maintenance_tickets WHERE ${conditions.join(' AND ')} ORDER BY created_at DESC`,
    params
  );
  const now = Date.now();
  const withSla = rows.map(t => {
    const openSince = new Date(t.created_at).getTime();
    const stillOpen = !['resolved', 'verified', 'closed'].includes(t.status);
    const hoursOpen = (now - openSince) / 36e5;
    const slaBreached = stillOpen && t.sla_hours != null && hoursOpen > Number(t.sla_hours);
    return { ...t, sla_breached: slaBreached, hours_open: Math.round(hoursOpen * 10) / 10 };
  });
  res.json({ count: withSla.length, tickets: withSla });
});

// ---- advance a ticket through the workflow ----
// PUT /api/maintenance/:id/assign  body: { assigned_technician }
router.put('/:id/assign', verifyAdminOrManager, async (req, res) => {
  if (!(await requireFeature(req, res))) return;
  const technician = (req.body.assigned_technician || '').trim();
  if (!technician) return res.status(400).json({ error: 'assigned_technician is required' });

  const { rows } = await pool.query('UPDATE maintenance_tickets SET status = $1, assigned_technician = $2, assigned_at = NOW() WHERE id = $3 AND company_id = $4 RETURNING id',
    ['assigned', technician, req.params.id, req.user.company_id]);
  if (!rows.length) return res.status(404).json({ error: 'Ticket not found' });
  await logAction(req, 'maintenance_ticket_assigned', { targetType: 'maintenance_ticket', targetId: req.params.id, targetLabel: technician });
  res.json({ message: 'Ticket assigned' });
});

// PUT /api/maintenance/:id/status  body: { status: 'in_progress'|'resolved'|'verified'|'closed', resolution_note? }
router.put('/:id/status', verifyAdminOrManager, async (req, res) => {
  if (!(await requireFeature(req, res))) return;
  const newStatus = req.body.status;
  if (!STATUS_FLOW.includes(newStatus)) return res.status(400).json({ error: `status must be one of: ${STATUS_FLOW.join(', ')}` });

  const timestampCol = { resolved: 'resolved_at', verified: 'verified_at', closed: 'closed_at' }[newStatus];
  const fields = ['status = $1'];
  const params = [newStatus];
  if (req.body.resolution_note) { params.push(req.body.resolution_note.trim()); fields.push(`resolution_note = $${params.length}`); }
  if (timestampCol) { fields.push(`${timestampCol} = NOW()`); }
  params.push(req.params.id, req.user.company_id);

  const { rows } = await pool.query(
    `UPDATE maintenance_tickets SET ${fields.join(', ')} WHERE id = $${params.length - 1} AND company_id = $${params.length} RETURNING id`,
    params
  );
  if (!rows.length) return res.status(404).json({ error: 'Ticket not found' });
  await logAction(req, 'maintenance_ticket_status_changed', { targetType: 'maintenance_ticket', targetId: req.params.id, targetLabel: newStatus });
  res.json({ message: `Ticket marked ${newStatus}` });
});

module.exports = router;
