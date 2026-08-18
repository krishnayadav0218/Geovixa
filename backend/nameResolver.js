// Fixes a real gap: employees.project / employees.shift_category were stored as raw free
// text with no check against the admin-managed projects / shift_categories tables. A typo
// or case difference (e.g. "MCGM Hk" instead of "MCGM HK") would silently create an employee
// that never shows up under any project filter, and — worse — could silently escape a
// Manager/Coordinator's project-lock (see projectScope.js) since that lock is a plain string
// match. These helpers normalize incoming project/shift-category names to the exact spelling
// already on file, and report clearly when a name doesn't match anything, instead of failing
// silently.
//
// Every lookup is scoped to a single company (companyId) — two different companies can each
// have their own "MTDC" project or "8 Hrs - FA" shift category without clashing.

// Returns the canonical name from `table` that matches `value` case/whitespace-insensitively
// WITHIN the given company, or null if nothing matches (including when value is blank —
// blank is always allowed, it just means "no project assigned yet").
async function resolveName(pool, table, value, companyId) {
  const trimmed = (value || '').toString().trim();
  if (!trimmed) return { ok: true, name: '' };

  const { rows } = await pool.query(
    `SELECT name FROM ${table} WHERE company_id = $1 AND LOWER(name) = LOWER($2)`,
    [companyId, trimmed]
  );
  if (rows.length === 0) return { ok: false, name: trimmed };
  return { ok: true, name: rows[0].name };
}

async function resolveProject(pool, value, companyId) {
  return resolveName(pool, 'projects', value, companyId);
}

async function resolveShiftCategory(pool, value, companyId) {
  return resolveName(pool, 'shift_categories', value, companyId);
}

module.exports = { resolveProject, resolveShiftCategory };
