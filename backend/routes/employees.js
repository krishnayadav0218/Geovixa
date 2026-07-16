const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { verifyAdmin, verifyAdminOrManager } = require('../middleware');

// public — used by the Android app / web employee-login to validate an Employee ID
router.get('/verify/:employeeId', async (req, res) => {
  const { rows } = await pool.query(
    'SELECT employee_id, name, designation, active FROM employees WHERE employee_id = $1',
    [req.params.employeeId.trim()]
  );
  const emp = rows[0];

  if (!emp) return res.status(404).json({ error: 'Employee ID not found' });
  if (!emp.active) return res.status(403).json({ error: 'This Employee ID is deactivated. Contact admin.' });

  res.json({ valid: true, employee: emp });
});

// view only — admin + manager
router.get('/', verifyAdminOrManager, async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM employees ORDER BY employee_id ASC');
  res.json({ count: rows.length, employees: rows });
});

// everything below here is admin only (add / edit / delete)
router.use(verifyAdmin);

router.post('/', async (req, res) => {
  const { employee_id, name, designation, phone, location, doj } = req.body;
  if (!employee_id || !name) {
    return res.status(400).json({ error: 'employee_id and name are required' });
  }
  try {
    await pool.query(
      'INSERT INTO employees (employee_id, name, designation, phone, location, doj) VALUES ($1, $2, $3, $4, $5, $6)',
      [employee_id.trim(), name.trim(), designation || '', phone || '', location || '', doj || '']
    );
    res.json({ message: 'Employee added successfully' });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'This Employee ID already exists' });
    }
    res.status(500).json({ error: err.message });
  }
});

// POST /api/employees/bulk -> add many at once, body: { employees: [{employee_id, name, ...}] }
router.post('/bulk', async (req, res) => {
  const { employees } = req.body;
  if (!Array.isArray(employees) || employees.length === 0) {
    return res.status(400).json({ error: 'employees array required' });
  }

  const client = await pool.connect();
  let added = 0;
  try {
    await client.query('BEGIN');
    for (const e of employees) {
      if (!e.employee_id || !e.name) continue;
      const result = await client.query(
        `INSERT INTO employees (employee_id, name, designation, phone, location, doj)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (employee_id) DO NOTHING`,
        [String(e.employee_id).trim(), String(e.name).trim(), e.designation || '', e.phone || '', e.location || '', e.doj || '']
      );
      if (result.rowCount > 0) added++;
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    return res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }

  res.json({ message: `${added} employees added (duplicates skipped)`, added });
});

router.put('/:employeeId', async (req, res) => {
  const { name, designation, phone, location, doj, active } = req.body;
  const { rows } = await pool.query('SELECT * FROM employees WHERE employee_id = $1', [req.params.employeeId]);
  const existing = rows[0];
  if (!existing) return res.status(404).json({ error: 'Employee not found' });

  await pool.query(
    'UPDATE employees SET name = $1, designation = $2, phone = $3, location = $4, doj = $5, active = $6 WHERE employee_id = $7',
    [
      name ?? existing.name,
      designation ?? existing.designation,
      phone ?? existing.phone,
      location ?? existing.location,
      doj ?? existing.doj,
      active !== undefined ? (active ? 1 : 0) : existing.active,
      req.params.employeeId,
    ]
  );
  res.json({ message: 'Employee updated' });
});

router.delete('/:employeeId', async (req, res) => {
  const result = await pool.query('DELETE FROM employees WHERE employee_id = $1', [req.params.employeeId]);
  if (result.rowCount === 0) return res.status(404).json({ error: 'Employee not found' });
  res.json({ message: 'Employee deleted' });
});

module.exports = router;
