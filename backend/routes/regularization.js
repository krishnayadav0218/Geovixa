const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { verifyAdminOrManager, verifyEmployee } = require('../middleware');
const { notifyEmployee } = require('../notifyEmployee');
const { logAction } = require('../auditLog');

// POST /api/regularization  body: { attendance_date, requested_status, requested_time?, reason }
router.post('/', verifyEmployee, async (req, res) => {
  const { attendance_date, requested_status, requested_time, reason } = req.body;
  if (!attendance_date || !['on_duty', 'off_duty'].includes(requested_status) || !reason || !reason.trim()) {
    return res.status(400).json({ error: 'attendance_date, requested_status (on_duty/off_duty), and reason are required' });
  }
  const { rows } = await pool.query(
    `INSERT INTO regularization_requests (company_id, employee_id, attendance_date, requested_status, requested_time, reason)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [req.user.company_id, req.user.employee_id, attendance_date, requested_status, requested_time || null, reason.trim()]
  );
  res.json({ message: 'Regularization request submitted', id: rows[0].id });
});

// GET /api/regularization/my — employee's own requests
router.get('/my', verifyEmployee, async (req, res) => {
  const { rows } = await pool.query(
    'SELECT * FROM regularization_requests WHERE employee_id = $1 AND company_id = $2 ORDER BY created_at DESC',
    [req.user.employee_id, req.user.company_id]
  );
  res.json({ requests: rows });
});

// GET /api/regularization — admin/manager: all pending (or all) requests for their company
router.get('/', verifyAdminOrManager, async (req, res) => {
  const { status } = req.query;
  let query = `SELECT r.*, e.name AS employee_name, e.project FROM regularization_requests r
               LEFT JOIN employees e ON e.employee_id = r.employee_id AND e.company_id = r.company_id
               WHERE r.company_id = $1`;
  const params = [req.user.company_id];
  if (status) {
    query += ' AND r.status = $2';
    params.push(status);
  }
  query += ' ORDER BY r.created_at DESC LIMIT 300';
  const { rows } = await pool.query(query, params);
  res.json({ requests: rows });
});

async function review(req, res, newStatus) {
  const { rows } = await pool.query(
    'SELECT * FROM regularization_requests WHERE id = $1 AND company_id = $2',
    [req.params.id, req.user.company_id]
  );
  const request = rows[0];
  if (!request) return res.status(404).json({ error: 'Request not found' });
  if (request.status !== 'pending') return res.status(400).json({ error: `Already ${request.status}` });

  await pool.query(
    'UPDATE regularization_requests SET status = $1, reviewed_by = $2, reviewed_at = NOW(), review_note = $3 WHERE id = $4',
    [newStatus, req.user.employee_id || req.user.username || 'admin', (req.body.note || '').trim() || null, request.id]
  );

  // Approving actually writes/corrects the attendance record — otherwise "approved"
  // would be meaningless busywork that doesn't fix the underlying missed punch.
  if (newStatus === 'approved') {
    const time = request.requested_time || (request.requested_status === 'on_duty' ? '09:00:00' : '18:00:00');
    const serverTime = `${request.attendance_date}T${time}`;
    await pool.query(
      `INSERT INTO attendance (company_id, employee_id, status, attendance_date, server_time, is_regularized, regularized_request_id)
       VALUES ($1, $2, $3, $4, $5, TRUE, $6)`,
      [req.user.company_id, request.employee_id, request.requested_status, request.attendance_date, serverTime, request.id]
    );
  }

  await logAction(req, `regularization_${newStatus}`, {
    targetType: 'regularization_request', targetId: request.id,
    targetLabel: `${request.employee_id} — ${request.attendance_date} (${request.requested_status})`,
  });

  await notifyEmployee(
    req.user.company_id, request.employee_id,
    newStatus === 'approved' ? 'regularization_approved' : 'regularization_rejected',
    `Attendance correction ${newStatus}`,
    `Your request for ${request.attendance_date} (${request.requested_status.replace('_', ' ')}) was ${newStatus}.`
  );

  res.json({ message: `Request ${newStatus}` });
}
router.put('/:id/approve', verifyAdminOrManager, (req, res) => review(req, res, 'approved'));
router.put('/:id/reject', verifyAdminOrManager, (req, res) => review(req, res, 'rejected'));

module.exports = router;
