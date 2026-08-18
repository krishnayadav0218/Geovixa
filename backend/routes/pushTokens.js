const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { requireAuth } = require('../middleware');

// Android app FCM token save karta hai yahan
router.post('/employees/:employeeId/push-token', requireAuth, async (req, res) => {
  const { employeeId } = req.params;
  const { token } = req.body;
  try {
    await pool.query(
      'UPDATE employees SET fcm_token = $1 WHERE id = $2',
      [token, employeeId]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
