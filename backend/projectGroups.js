// Some real Projects are actually parts of one bigger client relationship — e.g. MCGM's
// Housekeeping / core / Education wings are staffed and reported on separately (each keeps
// its own employees, attendance, weekly-off day, etc.) but are really "MCGM" as a whole.
//
// This file defines those groupings ONCE so:
//   - the admin's Employees sidebar can show a single combined "MCGM" entry instead of 3,
//   - a single Coordinator/Manager login (e.g. "krishna_mcgm") can be given access to all
//     3 parts at once just by assigning them the group key "MCGM" as their project,
// while every individual employee/attendance/salary record still stores its real, separate
// project name (MCGM / MCGM HK / MCGM Education) exactly as before — nothing about the
// underlying data is merged, only the navigation/access is.
//
// Add more groups later the same way; everything else (routes, project-locking) already
// reads through this file, so no other file needs to change to support a new group.
const PROJECT_GROUPS = {
  MCGM: {
    label: 'MCGM',
    // name-based match — any project whose name starts with "MCGM" belongs to this group,
    // so it keeps working automatically if another MCGM-prefixed project is added later.
    matches: (name) => (name || '').trim().toUpperCase().startsWith('MCGM'),
  },
};

// Expands a raw "project" value — as stored on admins.project, or passed as ?project= — into
// the real, individual project name(s) it should filter by. Handles:
//   - a plain real project name ("MTDC")            -> ["MTDC"]
//   - a group key ("MCGM")                          -> every real project matching that group
//   - a comma-separated combination ("MTDC,MCGM")    -> the union of the above
// Returns null if rawValue is empty (meaning "no filter / everything").
async function expandToRealProjects(pool, rawValue) {
  if (!rawValue) return null;
  const parts = rawValue.split(',').map((s) => s.trim()).filter(Boolean);
  if (!parts.length) return null;

  const { rows } = await pool.query('SELECT name FROM projects');
  const allNames = rows.map((r) => r.name);

  const result = new Set();
  parts.forEach((part) => {
    const group = PROJECT_GROUPS[part.toUpperCase()];
    if (group) {
      allNames.filter((n) => group.matches(n)).forEach((n) => result.add(n));
    } else {
      result.add(part);
    }
  });
  return [...result];
}

module.exports = { PROJECT_GROUPS, expandToRealProjects };
