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
  let duplicates = 0;
  const skippedRows = []; // rows missing employee_id/name, so the admin knows exactly which ones to fix

  try {
    await client.query('BEGIN');
    for (let i = 0; i < employees.length; i++) {
      const e = employees[i];
      // Only Employee ID and Name are mandatory — every other column (designation, phone,
      // location, doj) is allowed to be blank/missing and is simply stored as empty string.
      const employee_id = e.employee_id !== undefined && e.employee_id !== null ? String(e.employee_id).trim() : '';
      const name = e.name !== undefined && e.name !== null ? String(e.name).trim() : '';

      if (!employee_id || !name) {
        skippedRows.push({ row: i + 1, employee_id: employee_id || null, name: name || null, reason: 'Missing Employee ID or Name' });
        continue;
      }

      const result = await client.query(
        `INSERT INTO employees (employee_id, name, designation, phone, location, doj)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (employee_id) DO NOTHING`,
        [employee_id, name, (e.designation || '').toString().trim(), (e.phone || '').toString().trim(), (e.location || '').toString().trim(), (e.doj || '').toString().trim()]
      );
      if (result.rowCount > 0) added++;
      else duplicates++;
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    return res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }

  res.json({
    message: `${added} employees added${duplicates ? `, ${duplicates} duplicate ID(s) skipped` : ''}${skippedRows.length ? `, ${skippedRows.length} row(s) skipped (missing ID/Name)` : ''}`,
    added,
    duplicates,
    skippedRows,
  });
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
