// Managers/Coordinators are each locked to exactly one Project (assigned by the Admin when
// their account was created — e.g. a username like "krishna_mcgmhk" would typically be given
// project "MCGM HK"). Whatever project value they pass in query params is ignored; the project
// baked into their own JWT always wins. Admin accounts have no project lock and can see
// everything (or filter by whichever project they choose in the UI, same as before).
//
// This one function is reused by every route that returns employee/attendance/report data,
// so a new project added tomorrow is automatically covered — nothing here is hardcoded to a
// specific project name.
function effectiveProject(req) {
  if (req.user && (req.user.role === 'manager' || req.user.role === 'coordinator')) {
    return req.user.project || null;
  }
  // admin (or anything else) — respect whatever project filter was requested, if any
  return (req.query && req.query.project) || null;
}

module.exports = { effectiveProject };
