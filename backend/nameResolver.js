// Fixes a real gap: employees.project / employees.shift_category were stored as raw free
// text with no check against the admin-managed projects / shift_categories tables. A typo
// or case difference (e.g. "MCGM Hk" instead of "MCGM HK") would silently create an employee
// that never shows up under any project filter, and — worse — could silently escape a
// Manager/Coordinator's project-lock (see projectScope.js) since that lock is a plain string
// match. These helpers normalize incoming project/shift-category names to the exact spelling
// already on file, and report clearly when a name doesn't match anything, instead of failing
// silently.

// Returns the canonical name from `table` that matches `value` case/whitespace-insensitively,
// or null if nothing matches (including when value is blank — blank is always allowed, it
// just means "no project assigned yet").
async function resolveName(pool, table, value) {
  const trimmed = (value || '').toString().trim();
  if (!trimmed) return { ok: true, name: '' };

  const { rows } = await pool.query(`SELECT name FROM ${table} WHERE LOWER(name) = LOWER($1)`, [trimmed]);
  if (rows.length === 0) return { ok: false, name: trimmed };
  return { ok: true, name: rows[0].name };
}

async function resolveProject(pool, value) {
  return resolveName(pool, 'projects', value);
}

async function resolveShiftCategory(pool, value) {
  return resolveName(pool, 'shift_categories', value);
}

module.exports = { resolveProject, resolveShiftCategory };
