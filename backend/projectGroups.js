// Projects can be grouped by the Admin (Manage Projects panel -> Edit -> Group Name).
// Any two or more projects that share the same Group Name become one combined group, e.g.
// MCGM / MCGM HK / MCGM Education all set to Group Name "MCGM" -> the admin's Employees
// sidebar shows a single combined "MCGM" entry instead of 3, and a single Manager/Coordinator
// login can be given access to all of them at once just by assigning "MCGM" as their project.
// Every individual employee/attendance/salary record still stores its real, separate project
// name exactly as before — nothing about the underlying data is merged, only the
// navigation/access is. This replaces the old hardcoded "any project starting with MCGM"
// rule with fully admin-editable data (see projects.name-based migration in db.js for the
// one-time backfill that keeps existing MCGM installs working unchanged).
const LEGACY_GROUPS = {
  // Kept only as a defensive fallback for any project that (for whatever reason) never got
  // migrated to have group_name set — should not normally be needed after the db.js migration.
  MCGM: {
    matches: (name) => (name || '').trim().toUpperCase().startsWith('MCGM'),
  },
};

// Expands a raw "project" value — as stored on admins.project, or passed as ?project= — into
// the real, individual project name(s) it should filter by. Handles:
//   - a plain real project name ("MTDC")             -> ["MTDC"]
//   - a Group Name ("MCGM")                           -> every real project with that group_name
//   - a comma-separated combination ("MTDC,MCGM")      -> the union of the above
// Returns null if rawValue is empty (meaning "no filter / everything").
async function expandToRealProjects(pool, rawValue, companyId) {
  if (!rawValue) return null;
  const parts = rawValue.split(',').map((s) => s.trim()).filter(Boolean);
  if (!parts.length) return null;

  const { rows } = await pool.query('SELECT name, group_name FROM projects WHERE company_id = $1', [companyId]);
  const byName = new Map(rows.map((r) => [r.name, r]));

  const result = new Set();
  parts.forEach((part) => {
    // An exact real project name always wins first.
    if (byName.has(part)) {
      result.add(part);
      return;
    }
    // Otherwise treat it as a Group Name — every project whose group_name matches
    // (case-insensitive) belongs to it.
    const groupMatches = rows.filter(
      (r) => r.group_name && r.group_name.trim().toUpperCase() === part.trim().toUpperCase()
    );
    if (groupMatches.length) {
      groupMatches.forEach((r) => result.add(r.name));
      return;
    }
    // Legacy hardcoded fallback (pre-migration data only).
    const legacy = LEGACY_GROUPS[part.toUpperCase()];
    if (legacy) {
      rows.filter((r) => legacy.matches(r.name)).forEach((r) => result.add(r.name));
      return;
    }
    // Unknown value — keep it literally (defensive, matches old behaviour for typos/edge cases).
    result.add(part);
  });
  return [...result];
}

// Returns every distinct Group Name currently in use, each with its member project names —
// used by the frontend to render combined rows/options without hardcoding "MCGM" anywhere.
async function listGroups(pool, companyId) {
  const { rows } = await pool.query('SELECT name, group_name FROM projects WHERE company_id = $1 ORDER BY name ASC', [companyId]);
  const groups = new Map(); // group_name -> [project names]
  rows.forEach((r) => {
    if (!r.group_name || !r.group_name.trim()) return;
    const key = r.group_name.trim();
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r.name);
  });
  return [...groups.entries()].map(([groupName, members]) => ({ groupName, members }));
}

module.exports = { expandToRealProjects, listGroups };
