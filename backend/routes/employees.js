const express = require('express');
const router = express.Router();
const db = require('../db');
const { verifyAdmin, verifyAdminOrManager } = require('../middleware');

// ---------- PUBLIC: used by Android app / web employee-login to validate Employee ID ----------
// GET /api/employees/verify/:employeeId
router.get('/verify/:employeeId', (req, res) => {
  const emp = db.prepare('SELECT employee_id, name, designation, active FROM employees WHERE employee_id = ?')
    .get(req.params.employeeId.trim());

  if (!emp) return res.status(404).json({ error: 'Employee ID not found' });
  if (!emp.active) return res.status(403).json({ error: 'This Employee ID is deactivated. Contact admin.' });

  res.json({ valid: true, employee: emp });
});

// ---------- VIEW ONLY: Admin + Manager ----------

// GET /api/employees  -> list all employees
router.get('/', verifyAdminOrManager, (req, res) => {
  const employees = db.prepare('SELECT * FROM employees ORDER BY employee_id ASC').all();
  res.json({ count: employees.length, employees });
});

// ---------- ADMIN ONLY below this line (add/edit/delete) ----------
router.use(verifyAdmin);

// POST /api/employees -> add single employee
router.post('/', (req, res) => {
  const { employee_id, name, designation, phone } = req.body;
  if (!employee_id || !name) {
    return res.status(400).json({ error: 'employee_id and name are required' });
  }
  try {
    db.prepare('INSERT INTO employees (employee_id, name, designation, phone) VALUES (?, ?, ?, ?)')
      .run(employee_id.trim(), name.trim(), designation || '', phone || '');
    res.json({ message: 'Employee added successfully' });
  } catch (err) {
    if (err.message.includes('UNIQUE')) {
      return res.status(409).json({ error: 'This Employee ID already exists' });
    }
    res.status(500).json({ error: err.message });
  }
});

// POST /api/employees/bulk -> add many employees at once
// body: { employees: [ {employee_id, name, designation, phone}, ... ] }
router.post('/bulk', (req, res) => {
  const { employees } = req.body;
  if (!Array.isArray(employees) || employees.length === 0) {
    return res.status(400).json({ error: 'employees array required' });
  }

  const insert = db.prepare('INSERT OR IGNORE INTO employees (employee_id, name, designation, phone) VALUES (?, ?, ?, ?)');
  const insertMany = db.transaction((rows) => {
    let added = 0;
    for (const e of rows) {
      if (e.employee_id && e.name) {
        const info = insert.run(String(e.employee_id).trim(), String(e.name).trim(), e.designation || '', e.phone || '');
        if (info.changes > 0) added++;
      }
    }
    return added;
  });

  const added = insertMany(employees);
  res.json({ message: `${added} employees added (duplicates skipped)`, added });
});

// PUT /api/employees/:employeeId -> update employee
router.put('/:employeeId', (req, res) => {
  const { name, designation, phone, active } = req.body;
  const existing = db.prepare('SELECT * FROM employees WHERE employee_id = ?').get(req.params.employeeId);
  if (!existing) return res.status(404).json({ error: 'Employee not found' });

  db.prepare('UPDATE employees SET name = ?, designation = ?, phone = ?, active = ? WHERE employee_id = ?')
    .run(
      name ?? existing.name,
      designation ?? existing.designation,
      phone ?? existing.phone,
      active !== undefined ? (active ? 1 : 0) : existing.active,
      req.params.employeeId
    );
  res.json({ message: 'Employee updated' });
});

// DELETE /api/employees/:employeeId
router.delete('/:employeeId', (req, res) => {
  const info = db.prepare('DELETE FROM employees WHERE employee_id = ?').run(req.params.employeeId);
  if (info.changes === 0) return res.status(404).json({ error: 'Employee not found' });
  res.json({ message: 'Employee deleted' });
});

module.exports = router;
