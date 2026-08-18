const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const ExcelJS = require('exceljs');
const { pool } = require('../db');
const { verifySuperAdmin } = require('../middleware');
const { validatePassword, validateCompanyCode } = require('../policy');
const { mergeSettings } = require('../companySettings');
const { saveLogoAndGetUrl, deleteLogoFile } = require('../logoStorage');
const { logAction } = require('../auditLog');
const { sendCompanyWelcomeEmail } = require('../mailer');
const { generateSecret, verifyToken, buildOtpAuthUrl } = require('../totp');

const VALID_PLANS = ['trial', 'standard', 'premium', 'custom'];

// Everything in this file is PLATFORM-OWNER only (role = 'super_admin', company_id IS NULL).
// This is where you, the person selling Geovixa to multiple companies, create a new company
// and its first Admin account in one step. Regular Admin/Manager/Employee accounts never see
// this file — see routes/auth.js for their (company-scoped) login.
router.use(verifySuperAdmin);

// GET /api/companies/stats -> platform-wide totals for the overview cards at the top of the
// Companies dashboard (total/active/inactive companies, total employees + admins across
// every company combined).
router.get('/stats', async (req, res) => {
  const { rows } = await pool.query(`
    SELECT
      (SELECT COUNT(*)::int FROM companies) AS total_companies,
      (SELECT COUNT(*)::int FROM companies WHERE active = 1) AS active_companies,
      (SELECT COUNT(*)::int FROM companies WHERE active = 0) AS inactive_companies,
      (SELECT COUNT(*)::int FROM employees) AS total_employees,
      (SELECT COUNT(*)::int FROM admins WHERE role = 'admin') AS total_admins
  `);
  res.json(rows[0]);
});

// GET /api/companies/audit-log?limit=100 -> recent platform-owner actions (company create/
// edit/delete/settings changes, logo changes, admin password resets, impersonation). Newest
// first. Read-only history — nothing in the app ever deletes these rows.
router.get('/audit-log', async (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500);
  const { rows } = await pool.query(
    'SELECT * FROM audit_log ORDER BY created_at DESC LIMIT $1',
    [limit]
  );
  res.json({ count: rows.length, entries: rows });
});

// GET /api/companies/export/excel -> download the full companies list (super_admin's own
// internal record-keeping — includes the Notes field, which is never shown to a company's
// own Admin/Manager/Employee accounts).
router.get('/export/excel', async (req, res) => {
  const { rows } = await pool.query(`
    SELECT c.name, c.code, c.active, c.plan, c.expires_at, c.max_employees,
           c.contact_email, c.contact_phone, c.notes, c.created_at,
           (SELECT COUNT(*)::int FROM employees e WHERE e.company_id = c.id) AS employee_count,
           (SELECT COUNT(*)::int FROM admins a WHERE a.company_id = c.id AND a.role = 'admin') AS admin_count
    FROM companies c
    ORDER BY c.created_at DESC
  `);

  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Geovixa';
  const sheet = workbook.addWorksheet('Companies');
  sheet.columns = [
    { header: 'Company Name', key: 'name', width: 26 },
    { header: 'Company Code', key: 'code', width: 16 },
    { header: 'Status', key: 'status', width: 12 },
    { header: 'Plan', key: 'plan', width: 12 },
    { header: 'Expires On', key: 'expires_at', width: 14 },
    { header: 'Max Employees', key: 'max_employees', width: 14 },
    { header: 'Employees', key: 'employee_count', width: 12 },
    { header: 'Admins', key: 'admin_count', width: 10 },
    { header: 'Contact Email', key: 'contact_email', width: 26 },
    { header: 'Contact Phone', key: 'contact_phone', width: 18 },
    { header: 'Notes', key: 'notes', width: 34 },
    { header: 'Added On', key: 'created_at', width: 20 },
  ];
  sheet.getRow(1).font = { bold: true };
  sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD9E1F2' } };

  rows.forEach(c => {
    sheet.addRow({
      name: c.name,
      code: c.code,
      status: c.active ? 'Active' : 'Inactive',
      plan: c.plan,
      expires_at: c.expires_at || 'Never',
      max_employees: c.max_employees || 'Unlimited',
      employee_count: c.employee_count,
      admin_count: c.admin_count,
      contact_email: c.contact_email || '',
      contact_phone: c.contact_phone || '',
      notes: c.notes || '',
      created_at: c.created_at,
    });
  });

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="Geovixa_Companies.xlsx"');
  await workbook.xlsx.write(res);
  res.end();
});

// GET /api/companies -> list every company, with a quick employee/admin count for each
router.get('/', async (req, res) => {
  const { rows } = await pool.query(`
    SELECT c.id, c.name, c.code, c.active, c.contact_email, c.contact_phone, c.notes, c.created_at,
           c.settings, c.logo_url, c.plan, c.expires_at, c.max_employees,
           (SELECT COUNT(*)::int FROM employees e WHERE e.company_id = c.id) AS employee_count,
           (SELECT COUNT(*)::int FROM admins a WHERE a.company_id = c.id AND a.role = 'admin') AS admin_count
    FROM companies c
    ORDER BY c.created_at DESC
  `);
  const companies = rows.map(c => ({ ...c, settings: mergeSettings(c.settings) }));
  res.json({ count: companies.length, companies });
});

// POST /api/companies -> onboard a brand-new company + its first Admin account, in one step.
// body: { name, code, contact_email?, contact_phone?, notes?, admin_username, admin_password,
//         features?, report_columns?, role_permissions?, plan?, expires_at?, max_employees? }
router.post('/', async (req, res) => {
  const {
    name, code, contact_email, contact_phone, notes, admin_username, admin_password,
    features, report_columns, role_permissions, plan, expires_at, max_employees,
  } = req.body;

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
  const chosenPlan = plan && VALID_PLANS.includes(plan) ? plan : 'standard';
  const maxEmp = max_employees !== undefined && max_employees !== null && String(max_employees).trim() !== ''
    ? Math.max(0, parseInt(max_employees, 10)) : null;
  const expiresAt = expires_at && /^\d{4}-\d{2}-\d{2}$/.test(expires_at) ? expires_at : null;
  const settings = mergeSettings({ features, report_columns, role_permissions });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const companyResult = await client.query(
      `INSERT INTO companies (name, code, active, contact_email, contact_phone, notes, settings, plan, expires_at, max_employees)
       VALUES ($1, $2, 1, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
      [
        name.trim(), codeCheck.code,
        (contact_email || '').trim() || null,
        (contact_phone || '').trim() || null,
        (notes || '').trim() || null,
        JSON.stringify(settings),
        chosenPlan, expiresAt, maxEmp,
      ]
    );
    const companyId = companyResult.rows[0].id;

    const hash = bcrypt.hashSync(admin_password, 10);
    await client.query(
      "INSERT INTO admins (username, password_hash, role, company_id) VALUES ($1, $2, 'admin', $3)",
      [admin_username.trim(), hash, companyId]
    );

    // Deliberately NOT seeding any starter Projects/Shift Categories here — a brand-new
    // company should start with a clean Employees section, not Geovixa's own example data
    // (MTDC, MCGM, etc.). Their Admin adds their own Projects/Shift Categories from scratch
    // via Manage Projects / Manage Shift Categories. (The single default/migrated company —
    // see db.js — is the only one that still gets these seeded, purely for pre-existing
    // single-tenant installs upgrading to this multi-company version.)

    await client.query('COMMIT');

    await logAction(req, 'company_created', {
      targetType: 'company', targetId: companyId, targetLabel: name.trim(),
      details: { code: codeCheck.code, plan: chosenPlan, admin_username: admin_username.trim() },
    });

    if (contact_email && contact_email.trim()) {
      const portalUrl = `${req.protocol}://${req.get('host')}/admin`;
      sendCompanyWelcomeEmail({
        to: contact_email.trim(), companyName: name.trim(), companyCode: codeCheck.code,
        adminUsername: admin_username.trim(), portalUrl,
      }); // fire-and-forget — never blocks the response on email delivery
    }

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

// POST /api/companies/:id/impersonate-admin -> issues a real Admin-session token for this
// company's first Admin account, WITHOUT needing that Admin's password — lets the platform
// owner jump straight into a client's portal for support/troubleshooting. Every use is
// logged both to the console AND the audit_log table, since this is a powerful capability.
// The Admin's password itself is never read or exposed.
router.post('/:id/impersonate-admin', async (req, res) => {
  const companyResult = await pool.query('SELECT * FROM companies WHERE id = $1', [req.params.id]);
  const company = companyResult.rows[0];
  if (!company) return res.status(404).json({ error: 'Company not found' });
  if (!company.active) return res.status(400).json({ error: 'This company is inactive — activate it first.' });

  const adminResult = await pool.query(
    "SELECT * FROM admins WHERE company_id = $1 AND role = 'admin' ORDER BY id ASC LIMIT 1",
    [req.params.id]
  );
  const admin = adminResult.rows[0];
  if (!admin) return res.status(404).json({ error: 'No Admin account found for this company' });

  console.log(`[IMPERSONATION] super_admin '${req.user.username}' logged in as Admin '${admin.username}' of company '${company.name}' (id ${company.id}) at ${new Date().toISOString()}`);
  await logAction(req, 'impersonated_admin', {
    targetType: 'company', targetId: company.id, targetLabel: company.name,
    details: { admin_username: admin.username },
  });

  const payload = {
    id: admin.id,
    username: admin.username,
    role: 'admin',
    project: admin.project || null,
    company_id: company.id,
    company_name: company.name,
    company_code: company.code,
    company_logo_url: company.logo_url || null,
  };
  // Shorter-lived than a normal login (2h vs 12h) — this is meant for a quick support dip,
  // not a standing session.
  const token = jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: '2h' });
  const settings = mergeSettings(company.settings);

  res.json({ token, ...payload, settings });
});

// PUT /api/companies/:id/logo -> upload/replace this company's logo (prints on their salary
// slip PDFs alongside their name, see routes/salary.js). body: { logo: 'data:image/png;base64,...' }
router.put('/:id/logo', async (req, res) => {
  const { logo } = req.body;
  const { rows } = await pool.query('SELECT name, logo_url FROM companies WHERE id = $1', [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'Company not found' });

  let logoUrl;
  try {
    logoUrl = saveLogoAndGetUrl(req.params.id, logo, rows[0].logo_url);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  await pool.query('UPDATE companies SET logo_url = $1 WHERE id = $2', [logoUrl, req.params.id]);
  await logAction(req, 'company_logo_changed', { targetType: 'company', targetId: req.params.id, targetLabel: rows[0].name });
  res.json({ message: 'Logo uploaded successfully', logo_url: logoUrl });
});

// DELETE /api/companies/:id/logo -> remove this company's logo (their salary slips fall
// back to a text-only header with just their name — see routes/salary.js)
router.delete('/:id/logo', async (req, res) => {
  const { rows } = await pool.query('SELECT name, logo_url FROM companies WHERE id = $1', [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'Company not found' });

  deleteLogoFile(rows[0].logo_url);
  await pool.query('UPDATE companies SET logo_url = NULL WHERE id = $1', [req.params.id]);
  await logAction(req, 'company_logo_removed', { targetType: 'company', targetId: req.params.id, targetLabel: rows[0].name });
  res.json({ message: 'Logo removed' });
});

// PUT /api/companies/:id/settings -> customize which optional Report columns, which
// optional Functions (Leave/Grievance/Salary/Shift Cycle Report), and which SIDEBAR NAV
// SECTIONS each role (admin/manager/coordinator) can see are enabled for this company.
// body: { features?: {...}, report_columns?: {...}, role_permissions?: { admin?: {...},
// manager?: {...}, coordinator?: {...} } } — only the keys you send are changed; anything
// omitted keeps its current value.
router.put('/:id/settings', async (req, res) => {
  const { features, report_columns, role_permissions } = req.body;
  const { rows } = await pool.query('SELECT name, settings FROM companies WHERE id = $1', [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'Company not found' });

  const current = mergeSettings(rows[0].settings);
  const rp = role_permissions || {};
  const updated = mergeSettings({
    features: { ...current.features, ...(features || {}) },
    report_columns: { ...current.report_columns, ...(report_columns || {}) },
    role_permissions: {
      admin: { ...current.role_permissions.admin, ...(rp.admin || {}) },
      manager: { ...current.role_permissions.manager, ...(rp.manager || {}) },
      coordinator: { ...current.role_permissions.coordinator, ...(rp.coordinator || {}) },
    },
  });

  await pool.query('UPDATE companies SET settings = $1 WHERE id = $2', [JSON.stringify(updated), req.params.id]);
  await logAction(req, 'company_settings_updated', { targetType: 'company', targetId: req.params.id, targetLabel: rows[0].name, details: updated });
  res.json({ message: 'Company settings updated successfully', settings: updated });
});

// PUT /api/companies/:id -> edit a company's name / code / active status / contact info /
// notes / plan / expiry / employee limit
router.put('/:id', async (req, res) => {
  const { name, code, active, contact_email, contact_phone, notes, plan, expires_at, max_employees } = req.body;
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
  let newPlan = existing.plan;
  if (plan !== undefined) {
    if (!VALID_PLANS.includes(plan)) return res.status(400).json({ error: `Plan must be one of: ${VALID_PLANS.join(', ')}` });
    newPlan = plan;
  }
  let newExpiresAt = existing.expires_at;
  if (expires_at !== undefined) {
    newExpiresAt = expires_at && /^\d{4}-\d{2}-\d{2}$/.test(expires_at) ? expires_at : null;
  }
  let newMaxEmployees = existing.max_employees;
  if (max_employees !== undefined) {
    newMaxEmployees = max_employees === null || String(max_employees).trim() === '' ? null : Math.max(0, parseInt(max_employees, 10));
  }

  const wasActive = existing.active;

  try {
    await pool.query(
      `UPDATE companies SET name = $1, code = $2, active = $3, contact_email = $4, contact_phone = $5,
       notes = $6, plan = $7, expires_at = $8, max_employees = $9 WHERE id = $10`,
      [
        name !== undefined ? name.trim() : existing.name,
        newCode,
        active !== undefined ? (active ? 1 : 0) : existing.active,
        contact_email !== undefined ? ((contact_email || '').trim() || null) : existing.contact_email,
        contact_phone !== undefined ? ((contact_phone || '').trim() || null) : existing.contact_phone,
        notes !== undefined ? ((notes || '').trim() || null) : existing.notes,
        newPlan, newExpiresAt, newMaxEmployees,
        req.params.id,
      ]
    );

    const newActive = active !== undefined ? (active ? 1 : 0) : existing.active;
    if (active !== undefined && newActive !== wasActive) {
      await logAction(req, newActive ? 'company_activated' : 'company_deactivated', { targetType: 'company', targetId: req.params.id, targetLabel: existing.name });
    } else {
      await logAction(req, 'company_edited', { targetType: 'company', targetId: req.params.id, targetLabel: name !== undefined ? name.trim() : existing.name });
    }

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
    "SELECT a.id, c.name AS company_name FROM admins a JOIN companies c ON c.id = a.company_id WHERE a.company_id = $1 AND a.role = 'admin' ORDER BY a.id ASC LIMIT 1",
    [req.params.id]
  );
  const admin = rows[0];
  if (!admin) return res.status(404).json({ error: 'No Admin account found for this company' });

  const hash = bcrypt.hashSync(new_password, 10);
  await pool.query('UPDATE admins SET password_hash = $1 WHERE id = $2', [hash, admin.id]);
  await logAction(req, 'admin_password_reset', { targetType: 'company', targetId: req.params.id, targetLabel: admin.company_name });
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

  const existing = await pool.query('SELECT name, logo_url FROM companies WHERE id = $1', [req.params.id]);

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
    await logAction(req, 'company_deleted', { targetType: 'company', targetId: req.params.id, targetLabel: existing.rows[0] && existing.rows[0].name });
    res.json({ message: 'Company removed' });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// ---------------------------------------------------------------------------------------
// TWO-FACTOR AUTHENTICATION (2FA) — for the platform owner's (super_admin) own login only.
// ---------------------------------------------------------------------------------------

// GET /api/companies/2fa/status -> whether 2FA is currently enabled on this super_admin account
router.get('/2fa/status', async (req, res) => {
  const { rows } = await pool.query('SELECT totp_enabled FROM admins WHERE id = $1', [req.user.id]);
  res.json({ enabled: Boolean(rows[0] && rows[0].totp_enabled) });
});

// POST /api/companies/2fa/setup -> generates a NEW secret (not yet enabled) and returns it +
// the otpauth:// URL for scanning/manual entry into an authenticator app. Nothing is saved to
// the account until /2fa/enable confirms the person can actually generate a valid code with it.
router.post('/2fa/setup', async (req, res) => {
  const secret = generateSecret();
  const otpauthUrl = buildOtpAuthUrl(secret, req.user.username, 'Geovixa');
  res.json({ secret, otpauth_url: otpauthUrl });
});

// POST /api/companies/2fa/enable -> body: { secret, token } — confirms the person scanned the
// secret correctly (their authenticator app produced a valid 6-digit code for it) before
// actually turning 2FA on. This is the only place totp_secret gets written.
router.post('/2fa/enable', async (req, res) => {
  const { secret, token } = req.body;
  if (!secret) return res.status(400).json({ error: 'Missing secret — start over from "Enable 2FA"' });
  if (!verifyToken(secret, token)) {
    return res.status(400).json({ error: 'Incorrect code. Check your authenticator app and try again.' });
  }
  await pool.query('UPDATE admins SET totp_secret = $1, totp_enabled = 1 WHERE id = $2', [secret, req.user.id]);
  await logAction(req, '2fa_enabled', { targetType: 'super_admin', targetId: req.user.id, targetLabel: req.user.username });
  res.json({ message: 'Two-factor authentication enabled' });
});

// POST /api/companies/2fa/disable -> body: { password } — requires re-confirming the current
// password before turning 2FA off, since this weakens the account's login security.
router.post('/2fa/disable', async (req, res) => {
  const { password } = req.body;
  const { rows } = await pool.query('SELECT password_hash FROM admins WHERE id = $1', [req.user.id]);
  const account = rows[0];
  if (!account || !bcrypt.compareSync(password || '', account.password_hash)) {
    return res.status(401).json({ error: 'Incorrect password' });
  }
  await pool.query('UPDATE admins SET totp_secret = NULL, totp_enabled = 0 WHERE id = $1', [req.user.id]);
  await logAction(req, '2fa_disabled', { targetType: 'super_admin', targetId: req.user.id, targetLabel: req.user.username });
  res.json({ message: 'Two-factor authentication disabled' });
});

module.exports = router;
