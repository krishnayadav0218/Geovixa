const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { verifyAdmin, verifyAdminOrManager, verifyReports } = require('../middleware');
const { listGroups } = require('../projectGroups');

// admin + manager/coordinator/report-only-role can see the list (needed to populate
// dropdowns/filters/pills)
router.get('/', verifyReports, async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM projects ORDER BY name ASC');
  res.json({ count: rows.length, projects: rows });
});

// GET /api/projects/groups -> distinct Group Names currently in use + their member projects,
// admin only (used to power the "existing groups" suggestions in Manage Projects)
router.get('/groups', verifyAdmin, async (req, res) => {
  const groups = await listGroups(pool);
  res.json({ count: groups.length, groups });
});

// only admin can add/edit/remove projects
router.post('/', verifyAdmin, async (req, res) => {
  const { name, weekly_off_day, group_name } = req.body;
  if (!name || !name.trim()) {
    return res.status(400).json({ error: 'Project name is required' });
  }
  const offDay = weekly_off_day !== undefined && weekly_off_day !== null && weekly_off_day !== ''
    ? Number(weekly_off_day)
    : 0;
  if (!Number.isInteger(offDay) || offDay < 0 || offDay > 6) {
    return res.status(400).json({ error: 'Weekly off day must be 0 (Sunday) through 6 (Saturday)' });
  }
  try {
    await pool.query(
      'INSERT INTO projects (name, weekly_off_day, group_name) VALUES ($1, $2, $3)',
      [name.trim(), offDay, (group_name || '').trim() || null]
    );
    res.json({ message: 'Project added successfully' });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'This project already exists' });
    }
    res.status(500).json({ error: err.message });
  }
});

// admin can fully edit a project — rename it, change its weekly off day, and/or set/clear
// (group / ungroup) its Group Name. Renaming cascades to every place the old name is stored
// (employees.project, admins.project for Manager/Coordinator accounts, salary_slip_requests)
// so nothing is left pointing at a name that no longer exists.
router.put('/:id', verifyAdmin, async (req, res) => {
  const { name, weekly_off_day, group_name } = req.body;
  const { rows } = await pool.query('SELECT * FROM projects WHERE id = $1', [req.params.id]);
  const existing = rows[0];
  if (!existing) return res.status(404).json({ error: 'Project not found' });

  let offDay = existing.weekly_off_day;
  if (weekly_off_day !== undefined && weekly_off_day !== null && weekly_off_day !== '') {
    offDay = Number(weekly_off_day);
    if (!Number.isInteger(offDay) || offDay < 0 || offDay > 6) {
      return res.status(400).json({ error: 'Weekly off day must be 0 (Sunday) through 6 (Saturday)' });
    }
  }

  const newName = (name !== undefined && name.trim()) ? name.trim() : existing.name;
  // group_name === '' (explicitly blank) means "ungroup"; group_name === undefined means "leave as-is"
  const newGroup = group_name !== undefined ? ((group_name || '').trim() || null) : existing.group_name;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    if (newName !== existing.name) {
      const dupe = await client.query('SELECT id FROM projects WHERE name = $1 AND id <> $2', [newName, req.params.id]);
      if (dupe.rows.length) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'Another project already has this name' });
      }
    }

    await client.query(
      'UPDATE projects SET name = $1, weekly_off_day = $2, group_name = $3 WHERE id = $4',
      [newName, offDay, newGroup, req.params.id]
    );

    if (newName !== existing.name) {
      await client.query('UPDATE employees SET project = $1 WHERE project = $2', [newName, existing.name]);
      await client.query('UPDATE admins SET project = $1 WHERE project = $2', [newName, existing.name]);
      await client.query('UPDATE salary_slip_requests SET project = $1 WHERE project = $2', [newName, existing.name]);
    }

    await client.query('COMMIT');
    res.json({ message: 'Project updated successfully' });
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.code === '23505') {
      return res.status(409).json({ error: 'Another project already has this name' });
    }
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

router.delete('/:id', verifyAdmin, async (req, res) => {
  const result = await pool.query('DELETE FROM projects WHERE id = $1', [req.params.id]);
  if (result.rowCount === 0) return res.status(404).json({ error: 'Project not found' });
  res.json({ message: 'Project removed' });
});

module.exports = router;
