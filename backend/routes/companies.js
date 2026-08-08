const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const { pool } = require('../db');
const { verifySuperAdmin } = require('../middleware');
const { validatePassword, validateCompanyCode } = require('../policy');
const { mergeSettings } = require('../companySettings');
const { saveLogoAndGetUrl, deleteLogoFile } = require('../logoStorage');

// Everything in this file is PLATFORM-OWNER only (role = 'super_admin', company_id IS NULL).
// This is where you, the person selling Geovixa to multiple companies, create a new company
// and its first Admin account in one step. Regular Admin/Manager/Employee accounts never see
// this file — see routes/auth.js for their (company-scoped) login.
router.use(verifySuperAdmin);

// GET /api/companies -> list every company, with a quick employee/admin count for each
router.get('/', async (req, res) => {
  const { rows } = await pool.query(`
    SELECT c.id, c.name, c.code, c.active, c.contact_email, c.contact_phone, c.created_at, c.settings, c.logo_url,
           (SELECT COUNT(*)::int FROM employees e WHERE e.company_id = c.id) AS employee_count,
           (SELECT COUNT(*)::int FROM admins a WHERE a.company_id = c.id AND a.role = 'admin') AS admin_count
    FROM companies c
    ORDER BY c.created_at DESC
  `);
  const companies = rows.map(c => ({ ...c, settings: mergeSettings(c.settings) }));
  res.json({ count: companies.length, companies });
});

// POST /api/companies -> onboard a brand-new company + its first Admin account, in one step.
// body: { name, code, contact_email?, contact_phone?, admin_username, admin_password,
//         features?, report_columns? }
router.post('/', async (req, res) => {
  const { name, code, contact_email, contact_phone, admin_username, admin_password, features, report_columns } = req.body;

  if (!name || !name.trim()) {
    return res.status(400).json({ error: 'Company name is required' });
  }
  const codeCheck = validateCompanyCode(code);
  if (!codeCheck.ok) {
    return res.status(400).json({ error: codeCheck.error });
  }
  if (!admin_username || !admin_username.trim()) {
    return res.status(400).json({ error: "This company's first Admin username is required" });
  }
  const passCheck = validatePassword(admin_password);
  if (!passCheck.ok) {
    return res.status(400).json({ error: passCheck.error });
  }
  const settings = mergeSettings({ features, report_columns });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const companyResult = await client.query(
      'INSERT INTO companies (name, code, active, contact_email, contact_phone, settings) VALUES ($1, $2, 1, $3, $4, $5) RETURNING id',
      [name.trim(), codeCheck.code, (contact_email || '').trim() || null, (contact_phone || '').trim() || null, JSON.stringify(settings)]
    );
    const companyId = companyResult.rows[0].id;

    const hash = bcrypt.hashSync(admin_password, 10);
    await client.query(
      "INSERT INTO admins (username, password_hash, role, company_id) VALUES ($1, $2, 'admin', $3)",
      [admin_username.trim(), hash, companyId]
    );

    // Every new company also gets a starter set of Projects + Shift Categories, same as a
    // fresh single-company install used to get on first boot — see db.js seeding logic.
    const defaultProjects = ['MTDC', 'MCGM HK', 'MCGM', 'Security', 'MCGM Education', 'Others'];
    for (const p of defaultProjects) {
      await client.query('INSERT INTO projects (company_id, name) VALUES ($1, $2) ON CONFLICT (company_id, name) DO NOTHING', [companyId, p]);
    }
    const defaultShifts = [
      ['12 Hrs - HK', 12, 6],
      ['12 Hrs - ATT', 12, 6],
      ['8 Hrs - FA', 8, 4],
      ['9 Hrs - General', 9, 4.5],
    ];
    for (const [sName, full, half] of defaultShifts) {
      await client.query(
        'INSERT INTO shift_categories (company_id, name, full_hours, half_hours) VALUES ($1, $2, $3, $4) ON CONFLICT (company_id, name) DO NOTHING',
        [companyId, sName, full, half]
      );
    }

    await client.query('COMMIT');
    res.json({
      message: 'Company created successfully',
      company: { id: companyId, name: name.trim(), code: codeCheck.code, settings },
    });
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.code === '23505') {
      return res.status(409).json({ error: 'This Company Code (or Admin username) is already in use' });
    }
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// PUT /api/companies/:id/logo -> upload/replace this company's logo (prints on their salary
// slip PDFs alongside their name, see routes/salary.js). body: { logo: 'data:image/png;base64,...' }
router.put('/:id/logo', async (req, res) => {
  const { logo } = req.body;
  const { rows } = await pool.query('SELECT logo_url FROM companies WHERE id = $1', [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'Company not found' });

  let logoUrl;
  try {
    logoUrl = saveLogoAndGetUrl(req.params.id, logo, rows[0].logo_url);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  await pool.query('UPDATE companies SET logo_url = $1 WHERE id = $2', [logoUrl, req.params.id]);
  res.json({ message: 'Logo uploaded successfully', logo_url: logoUrl });
});

// DELETE /api/companies/:id/logo -> remove this company's logo (their salary slips fall
// back to a text-only header with just their name — see routes/salary.js)
router.delete('/:id/logo', async (req, res) => {
  const { rows } = await pool.query('SELECT logo_url FROM companies WHERE id = $1', [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'Company not found' });

  deleteLogoFile(rows[0].logo_url);
  await pool.query('UPDATE companies SET logo_url = NULL WHERE id = $1', [req.params.id]);
  res.json({ message: 'Logo removed' });
});

// PUT /api/companies/:id/settings -> customize which optional Report columns and which
// optional Functions (Leave/Grievance/Salary/Shift Cycle Report) are enabled for this
// company. body: { features?: {...}, report_columns?: {...} } — only the keys you send are
// changed; anything omitted keeps its current value.
router.put('/:id/settings', async (req, res) => {
  const { features, report_columns } = req.body;
  const { rows } = await pool.query('SELECT settings FROM companies WHERE id = $1', [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'Company not found' });

  const current = mergeSettings(rows[0].settings);
  const updated = mergeSettings({
    features: { ...current.features, ...(features || {}) },
    report_columns: { ...current.report_columns, ...(report_columns || {}) },
  });

  await pool.query('UPDATE companies SET settings = $1 WHERE id = $2', [JSON.stringify(updated), req.params.id]);
  res.json({ message: 'Company settings updated successfully', settings: updated });
});

// PUT /api/companies/:id -> edit a company's name / code / active status / contact info
router.put('/:id', async (req, res) => {
  const { name, code, active, contact_email, contact_phone } = req.body;
  const { rows } = await pool.query('SELECT * FROM companies WHERE id = $1', [req.params.id]);
  const existing = rows[0];
  if (!existing) return res.status(404).json({ error: 'Company not found' });

  let newCode = existing.code;
  if (code !== undefined) {
    const codeCheck = validateCompanyCode(code);
    if (!codeCheck.ok) return res.status(400).json({ error: codeCheck.error });
    newCode = codeCheck.code;
  }
  if (name !== undefined && !name.trim()) {
    return res.status(400).json({ error: 'Company name cannot be empty' });
  }

  try {
    await pool.query(
      'UPDATE companies SET name = $1, code = $2, active = $3, contact_email = $4, contact_phone = $5 WHERE id = $6',
      [
        name !== undefined ? name.trim() : existing.name,
        newCode,
        active !== undefined ? (active ? 1 : 0) : existing.active,
        contact_email !== undefined ? ((contact_email || '').trim() || null) : existing.contact_email,
        contact_phone !== undefined ? ((contact_phone || '').trim() || null) : existing.contact_phone,
        req.params.id,
      ]
    );
    res.json({ message: 'Company updated successfully' });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'This Company Code is already in use' });
    }
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/companies/:id/reset-admin-password -> reset a company's (first) Admin password —
// useful if a client company's Admin ever gets locked out and can't self-service it.
// body: { new_password }
router.put('/:id/reset-admin-password', async (req, res) => {
  const { new_password } = req.body;
  const passCheck = validatePassword(new_password);
  if (!passCheck.ok) return res.status(400).json({ error: passCheck.error });

  const { rows } = await pool.query(
    "SELECT id FROM admins WHERE company_id = $1 AND role = 'admin' ORDER BY id ASC LIMIT 1",
    [req.params.id]
  );
  const admin = rows[0];
  if (!admin) return res.status(404).json({ error: 'No Admin account found for this company' });

  const hash = bcrypt.hashSync(new_password, 10);
  await pool.query('UPDATE admins SET password_hash = $1 WHERE id = $2', [hash, admin.id]);
  res.json({ message: 'Admin password reset successfully' });
});

// DELETE /api/companies/:id -> only allowed if the company has no employees left (safety
// net against accidentally wiping a live customer's data) — deactivate instead if unsure.
router.delete('/:id', async (req, res) => {
  const empCount = await pool.query('SELECT COUNT(*)::int AS count FROM employees WHERE company_id = $1', [req.params.id]);
  if (empCount.rows[0].count > 0) {
    return res.status(409).json({
      error: `This company still has ${empCount.rows[0].count} employee(s) on file. Deactivate it instead of deleting, or remove all employees first.`,
    });
  }

  const existing = await pool.query('SELECT logo_url FROM companies WHERE id = $1', [req.params.id]);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM admins WHERE company_id = $1', [req.params.id]);
    await client.query('DELETE FROM projects WHERE company_id = $1', [req.params.id]);
    await client.query('DELETE FROM shift_categories WHERE company_id = $1', [req.params.id]);
    await client.query('DELETE FROM custom_roles WHERE company_id = $1', [req.params.id]);
    const result = await client.query('DELETE FROM companies WHERE id = $1', [req.params.id]);
    if (result.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Company not found' });
    }
    await client.query('COMMIT');
    if (existing.rows[0]) deleteLogoFile(existing.rows[0].logo_url);
    res.json({ message: 'Company removed' });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

module.exports = router;
