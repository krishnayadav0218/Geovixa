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
  const { name } = req.body;
  if (!name || !name.trim()) {
    return res.status(400).json({ error: 'Project name is required' });
  }
  try {
    await pool.query('INSERT INTO projects (name) VALUES ($1)', [name.trim()]);
    res.json({ message: 'Project added successfully' });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'This project already exists' });
    }
    res.status(500).json({ error: err.message });
  }
});

router.delete('/:id', verifyAdmin, async (req, res) => {
  const result = await pool.query('DELETE FROM projects WHERE id = $1', [req.params.id]);
  if (result.rowCount === 0) return res.status(404).json({ error: 'Project not found' });
  res.json({ message: 'Project removed' });
});

module.exports = router;
