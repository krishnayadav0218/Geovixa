// Managers/Coordinators are locked to one or more Projects, assigned by the Admin when their
// account was created (stored on admins.project). Usually that's a single real project name
// (e.g. "MCGM HK"), but the Admin can also assign a *group* key like "MCGM" — see
// projectGroups.js — so one login (e.g. "krishna_mcgm") gets access to all 3 real MCGM parts
// at once. Whatever project filter they pass in query params is ignored; the project(s) baked
// into their own JWT always win. Admin accounts have no lock and can see everything, or filter
// by a real project name / a group key, same as before.
//
// report_viewer accounts (custom roles like Area Officer/Supervisor — see routes/auth.js
// "role accounts") work the same way for Project, but are ALSO locked to specific
// Zone(s)/Ward(s)/Location(s) inside that Project — see effectiveReportScope() below, used
// only by routes/export.js since these accounts only ever touch Reports.
//
// This one function is reused by every route that returns employee/attendance/report data, so
// a new project (or a coordinator scoped to a group) is automatically covered everywhere —
// nothing here is hardcoded to a specific project name.
const { expandToRealProjects } = require('./projectGroups');

const LOCKED_ROLES = ['manager', 'coordinator', 'report_viewer'];

async function effectiveProjects(req, pool) {
  const companyId = req.user && req.user.company_id;
  if (req.user && LOCKED_ROLES.includes(req.user.role)) {
    return expandToRealProjects(pool, req.user.project || null, companyId);
  }
  // admin (or anything else) — respect whatever project filter was requested, if any
  const requested = (req.query && req.query.project) || null;
  return expandToRealProjects(pool, requested, companyId);
}

// Splits a comma-separated scope value ("Ward K/West, Ward A") into a trimmed array, or
// returns null for an empty/missing value (meaning "no filter / everything").
function splitScopeValue(raw) {
  if (!raw) return null;
  const parts = raw.split(',').map((s) => s.trim()).filter(Boolean);
  return parts.length ? parts : null;
}

// Used only by routes/export.js (Reports). Returns { projects, zone, ward, location } where
// each of zone/ward/location is either null (no filter) or an array of allowed values.
//   - admin/manager/coordinator: zone/ward/location come from whatever the person typed into
//     the report filter fields (query params) — same optional filtering as before.
//   - report_viewer (Area Officer/Supervisor/etc.): zone/ward/location are instead forced to
//     whatever the Admin locked onto their account (admins.scope_zone/scope_ward/
//     scope_location) — any query params they send are ignored, exactly like project already is.
async function effectiveReportScope(req, pool) {
  const projects = await effectiveProjects(req, pool);

  if (req.user && req.user.role === 'report_viewer') {
    return {
      projects,
      zone: splitScopeValue(req.user.scope_zone),
      ward: splitScopeValue(req.user.scope_ward),
      location: splitScopeValue(req.user.scope_location),
    };
  }

  const q = req.query || {};
  return {
    projects,
    zone: splitScopeValue(q.zone),
    ward: splitScopeValue(q.ward),
    location: splitScopeValue(q.location),
  };
}

module.exports = { effectiveProjects, effectiveReportScope };
