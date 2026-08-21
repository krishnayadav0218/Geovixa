const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { verifyAdmin, optionalAuth } = require('../middleware');

// GET /api/holidays?year=2026 — readable by both employees and admins (any logged-in
// role); falls back to the current year if not specified.
router.get('/', optionalAuth, async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Login required' });
  const year = Number(req.query.year) || new Date().getFullYear();
  const { rows } = await pool.query(
    `SELECT id, holiday_date, name FROM company_holidays
     WHERE company_id = $1 AND EXTRACT(YEAR FROM holiday_date) = $2
     ORDER BY holiday_date ASC`,
    [req.user.company_id, year]
  );
  res.json({ year, holidays: rows });
});

// POST /api/holidays  body: { holiday_date: 'YYYY-MM-DD', name }  (admin only)
router.post('/', verifyAdmin, async (req, res) => {
  const holidayDate = req.body.holiday_date;
  const name = (req.body.name || '').trim();
  if (!holidayDate || !name) return res.status(400).json({ error: 'holiday_date and name are required' });

  const { rows } = await pool.query(
    `INSERT INTO company_holidays (company_id, holiday_date, name) VALUES ($1, $2, $3)
     ON CONFLICT (company_id, holiday_date) DO UPDATE SET name = $3 RETURNING id`,
    [req.user.company_id, holidayDate, name]
  );
  res.json({ message: 'Holiday saved', id: rows[0].id });
});

// DELETE /api/holidays/:id  (admin only)
router.delete('/:id', verifyAdmin, async (req, res) => {
  const result = await pool.query('DELETE FROM company_holidays WHERE id = $1 AND company_id = $2', [req.params.id, req.user.company_id]);
  if (result.rowCount === 0) return res.status(404).json({ error: 'Holiday not found' });
  res.json({ message: 'Holiday removed' });
});

module.exports = router;
