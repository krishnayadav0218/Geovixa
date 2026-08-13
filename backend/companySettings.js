// Per-company customization: the super_admin (platform owner) can control, PER COMPANY,
// which optional Report columns show up in the Excel exports (routes/export.js), and which
// optional FEATURES (Leave Applications, Grievances, Salary Slips, Shift Cycle Report) are
// switched on for that company at all. Different client companies can want very different
// things here — e.g. a small security-guard client may not care about Zone/Ward/Site Code
// columns or the Shift Cycle Report at all, while an MCGM-style client needs all of it.
//
// Stored as a single JSONB column (companies.settings). Every read goes through
// mergeSettings() so a brand-new setting added here in the future automatically defaults to
// "on" for every existing company, without needing a migration to backfill it.

const DEFAULT_SETTINGS = {
  // Optional FUNCTIONS/MODULES a company can have switched on or off. When a feature is
  // off: the employee-facing "raise a request" endpoint for it is blocked (see
  // routes/leave.js, routes/grievance.js, routes/salary.js), the Shift Cycle report route
  // is blocked (routes/export.js), and the frontend hides the corresponding nav tab/button.
  features: {
    leave: true,               // Leave Applications (employee apply, admin/manager/coordinator approve)
    grievance: true,           // Raise a Concern / Grievances
    salary: true,              // Salary Slip requests + PDF slips
    shift_cycle_report: true,  // "8 Hrs - FA" Morning/Afternoon/Night shift-cycle Excel report
    reliever: true,            // Reliever assignment (cover for weekly-off/absent employees)
    overtime: true,            // OT auto-calculation, HR approval, and payment batch export
    maintenance: true,         // Facility maintenance tickets + SLA
    client_portal: true,       // Read-only client accounts scoped to their sites
    sos: true,                 // Employee SOS panic button
    announcements: true,       // Company-wide/site broadcast messages
  },
  // Optional COLUMNS shown in the Attendance / P-HD-A Summary / Employee Data Excel reports
  // (routes/export.js). Core identity/attendance columns (Employee ID, Name, Date,
  // On/Off Duty, Day Status, Status, Added On) are always shown and can't be turned off —
  // only these extra detail columns are toggleable.
  report_columns: {
    designation: true,
    project: true,
    shift_category: true,
    zone: true,
    ward: true,
    site_code: true,
    phone: true,
    location: true,
    doj: true,               // Date of Joining
    on_duty_location: true,
    off_duty_location: true,
    working_hours: true,
  },
  // Which SIDEBAR NAV SECTIONS each role (admin / manager / coordinator) can see for this
  // company — fully super_admin-controlled, per company. This is the frontend-visibility
  // layer only; final access to sensitive nav items (Managers/Coordinators/Settings) is still
  // also enforced by the actual API routes underneath (verifyAdmin etc. in middleware.js), so
  // turning a nav item ON here for a role that isn't allowed by the backend won't grant real
  // access — this is purely about decluttering the sidebar per company/role, not a security
  // boundary by itself.
  // Defaults below intentionally match the app's original hardcoded behaviour (Manager/
  // Coordinator never saw Managers/Coordinators/Settings; Admin saw everything) so nothing
  // changes for a company until the super_admin actively customizes it.
  role_permissions: {
    admin: {
      attendance: true, reports: true, employees: true,
      salary_requests: true, leave_requests: true, grievances: true,
      managers: true, coordinators: true, settings: true,
      reliever: true, overtime: true,
      maintenance: true, client_portal: true, sos: true, announcements: true,
    },
    manager: {
      attendance: true, reports: true, employees: true,
      salary_requests: true, leave_requests: true, grievances: true,
      managers: false, coordinators: false, settings: false,
      reliever: true, overtime: true,
      maintenance: true, client_portal: false, sos: true, announcements: true,
    },
    coordinator: {
      attendance: true, reports: true, employees: true,
      salary_requests: true, leave_requests: true, grievances: true,
      managers: false, coordinators: false, settings: false,
      reliever: true, overtime: false,
      maintenance: true, client_portal: false, sos: true, announcements: false,
    },
  },
};

// Deep-merges a possibly-partial/legacy settings object (as stored in companies.settings)
// over the current defaults, so missing keys always resolve to "on" rather than undefined.
function mergeSettings(raw) {
  const r = raw || {};
  const rp = r.role_permissions || {};
  return {
    features: { ...DEFAULT_SETTINGS.features, ...(r.features || {}) },
    report_columns: { ...DEFAULT_SETTINGS.report_columns, ...(r.report_columns || {}) },
    role_permissions: {
      admin: { ...DEFAULT_SETTINGS.role_permissions.admin, ...(rp.admin || {}) },
      manager: { ...DEFAULT_SETTINGS.role_permissions.manager, ...(rp.manager || {}) },
      coordinator: { ...DEFAULT_SETTINGS.role_permissions.coordinator, ...(rp.coordinator || {}) },
    },
  };
}

// Fetches and merges one company's settings. Used by every route that needs to know which
// features/columns are enabled for the currently logged-in user's company.
async function getCompanySettings(pool, companyId) {
  const { rows } = await pool.query('SELECT settings FROM companies WHERE id = $1', [companyId]);
  return mergeSettings(rows[0] && rows[0].settings);
}

// Filters an array of ExcelJS column defs ({ header, key, width, settingKey? }), dropping
// any whose settingKey is explicitly turned off in enabledMap.report_columns. Columns with
// no settingKey (the core/required ones) are always kept.
function filterReportColumns(columnDefs, enabledColumnsMap) {
  return columnDefs.filter(c => !c.settingKey || enabledColumnsMap[c.settingKey] !== false);
}

// Fetches a company's name + merged settings in one query — used by every Excel/PDF export
// route so the workbook author and each downloaded file's name reflect the actual company
// (instead of a hardcoded "Geovixa"), while also getting the report_columns/features needed
// for that same export in a single round trip.
async function getCompanyBranding(pool, companyId) {
  const { rows } = await pool.query('SELECT name, settings FROM companies WHERE id = $1', [companyId]);
  const row = rows[0] || {};
  return { name: row.name || 'Geovixa', settings: mergeSettings(row.settings) };
}

// Turns a company name into a safe Excel/PDF filename fragment — letters/numbers only,
// spaces and punctuation collapsed to underscores (e.g. "Acme Facilities Pvt. Ltd." ->
// "Acme_Facilities_Pvt_Ltd"). Falls back to "Geovixa" if the result would otherwise be empty.
function filenameSafe(name) {
  const cleaned = (name || '').replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return cleaned || 'Geovixa';
}

// Checks whether a given role (admin/manager/coordinator) has a specific sidebar nav section
// enabled for this company (see role_permissions in DEFAULT_SETTINGS above). Used as a real
// backend guard — not just cosmetic sidebar hiding — on the routes behind each of those nav
// sections (Employees, Attendance Log, Reports). Any other role (employee, report_viewer,
// super_admin) isn't governed by this per-company nav system at all, so always allowed here.
async function checkRolePermission(pool, companyId, role, navKey) {
  if (!['admin', 'manager', 'coordinator'].includes(role)) return true;
  const settings = await getCompanySettings(pool, companyId);
  const rolePerms = settings.role_permissions[role];
  return !rolePerms || rolePerms[navKey] !== false;
}

module.exports = { DEFAULT_SETTINGS, mergeSettings, getCompanySettings, filterReportColumns, getCompanyBranding, filenameSafe, checkRolePermission };
