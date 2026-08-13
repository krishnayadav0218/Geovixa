const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { verifyAdminOrManager, verifyEmployee } = require('../middleware');
const { effectiveProjects } = require('../projectScope');
const { getCompanySettings, checkRolePermission } = require('../companySettings');
const { logAction } = require('../auditLog');

const AUDIENCES = ['all', 'project', 'staff'];

// ---- admin/manager (per role_permissions): broadcast an announcement ----
// POST /api/announcements  body: { title, message, audience, project?, pinned? }
router.post('/', verifyAdminOrManager, async (req, res) => {
  const settings = await getCompanySettings(pool, req.user.company_id);
  if (!settings.features.announcements) return res.status(403).json({ error: 'Announcements are not enabled for your company.' });
  const allowed = await checkRolePermission(pool, req.user.company_id, req.user.role, 'announcements');
  if (!allowed) return res.status(403).json({ error: 'You do not have access to Announcements.' });

  const title = (req.body.title || '').trim();
  const message = (req.body.message || '').trim();
  const audience = AUDIENCES.includes(req.body.audience) ? req.body.audience : 'all';
  const project = audience === 'project' ? (req.body.project || '').trim() : null;

  if (!title || !message) return res.status(400).json({ error: 'title and message are required' });
  if (audience === 'project' && !project) return res.status(400).json({ error: 'project is required when audience is "project"' });

  if (project) {
    const scopeProjects = await effectiveProjects(req, pool);
    if (scopeProjects && scopeProjects.length && !scopeProjects.includes(project)) {
      return res.status(403).json({ error: 'This site is not in your project' });
    }
  }

  const { rows } = await pool.query(
    `INSERT INTO announcements (company_id, title, message, audience, project, pinned, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [req.user.company_id, title, message, audience, project, req.body.pinned ? 1 : 0, req.user.username || req.user.role]
  );
  await logAction(req, 'announcement_posted', { targetType: 'announcement', targetId: rows[0].id, targetLabel: title });
  res.json({ message: 'Announcement posted', id: rows[0].id });
});

// ---- admin/manager/coordinator: list all announcements (management view) ----
router.get('/', verifyAdminOrManager, async (req, res) => {
  const { rows } = await pool.query(
    'SELECT * FROM announcements WHERE company_id = $1 ORDER BY pinned DESC, created_at DESC LIMIT 100',
    [req.user.company_id]
  );
  res.json({ announcements: rows });
});

router.delete('/:id', verifyAdminOrManager, async (req, res) => {
  const result = await pool.query('DELETE FROM announcements WHERE id = $1 AND company_id = $2', [req.params.id, req.user.company_id]);
  if (result.rowCount === 0) return res.status(404).json({ error: 'Announcement not found' });
  res.json({ message: 'Announcement removed' });
});

// ---- employee: see announcements relevant to them (all + their own project) ----
router.get('/my', verifyEmployee, async (req, res) => {
  const { rows: empRows } = await pool.query('SELECT project FROM employees WHERE employee_id = $1 AND company_id = $2', [req.user.employee_id, req.user.company_id]);
  const project = empRows[0] ? empRows[0].project : null;

  const { rows } = await pool.query(
    `SELECT id, title, message, audience, project, pinned, created_at FROM announcements
     WHERE company_id = $1 AND (audience = 'all' OR (audience = 'project' AND project = $2))
     ORDER BY pinned DESC, created_at DESC LIMIT 50`,
    [req.user.company_id, project]
  );
  res.json({ announcements: rows });
});

module.exports = router;
