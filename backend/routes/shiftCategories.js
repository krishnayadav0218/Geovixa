const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { verifyAdmin, verifyAdminOrManager } = require('../middleware');

// admin + manager/coordinator can see the list (needed to populate dropdowns/filters)
router.get('/', verifyAdminOrManager, async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM shift_categories ORDER BY full_hours DESC, name ASC');
  res.json({ count: rows.length, categories: rows });
});

// only admin can add/remove shift categories
router.post('/', verifyAdmin, async (req, res) => {
  const { name, full_hours, half_hours } = req.body;
  const fullHours = Number(full_hours);

  if (!name || !name.trim()) {
    return res.status(400).json({ error: 'Category name is required' });
  }
  if (!fullHours || fullHours <= 0) {
    return res.status(400).json({ error: 'Full-day hours must be a positive number' });
  }
  // Half Day defaults to exactly half the full-day hours (matches the 12h->6h, 8h->4h rule
  // already agreed with the client), but an admin can override it if a category ever needs
  // a different split.
  const halfHours = half_hours !== undefined && half_hours !== null && half_hours !== ''
    ? Number(half_hours)
    : fullHours / 2;

  try {
    await pool.query(
      'INSERT INTO shift_categories (name, full_hours, half_hours) VALUES ($1, $2, $3)',
      [name.trim(), fullHours, halfHours]
    );
    res.json({ message: 'Shift category added successfully' });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'This shift category already exists' });
    }
    res.status(500).json({ error: err.message });
  }
});

router.delete('/:id', verifyAdmin, async (req, res) => {
  const result = await pool.query('DELETE FROM shift_categories WHERE id = $1', [req.params.id]);
  if (result.rowCount === 0) return res.status(404).json({ error: 'Shift category not found' });
  res.json({ message: 'Shift category removed' });
});

module.exports = router;
