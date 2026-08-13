const { pool } = require('./db');
const { rankRelieversForSite } = require('./routes/reliever');
const { logAction } = require('./auditLog');

// Runs one auto-assign pass for a single company: find every site that's currently short of
// required manpower, rank the nearest ~5 free employees for each (by live GPS distance to
// that site — see routes/reliever.js rankRelieversForSite), and force-assign as many of the
// top-ranked candidates as needed to close the gap (capped at 5 per site per pass, so one
// run never empties an entire nearby pool onto a single site).
//
// "Effective shortage" subtracts people ALREADY covering today (accepted or pending reliever
// assignments for that site) from the raw present-vs-required gap, so repeated runs (e.g. the
// background timer in server.js) don't keep stacking more relievers onto a site that's
// already been covered but whose reliever hasn't physically punched in yet.
async function runAutoAssignForCompany(companyId, { systemTriggered = false, actorUsername = 'auto-assign-system' } = {}) {
  const today = new Date().toISOString().slice(0, 10);

  const sites = (await pool.query(
    'SELECT name, required_manpower FROM projects WHERE company_id = $1 AND required_manpower > 0',
    [companyId]
  )).rows;
  if (!sites.length) return { ranSites: 0, assignments: [] };

  const siteNames = sites.map(s => s.name);
  const presentRows = (await pool.query(
    `SELECT e.project, COUNT(DISTINCT a.employee_id)::int AS present
     FROM attendance a JOIN employees e ON e.employee_id = a.employee_id AND e.company_id = a.company_id
     WHERE a.company_id = $1 AND a.attendance_date = $2 AND a.status = 'on_duty' AND e.project = ANY($3::text[])
     GROUP BY e.project`,
    [companyId, today, siteNames]
  )).rows;
  const presentMap = new Map(presentRows.map(r => [r.project, r.present]));

  const coveredRows = (await pool.query(
    `SELECT project, COUNT(*)::int AS c FROM reliever_assignments
     WHERE company_id = $1 AND duty_date = $2 AND status IN ('assigned', 'accepted') GROUP BY project`,
    [companyId, today]
  )).rows;
  const coveredMap = new Map(coveredRows.map(r => [r.project, r.c]));

  const assignments = [];
  const errors = [];

  for (const site of sites) {
    const present = presentMap.get(site.name) || 0;
    const alreadyCovered = coveredMap.get(site.name) || 0;
    const effectiveShortage = Number(site.required_manpower) - present - alreadyCovered;
    if (effectiveShortage <= 0) continue;

    let ranked;
    try {
      const result = await rankRelieversForSite(companyId, site.name, { limit: 5 });
      ranked = result.ranked;
    } catch (err) {
      errors.push({ project: site.name, error: err.message });
      continue;
    }
    if (!ranked.length) continue;

    const toAssign = ranked.slice(0, Math.min(effectiveShortage, 5));
    for (const candidate of toAssign) {
      try {
        const { rows } = await pool.query(
          `INSERT INTO reliever_assignments
             (company_id, original_employee_id, reliever_employee_id, project, duty_date, reason, status, assigned_by, responded_at)
           VALUES ($1, $2, $3, $4, $5, $6, 'accepted', $7, NOW())
           RETURNING id`,
          [companyId, null, candidate.employee_id, site.name, today,
            `Auto-assigned: ${site.name} short ${effectiveShortage} staff (score ${candidate.score}, ${candidate.distance_km != null ? candidate.distance_km + 'km' : 'distance unknown'})`,
            actorUsername]
        );
        assignments.push({ id: rows[0].id, project: site.name, employee_id: candidate.employee_id, name: candidate.name, distance_km: candidate.distance_km, score: candidate.score });
        await logAction({ user: { username: actorUsername, role: 'system', company_id: companyId } }, 'reliever_auto_assigned', {
          targetType: 'reliever_assignment', targetId: rows[0].id,
          targetLabel: `${candidate.employee_id} auto-assigned to ${site.name} (shortage cover)`,
        });
      } catch (err) {
        errors.push({ project: site.name, employee_id: candidate.employee_id, error: err.message });
      }
    }
  }

  return { ranSites: sites.length, assignments, errors };
}

// Background loop — called once from server.js on boot. Runs every 5 minutes, autonomously,
// for every company that has the auto-assign toggle on, with NO dependency on any admin
// having a browser tab open (that's the actual point of "auto" — see routes/reliever.js's
// /auto-assign-settings for the per-company on/off switch admins control).
function startAutoAssignBackgroundLoop(intervalMs = 5 * 60 * 1000) {
  setInterval(async () => {
    try {
      const { rows: enabledCompanies } = await pool.query(
        'SELECT company_id FROM reliever_auto_assign_settings WHERE enabled = true'
      );
      for (const { company_id } of enabledCompanies) {
        try {
          const result = await runAutoAssignForCompany(company_id, { systemTriggered: true });
          if (result.assignments.length) {
            console.log(`🤖 Auto-assign: company ${company_id} — ${result.assignments.length} reliever(s) placed automatically`);
          }
        } catch (err) {
          console.warn(`Auto-assign failed for company ${company_id}:`, err.message);
        }
      }
    } catch (err) {
      console.warn('Auto-assign background loop error:', err.message);
    }
  }, intervalMs);
}

module.exports = { runAutoAssignForCompany, startAutoAssignBackgroundLoop };
