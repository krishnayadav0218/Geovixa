const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { verifyEmployee } = require('../middleware');

// GET /api/notifications/my — employee's own notification feed, newest first
router.get('/my', verifyEmployee, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id, category, title, body, is_read, created_at FROM notifications
     WHERE employee_id = $1 AND company_id = $2 ORDER BY created_at DESC LIMIT 100`,
    [req.user.employee_id, req.user.company_id]
  );
  const unread = rows.filter(r => !r.is_read).length;
  res.json({ notifications: rows, unread_count: unread });
});

// PUT /api/notifications/my/:id/read — mark a single notification read
router.put('/my/:id/read', verifyEmployee, async (req, res) => {
  await pool.query(
    `UPDATE notifications SET is_read = TRUE WHERE id = $1 AND employee_id = $2 AND company_id = $3`,
    [req.params.id, req.user.employee_id, req.user.company_id]
  );
  res.json({ message: 'ok' });
});

// PUT /api/notifications/my/read-all
router.put('/my/read-all', verifyEmployee, async (req, res) => {
  await pool.query(
    `UPDATE notifications SET is_read = TRUE WHERE employee_id = $1 AND company_id = $2 AND is_read = FALSE`,
    [req.user.employee_id, req.user.company_id]
  );
  res.json({ message: 'ok' });
});

module.exports = router;
