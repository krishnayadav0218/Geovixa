const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const { pool } = require('../db');
const { verifyAdmin, verifyAdminOrManager } = require('../middleware');
const { effectiveProjects } = require('../projectScope');
const { resolveProject, resolveShiftCategory } = require('../nameResolver');
const { validatePin, generateRandomPin } = require('../policy');

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
// GET /api/employees?project=xxx (manager/coordinator's own project always wins, ignoring this param)
router.get('/', verifyAdminOrManager, async (req, res) => {
  const projects = await effectiveProjects(req, pool);
  let query = `SELECT id, employee_id, name, designation, phone, location, doj, project, shift_category,
                      active, zone, ward, site_code, created_at,
                      (pin_hash IS NOT NULL) AS has_pin
               FROM employees`;
  const params = [];
  if (projects && projects.length) { params.push(projects); query += ` WHERE project = ANY($${params.length}::text[])`; }
  query += ' ORDER BY employee_id ASC';
  const { rows } = await pool.query(query, params);
  res.json({ count: rows.length, employees: rows });
});

// everything below here is admin only (add / edit / delete)
router.use(verifyAdmin);

router.post('/', async (req, res) => {
  const {
    employee_id, name, designation, phone, location, doj, project, shift_category,
    zone, ward, site_code, pin,
    basic_salary, hra, other_allowances, deductions, pf, esic,
  } = req.body;
  if (!employee_id || !name) {
    return res.status(400).json({ error: 'employee_id and name are required' });
  }

  // Every employee needs a PIN to log in (Employee ID alone is not treated as a secret).
  const pinCheck = validatePin(pin);
  if (!pinCheck.ok) {
    return res.status(400).json({ error: pinCheck.error });
  }
  const pinHash = bcrypt.hashSync(String(pin).trim(), 10);

  const projectResult = await resolveProject(pool, project);
  if (!projectResult.ok) {
    return res.status(400).json({ error: `"${projectResult.name}" is not a known project. Add it first under Manage Projects, or pick one from the dropdown.` });
  }
  const shiftResult = await resolveShiftCategory(pool, shift_category);
  if (!shiftResult.ok) {
    return res.status(400).json({ error: `"${shiftResult.name}" is not a known shift category. Add it first under Manage Shift Categories, or pick one from the dropdown.` });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      'INSERT INTO employees (employee_id, name, designation, phone, location, doj, project, shift_category, zone, ward, site_code, pin_hash) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)',
      [
        employee_id.trim(), name.trim(), designation || '', phone || '', location || '', doj || '',
        projectResult.name, shiftResult.name, (zone || '').trim(), (ward || '').trim(), (site_code || '').trim(),
        pinHash,
      ]
    );

    // Salary fields are optional on the add form — only create a salaries row if at least
    // one of them was actually filled in, so plain employee-only adds don't leave behind a
    // bunch of all-zero salary rows.
    const salaryFields = { basic_salary, hra, other_allowances, deductions, pf, esic };
    const hasSalaryData = Object.values(salaryFields).some(v => v !== undefined && v !== null && String(v).trim() !== '');
    if (hasSalaryData) {
      await client.query(
        `INSERT INTO salaries (employee_id, basic_salary, hra, other_allowances, deductions, pf, esic, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())`,
        [
          employee_id.trim(),
          Number(basic_salary) || 0,
          Number(hra) || 0,
          Number(other_allowances) || 0,
          Number(deductions) || 0,
          Number(pf) || 0,
          Number(esic) || 0,
        ]
      );
    }

    await client.query('COMMIT');
    res.json({ message: 'Employee added successfully' });
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.code === '23505') {
      return res.status(409).json({ error: 'This Employee ID already exists' });
    }
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
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
  const skippedRows = []; // rows missing employee_id/name (or an unrecognized project/shift), so the admin knows exactly which ones to fix
  const generatedPins = []; // { employee_id, pin } — every bulk-imported employee gets an
  // auto-generated PIN (a spreadsheet import has no PIN column), returned once in plaintext
  // here so the admin can distribute them; never stored in plaintext anywhere after this.

  // Fetch the known project/shift-category names once, build case-insensitive lookup maps —
  // avoids one query per row and keeps bulk-imported employees from silently landing on a
  // project name that doesn't match anything (the exact gap this fixes).
  const [projRows, shiftRows] = await Promise.all([
    pool.query('SELECT name FROM projects'),
    pool.query('SELECT name FROM shift_categories'),
  ]);
  const projectMap = new Map(projRows.rows.map(r => [r.name.toLowerCase(), r.name]));
  const shiftMap = new Map(shiftRows.rows.map(r => [r.name.toLowerCase(), r.name]));

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

      const rawProject = (e.project || '').toString().trim();
      const rawShift = (e.shift_category || '').toString().trim();
      const resolvedProject = rawProject ? projectMap.get(rawProject.toLowerCase()) : '';
      const resolvedShift = rawShift ? shiftMap.get(rawShift.toLowerCase()) : '';

      if (rawProject && resolvedProject === undefined) {
        skippedRows.push({ row: i + 1, employee_id, name, reason: `Unknown project "${rawProject}" — add it under Manage Projects first` });
        continue;
      }
      if (rawShift && resolvedShift === undefined) {
        skippedRows.push({ row: i + 1, employee_id, name, reason: `Unknown shift category "${rawShift}" — add it under Manage Shift Categories first` });
        continue;
      }

      // Optional "pin" column in the import sheet is honoured if it's a valid 4-6 digit
      // PIN; otherwise one is auto-generated so the employee still has a working login.
      const rawPin = e.pin !== undefined && e.pin !== null ? String(e.pin).trim() : '';
      const pin = validatePin(rawPin).ok ? rawPin : generateRandomPin();
      const pinHash = bcrypt.hashSync(pin, 10);

      const result = await client.query(
        `INSERT INTO employees (employee_id, name, designation, phone, location, doj, project, shift_category, zone, ward, site_code, pin_hash)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         ON CONFLICT (employee_id) DO NOTHING`,
        [
          employee_id, name,
          (e.designation || '').toString().trim(),
          (e.phone || '').toString().trim(),
          (e.location || '').toString().trim(),
          (e.doj || '').toString().trim(),
          resolvedProject || '',
          resolvedShift || '',
          (e.zone || '').toString().trim(),
          (e.ward || '').toString().trim(),
          (e.site_code || '').toString().trim(),
          pinHash,
        ]
      );
      if (result.rowCount > 0) {
        added++;
        generatedPins.push({ employee_id, pin });
        // Only set a salary structure for employees actually added in this import (existing
        // employees are left untouched — bulk import never overwrites current data/salary).
        // A row is skipped only if it has no salary fields at all, so plain employee-only
        // imports don't create a bunch of empty salaries rows.
        const hasSalaryData = ['basic_salary', 'hra', 'other_allowances', 'deductions', 'pf', 'esic']
          .some(f => e[f] !== undefined && e[f] !== null && String(e[f]).trim() !== '');
        if (hasSalaryData) {
          await client.query(
            `INSERT INTO salaries (employee_id, basic_salary, hra, other_allowances, deductions, pf, esic, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
             ON CONFLICT (employee_id) DO NOTHING`,
            [
              employee_id,
              Number(e.basic_salary) || 0,
              Number(e.hra) || 0,
              Number(e.other_allowances) || 0,
              Number(e.deductions) || 0,
              Number(e.pf) || 0,
              Number(e.esic) || 0,
            ]
          );
        }
      } else {
        duplicates++;
      }
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
    generatedPins,
  });
});

router.put('/:employeeId', async (req, res) => {
  const { name, designation, phone, location, doj, active, project, shift_category, zone, ward, site_code, pin } = req.body;
  const { rows } = await pool.query('SELECT * FROM employees WHERE employee_id = $1', [req.params.employeeId]);
  const existing = rows[0];
  if (!existing) return res.status(404).json({ error: 'Employee not found' });

  let newPinHash = existing.pin_hash;
  if (pin !== undefined && pin !== '') {
    const pinCheck = validatePin(pin);
    if (!pinCheck.ok) {
      return res.status(400).json({ error: pinCheck.error });
    }
    newPinHash = bcrypt.hashSync(String(pin).trim(), 10);
  }

  let resolvedProject = existing.project;
  if (project !== undefined) {
    const projectResult = await resolveProject(pool, project);
    if (!projectResult.ok) {
      return res.status(400).json({ error: `"${projectResult.name}" is not a known project. Add it first under Manage Projects, or pick one from the dropdown.` });
    }
    resolvedProject = projectResult.name;
  }

  let resolvedShift = existing.shift_category;
  if (shift_category !== undefined) {
    const shiftResult = await resolveShiftCategory(pool, shift_category);
    if (!shiftResult.ok) {
      return res.status(400).json({ error: `"${shiftResult.name}" is not a known shift category. Add it first under Manage Shift Categories, or pick one from the dropdown.` });
    }
    resolvedShift = shiftResult.name;
  }

  await pool.query(
    'UPDATE employees SET name = $1, designation = $2, phone = $3, location = $4, doj = $5, active = $6, project = $7, shift_category = $8, zone = $9, ward = $10, site_code = $11, pin_hash = $12 WHERE employee_id = $13',
    [
      name ?? existing.name,
      designation ?? existing.designation,
      phone ?? existing.phone,
      location ?? existing.location,
      doj ?? existing.doj,
      active !== undefined ? (active ? 1 : 0) : existing.active,
      resolvedProject,
      resolvedShift,
      zone ?? existing.zone,
      ward ?? existing.ward,
      site_code ?? existing.site_code,
      newPinHash,
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
