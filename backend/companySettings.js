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
};

// Deep-merges a possibly-partial/legacy settings object (as stored in companies.settings)
// over the current defaults, so missing keys always resolve to "on" rather than undefined.
function mergeSettings(raw) {
  const r = raw || {};
  return {
    features: { ...DEFAULT_SETTINGS.features, ...(r.features || {}) },
    report_columns: { ...DEFAULT_SETTINGS.report_columns, ...(r.report_columns || {}) },
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

module.exports = { DEFAULT_SETTINGS, mergeSettings, getCompanySettings, filterReportColumns, getCompanyBranding, filenameSafe };
