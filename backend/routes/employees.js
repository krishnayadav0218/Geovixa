const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const { pool } = require('../db');
const { verifyAdmin, verifyAdminOrManager } = require('../middleware');
const { effectiveProjects } = require('../projectScope');
const { resolveProject, resolveShiftCategory } = require('../nameResolver');
const { validatePin, validateCompanyCode } = require('../policy');
const { checkRolePermission } = require('../companySettings');

// public — used by the Android app / web employee-login to validate an Employee ID.
// Now needs a Company Code too, since Employee ID is only unique WITHIN a company.
// GET /api/employees/verify/:employeeId?company_code=XXXX
router.get('/verify/:employeeId', async (req, res) => {
  const codeCheck = validateCompanyCode(req.query.company_code);
  if (!codeCheck.ok) return res.status(400).json({ error: codeCheck.error });

  const companyResult = await pool.query('SELECT id, active FROM companies WHERE UPPER(code) = $1', [codeCheck.code]);
  const company = companyResult.rows[0];
  if (!company || !company.active) return res.status(400).json({ error: 'Company Code not found or inactive' });

  const { rows } = await pool.query(
    'SELECT employee_id, name, designation, active FROM employees WHERE company_id = $1 AND employee_id = $2',
    [company.id, req.params.employeeId.trim()]
  );
  const emp = rows[0];

  if (!emp) return res.status(404).json({ error: 'Employee ID not found' });
  if (!emp.active) return res.status(403).json({ error: 'This Employee ID is deactivated. Contact admin.' });

  res.json({ valid: true, employee: emp });
});

// view only — admin + manager (own company only)
// GET /api/employees?project=xxx (manager/coordinator's own project always wins, ignoring this param)
router.get('/', verifyAdminOrManager, async (req, res) => {
  const allowed = await checkRolePermission(pool, req.user.company_id, req.user.role, 'employees');
  if (!allowed) return res.status(403).json({ error: 'You do not have access to the Employees section.' });

  const projects = await effectiveProjects(req, pool);
  let query = `SELECT id, employee_id, name, designation, phone, email, location, doj, project, shift_category,
                      active, zone, ward, site_code, created_at,
                      (pin_hash IS NOT NULL) AS has_pin,
                      (bank_account_number IS NOT NULL AND bank_ifsc IS NOT NULL) AS has_bank_details
               FROM employees WHERE company_id = $1`;
  const params = [req.user.company_id];
  if (projects && projects.length) { params.push(projects); query += ` AND project = ANY($${params.length}::text[])`; }
  query += ' ORDER BY employee_id ASC';
  const { rows } = await pool.query(query, params);
  res.json({ count: rows.length, employees: rows });
});

// everything below here is admin only (add / edit / delete)
router.use(verifyAdmin);

router.post('/', async (req, res) => {
  const {
    employee_id, name, designation, phone, email, location, doj, project, shift_category,
    zone, ward, site_code, pin,
    basic_salary, hra, other_allowances, deductions, pf, esic,
  } = req.body;
  if (!employee_id || !name) {
    return res.status(400).json({ error: 'employee_id and name are required' });
  }

  const companyId = req.user.company_id;

  // Enforce the company's plan-based employee limit (set by the platform owner, see
  // routes/companies.js). NULL max_employees = unlimited.
  const companyResult = await pool.query('SELECT max_employees FROM companies WHERE id = $1', [companyId]);
  const maxEmployees = companyResult.rows[0] && companyResult.rows[0].max_employees;
  if (maxEmployees !== null && maxEmployees !== undefined) {
    const countResult = await pool.query('SELECT COUNT(*)::int AS count FROM employees WHERE company_id = $1', [companyId]);
    if (countResult.rows[0].count >= maxEmployees) {
      return res.status(403).json({ error: `Your plan allows up to ${maxEmployees} employees. Contact the platform owner to increase this limit.` });
    }
  }

  // PIN is OPTIONAL: if the admin sets one, that employee needs Employee ID + PIN to log in
  // (see routes/auth.js employee-login). If left blank, pin_hash stays NULL and that employee
  // can log in with just their Employee ID — no PIN prompt/check at all for them.
  const rawPin = pin !== undefined && pin !== null ? String(pin).trim() : '';
  let pinHash = null;
  if (rawPin) {
    const pinCheck = validatePin(rawPin);
    if (!pinCheck.ok) {
      return res.status(400).json({ error: pinCheck.error });
    }
    pinHash = bcrypt.hashSync(rawPin, 10);
  }

  const projectResult = await resolveProject(pool, project, companyId);
  if (!projectResult.ok) {
    return res.status(400).json({ error: `"${projectResult.name}" is not a known project. Add it first under Manage Projects, or pick one from the dropdown.` });
  }
  const shiftResult = await resolveShiftCategory(pool, shift_category, companyId);
  if (!shiftResult.ok) {
    return res.status(400).json({ error: `"${shiftResult.name}" is not a known shift category. Add it first under Manage Shift Categories, or pick one from the dropdown.` });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      'INSERT INTO employees (employee_id, name, designation, phone, email, location, doj, project, shift_category, zone, ward, site_code, pin_hash, company_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)',
      [
        employee_id.trim(), name.trim(), designation || '', phone || '', (email || '').trim() || null, location || '', doj || '',
        projectResult.name, shiftResult.name, (zone || '').trim(), (ward || '').trim(), (site_code || '').trim(),
        pinHash, companyId,
      ]
    );

    // Salary fields are optional on the add form — only create a salaries row if at least
    // one of them was actually filled in, so plain employee-only adds don't leave behind a
    // bunch of all-zero salary rows.
    const salaryFields = { basic_salary, hra, other_allowances, deductions, pf, esic };
    const hasSalaryData = Object.values(salaryFields).some(v => v !== undefined && v !== null && String(v).trim() !== '');
    if (hasSalaryData) {
      await client.query(
        `INSERT INTO salaries (employee_id, basic_salary, hra, other_allowances, deductions, pf, esic, updated_at, company_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), $8)`,
        [
          employee_id.trim(),
          Number(basic_salary) || 0,
          Number(hra) || 0,
          Number(other_allowances) || 0,
          Number(deductions) || 0,
          Number(pf) || 0,
          Number(esic) || 0,
          companyId,
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
  const companyId = req.user.company_id;

  const companyResult = await pool.query('SELECT max_employees FROM companies WHERE id = $1', [companyId]);
  const maxEmployees = companyResult.rows[0] && companyResult.rows[0].max_employees;
  let remainingSlots = Infinity;
  if (maxEmployees !== null && maxEmployees !== undefined) {
    const countResult = await pool.query('SELECT COUNT(*)::int AS count FROM employees WHERE company_id = $1', [companyId]);
    remainingSlots = Math.max(0, maxEmployees - countResult.rows[0].count);
    if (remainingSlots === 0) {
      return res.status(403).json({ error: `Your plan allows up to ${maxEmployees} employees, and you're already at that limit. Contact the platform owner to increase it.` });
    }
  }

  const client = await pool.connect();
  let added = 0;
  let duplicates = 0;
  const skippedRows = []; // rows missing employee_id/name (or an unrecognized project/shift), so the admin knows exactly which ones to fix
  const pinsSet = []; // { employee_id, pin } — only for rows where the import sheet's "pin"
  // column had a valid 4-6 digit PIN, returned once in plaintext here so the admin can
  // confirm/distribute them; never stored in plaintext anywhere after this. Employees with no
  // "pin" column value simply have no PIN set and log in with just their Employee ID.

  // Fetch the known project/shift-category names once (scoped to this company), build
  // case-insensitive lookup maps — avoids one query per row and keeps bulk-imported
  // employees from silently landing on a project name that doesn't match anything.
  const [projRows, shiftRows] = await Promise.all([
    pool.query('SELECT name FROM projects WHERE company_id = $1', [companyId]),
    pool.query('SELECT name FROM shift_categories WHERE company_id = $1', [companyId]),
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

      if (added >= remainingSlots) {
        skippedRows.push({ row: i + 1, employee_id, name, reason: `Skipped — your plan's employee limit was reached during this import` });
        continue;
      }

      // Optional "pin" column in the import sheet — honoured if it's a valid 4-6 digit PIN.
      // Left blank/invalid, the employee simply has no PIN set (pin_hash stays NULL) and can
      // log in with just their Employee ID, same as adding one employee at a time.
      const rawPin = e.pin !== undefined && e.pin !== null ? String(e.pin).trim() : '';
      const pinHash = rawPin && validatePin(rawPin).ok ? bcrypt.hashSync(rawPin, 10) : null;

      const result = await client.query(
        `INSERT INTO employees (employee_id, name, designation, phone, email, location, doj, project, shift_category, zone, ward, site_code, pin_hash, company_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
         ON CONFLICT (company_id, employee_id) DO NOTHING`,
        [
          employee_id, name,
          (e.designation || '').toString().trim(),
          (e.phone || '').toString().trim(),
          (e.email || '').toString().trim() || null,
          (e.location || '').toString().trim(),
          (e.doj || '').toString().trim(),
          resolvedProject || '',
          resolvedShift || '',
          (e.zone || '').toString().trim(),
          (e.ward || '').toString().trim(),
          (e.site_code || '').toString().trim(),
          pinHash,
          companyId,
        ]
      );
      if (result.rowCount > 0) {
        added++;
        if (pinHash) pinsSet.push({ employee_id, pin: rawPin });
        // Only set a salary structure for employees actually added in this import (existing
        // employees are left untouched — bulk import never overwrites current data/salary).
        // A row is skipped only if it has no salary fields at all, so plain employee-only
        // imports don't create a bunch of empty salaries rows.
        const hasSalaryData = ['basic_salary', 'hra', 'other_allowances', 'deductions', 'pf', 'esic']
          .some(f => e[f] !== undefined && e[f] !== null && String(e[f]).trim() !== '');
        if (hasSalaryData) {
          await client.query(
            `INSERT INTO salaries (employee_id, basic_salary, hra, other_allowances, deductions, pf, esic, updated_at, company_id)
             VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), $8)
             ON CONFLICT (company_id, employee_id) DO NOTHING`,
            [
              employee_id,
              Number(e.basic_salary) || 0,
              Number(e.hra) || 0,
              Number(e.other_allowances) || 0,
              Number(e.deductions) || 0,
              Number(e.pf) || 0,
              Number(e.esic) || 0,
              companyId,
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
    pinsSet,
  });
});

router.put('/:employeeId', async (req, res) => {
  const { name, designation, phone, email, location, doj, active, project, shift_category, zone, ward, site_code, pin } = req.body;
  const companyId = req.user.company_id;
  const { rows } = await pool.query('SELECT * FROM employees WHERE employee_id = $1 AND company_id = $2', [req.params.employeeId, companyId]);
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
    const projectResult = await resolveProject(pool, project, companyId);
    if (!projectResult.ok) {
      return res.status(400).json({ error: `"${projectResult.name}" is not a known project. Add it first under Manage Projects, or pick one from the dropdown.` });
    }
    resolvedProject = projectResult.name;
  }

  let resolvedShift = existing.shift_category;
  if (shift_category !== undefined) {
    const shiftResult = await resolveShiftCategory(pool, shift_category, companyId);
    if (!shiftResult.ok) {
      return res.status(400).json({ error: `"${shiftResult.name}" is not a known shift category. Add it first under Manage Shift Categories, or pick one from the dropdown.` });
    }
    resolvedShift = shiftResult.name;
  }

  await pool.query(
    'UPDATE employees SET name = $1, designation = $2, phone = $3, email = $4, location = $5, doj = $6, active = $7, project = $8, shift_category = $9, zone = $10, ward = $11, site_code = $12, pin_hash = $13 WHERE employee_id = $14 AND company_id = $15',
    [
      name ?? existing.name,
      designation ?? existing.designation,
      phone ?? existing.phone,
      email !== undefined ? ((email || '').trim() || null) : existing.email,
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
      companyId,
    ]
  );
  res.json({ message: 'Employee updated' });
});

router.delete('/:employeeId', async (req, res) => {
  const result = await pool.query(
    'DELETE FROM employees WHERE employee_id = $1 AND company_id = $2',
    [req.params.employeeId, req.user.company_id]
  );
  if (result.rowCount === 0) return res.status(404).json({ error: 'Employee not found' });
  res.json({ message: 'Employee deleted' });
});

// Bank details — used for the OT payment batch export (routes/overtime.js). Kept as its own
// small endpoint rather than folded into the general PUT /:employeeId above so a manager
// building the regular Edit Employee form doesn't need to also carry bank fields around.
// PUT /api/employees/:employeeId/bank  body: { bank_account_holder, bank_account_number, bank_ifsc, bank_name }
router.put('/:employeeId/bank', async (req, res) => {
  const { rows } = await pool.query('SELECT employee_id FROM employees WHERE employee_id = $1 AND company_id = $2', [req.params.employeeId, req.user.company_id]);
  if (!rows[0]) return res.status(404).json({ error: 'Employee not found' });

  const { bank_account_holder, bank_account_number, bank_ifsc, bank_name } = req.body;
  if (bank_ifsc && !/^[A-Za-z]{4}0[A-Za-z0-9]{6}$/.test(bank_ifsc.trim())) {
    return res.status(400).json({ error: 'IFSC looks invalid (expected format: e.g. HDFC0001234)' });
  }

  await pool.query(
    `UPDATE employees SET bank_account_holder = $1, bank_account_number = $2, bank_ifsc = $3, bank_name = $4
     WHERE employee_id = $5 AND company_id = $6`,
    [
      (bank_account_holder || '').trim() || null,
      (bank_account_number || '').trim() || null,
      (bank_ifsc || '').trim().toUpperCase() || null,
      (bank_name || '').trim() || null,
      req.params.employeeId, req.user.company_id,
    ]
  );
  res.json({ message: 'Bank details updated' });
});

module.exports = router;
