// Managers/Coordinators are locked to one or more Projects, assigned by the Admin when their
// account was created (stored on admins.project). Usually that's a single real project name
// (e.g. "MCGM HK"), but the Admin can also assign a *group* key like "MCGM" — see
// projectGroups.js — so one login (e.g. "krishna_mcgm") gets access to all 3 real MCGM parts
// at once. Whatever project filter they pass in query params is ignored; the project(s) baked
// into their own JWT always win. Admin accounts have no lock and can see everything, or filter
// by a real project name / a group key, same as before.
//
// This one function is reused by every route that returns employee/attendance/report data, so
// a new project (or a coordinator scoped to a group) is automatically covered everywhere —
// nothing here is hardcoded to a specific project name.
const { expandToRealProjects } = require('./projectGroups');

async function effectiveProjects(req, pool) {
  if (req.user && (req.user.role === 'manager' || req.user.role === 'coordinator')) {
    return expandToRealProjects(pool, req.user.project || null);
  }
  // admin (or anything else) — respect whatever project filter was requested, if any
  const requested = (req.query && req.query.project) || null;
  return expandToRealProjects(pool, requested);
}

module.exports = { effectiveProjects };
