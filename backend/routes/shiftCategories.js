const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { verifyAdmin, verifyAdminOrManager } = require('../middleware');

// admin + manager/coordinator can see the list (needed to populate dropdowns/filters) — own company
router.get('/', verifyAdminOrManager, async (req, res) => {
  const { rows } = await pool.query(
    'SELECT * FROM shift_categories WHERE company_id = $1 ORDER BY full_hours DESC, name ASC',
    [req.user.company_id]
  );
  res.json({ count: rows.length, categories: rows });
});

// only admin can add/remove shift categories (own company)
router.post('/', verifyAdmin, async (req, res) => {
  const { name, full_hours, half_hours, ot_rate_per_hour } = req.body;
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
  const otRate = ot_rate_per_hour !== undefined && ot_rate_per_hour !== null && ot_rate_per_hour !== ''
    ? Number(ot_rate_per_hour)
    : 0;

  try {
    await pool.query(
      'INSERT INTO shift_categories (name, full_hours, half_hours, ot_rate_per_hour, company_id) VALUES ($1, $2, $3, $4, $5)',
      [name.trim(), fullHours, halfHours, otRate, req.user.company_id]
    );
    res.json({ message: 'Shift category added successfully' });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'This shift category already exists' });
    }
    res.status(500).json({ error: err.message });
  }
});

// admin — update an existing category's hours / OT rate (e.g. setting the OT rate for the
// first time on a category that was created before OT automation existed).
// PUT /api/shift-categories/:id  body: { full_hours?, half_hours?, ot_rate_per_hour? }
router.put('/:id', verifyAdmin, async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM shift_categories WHERE id = $1 AND company_id = $2', [req.params.id, req.user.company_id]);
  const existing = rows[0];
  if (!existing) return res.status(404).json({ error: 'Shift category not found' });

  const { full_hours, half_hours, ot_rate_per_hour } = req.body;
  await pool.query(
    'UPDATE shift_categories SET full_hours = $1, half_hours = $2, ot_rate_per_hour = $3 WHERE id = $4 AND company_id = $5',
    [
      full_hours !== undefined && full_hours !== '' ? Number(full_hours) : existing.full_hours,
      half_hours !== undefined && half_hours !== '' ? Number(half_hours) : existing.half_hours,
      ot_rate_per_hour !== undefined && ot_rate_per_hour !== '' ? Number(ot_rate_per_hour) : existing.ot_rate_per_hour,
      req.params.id, req.user.company_id,
    ]
  );
  res.json({ message: 'Shift category updated' });
});

router.delete('/:id', verifyAdmin, async (req, res) => {
  const result = await pool.query('DELETE FROM shift_categories WHERE id = $1 AND company_id = $2', [req.params.id, req.user.company_id]);
  if (result.rowCount === 0) return res.status(404).json({ error: 'Shift category not found' });
  res.json({ message: 'Shift category removed' });
});

module.exports = router;
