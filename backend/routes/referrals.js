const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { verifyAdminOrManager, verifyEmployee } = require('../middleware');
const { logAction } = require('../auditLog');

// ---- employee (self) — refer a candidate ----
// POST /api/referrals  body: { referred_name, referred_phone, note? }
router.post('/', verifyEmployee, async (req, res) => {
  const referredName = (req.body.referred_name || '').trim();
  const referredPhone = (req.body.referred_phone || '').trim();
  if (!referredName || !referredPhone) {
    return res.status(400).json({ error: 'referred_name and referred_phone are required' });
  }
  if (!/^\+?[0-9]{7,15}$/.test(referredPhone.replace(/[\s-]/g, ''))) {
    return res.status(400).json({ error: 'Please enter a valid phone number' });
  }

  const { rows } = await pool.query(
    `INSERT INTO employee_referrals (company_id, referrer_employee_id, referred_name, referred_phone, note)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [req.user.company_id, req.user.employee_id, referredName, referredPhone, (req.body.note || '').trim() || null]
  );
  res.json({ message: 'Referral submitted — thank you!', id: rows[0].id });
});

// GET /api/referrals/my
router.get('/my', verifyEmployee, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id, referred_name, referred_phone, note, status, reward_amount, reward_paid, created_at
     FROM employee_referrals WHERE referrer_employee_id = $1 AND company_id = $2 ORDER BY created_at DESC`,
    [req.user.employee_id, req.user.company_id]
  );
  res.json({ referrals: rows });
});

// ---- admin/manager — list + review all referrals ----
// GET /api/referrals?status=
router.get('/', verifyAdminOrManager, async (req, res) => {
  let query = `SELECT r.*, e.name AS referrer_name FROM employee_referrals r
               LEFT JOIN employees e ON e.employee_id = r.referrer_employee_id AND e.company_id = r.company_id
               WHERE r.company_id = $1`;
  const params = [req.user.company_id];
  if (req.query.status) {
    params.push(req.query.status);
    query += ` AND r.status = $${params.length}`;
  }
  query += ' ORDER BY r.created_at DESC LIMIT 500';
  const { rows } = await pool.query(query, params);
  res.json({ referrals: rows });
});

// ---- admin/manager/coordinator: bulk-update a batch of referrals in one go ----
// PUT /api/referrals/bulk-update  body: { ids: [1,2,3], status: 'hired'|'rejected'|'pending' }
// Status-only, unlike the single-referral PUT below — bulk-setting reward_amount/reward_paid
// to one shared value across a batch of different referrals would be more likely to cause a
// payout mistake than to save real time, so that stays a per-referral action.
//
// IMPORTANT: this MUST be registered before PUT /:id below — Express matches routes in
// registration order, and '/:id' would otherwise swallow '/bulk-update' as id="bulk-update".
router.put('/bulk-update', verifyAdminOrManager, async (req, res) => {
  const ids = Array.isArray(req.body.ids) ? req.body.ids.filter((id) => Number.isInteger(Number(id))) : [];
  const status = ['pending', 'hired', 'rejected'].includes(req.body.status) ? req.body.status : undefined;
  if (!ids.length) return res.status(400).json({ error: 'ids (array of referral ids) is required' });
  if (!status) return res.status(400).json({ error: 'A valid status (pending/hired/rejected) is required' });

  const result = await pool.query(
    `UPDATE employee_referrals SET status = $1, reviewed_by = $2, reviewed_at = NOW()
     WHERE id = ANY($3::int[]) AND company_id = $4`,
    [status, req.user.username || 'admin', ids, req.user.company_id]
  );

  await logAction(req, 'referral_bulk_updated', { targetType: 'employee_referral', details: `${result.rowCount} referral(s) → ${status}` });
  res.json({ message: `${result.rowCount} referral(s) updated`, updated: result.rowCount });
});

// PUT /api/referrals/:id  body: { status: 'hired'|'rejected'|'pending', reward_amount?, reward_paid? }
router.put('/:id', verifyAdminOrManager, async (req, res) => {
  const status = ['pending', 'hired', 'rejected'].includes(req.body.status) ? req.body.status : undefined;
  const fields = [];
  const params = [];
  let idx = 1;

  if (status) { fields.push(`status = $${idx++}`); params.push(status); }
  if (req.body.reward_amount !== undefined) { fields.push(`reward_amount = $${idx++}`); params.push(Number(req.body.reward_amount) || 0); }
  if (req.body.reward_paid !== undefined) { fields.push(`reward_paid = $${idx++}`); params.push(!!req.body.reward_paid); }
  if (!fields.length) return res.status(400).json({ error: 'Nothing to update' });

  fields.push(`reviewed_by = $${idx++}`); params.push(req.user.username || 'admin');
  fields.push(`reviewed_at = NOW()`);
  params.push(req.params.id, req.user.company_id);

  const result = await pool.query(
    `UPDATE employee_referrals SET ${fields.join(', ')} WHERE id = $${idx++} AND company_id = $${idx}`,
    params
  );
  if (result.rowCount === 0) return res.status(404).json({ error: 'Referral not found' });

  await logAction(req, 'referral_updated', { targetType: 'employee_referral', targetId: req.params.id, targetLabel: status ? `status → ${status}` : 'updated' });
  res.json({ message: 'Referral updated' });
});

module.exports = router;
