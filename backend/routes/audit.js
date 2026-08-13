const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { verifyAdmin } = require('../middleware');

// Audit & Security module — admin-only, own company only. Two views:
// (1) admin activity log — every sensitive action taken inside the app (reliever force-
//     assigns, OT approvals/payments, employee edits, etc. — anywhere routes call logAction)
// (2) login history — every login attempt, success AND failure, across all account types.
// Both are read-only and nothing in the app ever deletes rows from either table.

// GET /api/audit/log?limit=200
router.get('/log', verifyAdmin, async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 200, 500);
  const { rows } = await pool.query(
    `SELECT id, actor_username, actor_role, action, target_type, target_id, target_label, details, created_at
     FROM audit_log WHERE company_id = $1 ORDER BY created_at DESC LIMIT $2`,
    [req.user.company_id, limit]
  );
  res.json({ count: rows.length, log: rows });
});

// GET /api/audit/login-history?limit=200&success=true|false
router.get('/login-history', verifyAdmin, async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 200, 500);
  const params = [req.user.company_id];
  let query = 'SELECT * FROM login_history WHERE company_id = $1';
  if (req.query.success === 'true') query += ' AND success = true';
  if (req.query.success === 'false') query += ' AND success = false';
  params.push(limit);
  query += ` ORDER BY created_at DESC LIMIT $${params.length}`;

  const { rows } = await pool.query(query, params);

  // Quick summary the frontend can show at a glance — failed attempts in the last 24h is
  // the single most useful security signal here (repeated failures = possible brute force).
  const { rows: failCount } = await pool.query(
    `SELECT COUNT(*)::int AS c FROM login_history
     WHERE company_id = $1 AND success = false AND created_at > NOW() - INTERVAL '24 hours'`,
    [req.user.company_id]
  );

  res.json({ count: rows.length, failedLast24h: failCount[0].c, history: rows });
});

module.exports = router;
