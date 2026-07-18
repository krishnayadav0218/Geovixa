const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { verifyAdmin, verifyAdminOrManager } = require('../middleware');

// admin + manager/coordinator can see the list (needed to populate dropdowns/filters)
router.get('/', verifyAdminOrManager, async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM projects ORDER BY name ASC');
  res.json({ count: rows.length, projects: rows });
});

// only admin can add/remove projects
router.post('/', verifyAdmin, async (req, res) => {
  const { name, weekly_off_day } = req.body;
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
    await pool.query('INSERT INTO projects (name, weekly_off_day) VALUES ($1, $2)', [name.trim(), offDay]);
    res.json({ message: 'Project added successfully' });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'This project already exists' });
    }
    res.status(500).json({ error: err.message });
  }
});

// admin can change a project's weekly off day after the fact
router.put('/:id', verifyAdmin, async (req, res) => {
  const { weekly_off_day } = req.body;
  const offDay = Number(weekly_off_day);
  if (!Number.isInteger(offDay) || offDay < 0 || offDay > 6) {
    return res.status(400).json({ error: 'Weekly off day must be 0 (Sunday) through 6 (Saturday)' });
  }
  const result = await pool.query('UPDATE projects SET weekly_off_day = $1 WHERE id = $2', [offDay, req.params.id]);
  if (result.rowCount === 0) return res.status(404).json({ error: 'Project not found' });
  res.json({ message: 'Weekly off day updated' });
});

router.delete('/:id', verifyAdmin, async (req, res) => {
  const result = await pool.query('DELETE FROM projects WHERE id = $1', [req.params.id]);
  if (result.rowCount === 0) return res.status(404).json({ error: 'Project not found' });
  res.json({ message: 'Project removed' });
});

module.exports = router;
