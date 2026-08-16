const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const { pool } = require('../db');
const { verifyAdmin } = require('../middleware');
const { getCompanySettings } = require('../companySettings');
const { logAction } = require('../auditLog');

async function requireFeature(req, res) {
  const settings = await getCompanySettings(pool, req.user.company_id);
  if (!settings.features.client_portal) {
    res.status(403).json({ error: 'Client Portal is not enabled for your company.' });
    return false;
  }
  return true;
}

// POST /api/client-accounts  body: { username, password, name, contact_email?, contact_phone?, projects: [] }
router.post('/', verifyAdmin, async (req, res) => {
  if (!(await requireFeature(req, res))) return;
  const { username, password, name, contact_email, contact_phone, projects } = req.body;
  if (!username || !password || !name) return res.status(400).json({ error: 'username, password and name are required' });
  if (!Array.isArray(projects) || !projects.length) return res.status(400).json({ error: 'At least one site (project) must be assigned' });

  const passwordHash = bcrypt.hashSync(password, 10);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `INSERT INTO clients (company_id, username, password_hash, name, contact_email, contact_phone)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [req.user.company_id, username.trim(), passwordHash, name.trim(), contact_email || null, contact_phone || null]
    );
    const clientId = rows[0].id;
    for (const project of projects) {
      await client.query('INSERT INTO client_sites (client_id, project) VALUES ($1, $2)', [clientId, project]);
    }
    await client.query('COMMIT');
    await logAction(req, 'client_account_created', { targetType: 'client', targetId: clientId, targetLabel: name });
    res.json({ message: 'Client account created', id: clientId });
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.code === '23505') return res.status(409).json({ error: 'This username is already taken' });
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// GET /api/client-accounts
router.get('/', verifyAdmin, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT c.id, c.username, c.name, c.contact_email, c.contact_phone, c.active, c.created_at,
            COALESCE(array_agg(cs.project) FILTER (WHERE cs.project IS NOT NULL), '{}') AS projects
     FROM clients c LEFT JOIN client_sites cs ON cs.client_id = c.id
     WHERE c.company_id = $1 GROUP BY c.id ORDER BY c.created_at DESC`,
    [req.user.company_id]
  );
  res.json({ clients: rows });
});

// PUT /api/client-accounts/:id  body: { name?, contact_email?, contact_phone?, active?, projects?, password? }
router.put('/:id', verifyAdmin, async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM clients WHERE id = $1 AND company_id = $2', [req.params.id, req.user.company_id]);
  const existing = rows[0];
  if (!existing) return res.status(404).json({ error: 'Client account not found' });

  const { name, contact_email, contact_phone, active, projects, password } = req.body;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (password) {
      await client.query(
        'UPDATE clients SET name = $1, contact_email = $2, contact_phone = $3, active = $4, password_hash = $5 WHERE id = $6 AND company_id = $7',
        [name || existing.name, contact_email ?? existing.contact_email, contact_phone ?? existing.contact_phone,
          active !== undefined ? (active ? 1 : 0) : existing.active, bcrypt.hashSync(password, 10), req.params.id, req.user.company_id]
      );
    } else {
      await client.query(
        'UPDATE clients SET name = $1, contact_email = $2, contact_phone = $3, active = $4 WHERE id = $5 AND company_id = $6',
        [name || existing.name, contact_email ?? existing.contact_email, contact_phone ?? existing.contact_phone,
          active !== undefined ? (active ? 1 : 0) : existing.active, req.params.id, req.user.company_id]
      );
    }
    if (Array.isArray(projects)) {
      await client.query('DELETE FROM client_sites WHERE client_id = $1', [req.params.id]);
      for (const project of projects) {
        await client.query('INSERT INTO client_sites (client_id, project) VALUES ($1, $2)', [req.params.id, project]);
      }
    }
    await client.query('COMMIT');
    res.json({ message: 'Client account updated' });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

router.delete('/:id', verifyAdmin, async (req, res) => {
  const result = await pool.query('DELETE FROM clients WHERE id = $1 AND company_id = $2', [req.params.id, req.user.company_id]);
  if (result.rowCount === 0) return res.status(404).json({ error: 'Client account not found' });
  res.json({ message: 'Client account removed' });
});

module.exports = router;
