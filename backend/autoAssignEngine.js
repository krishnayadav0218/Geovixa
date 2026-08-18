const { pool } = require('./db');
const { rankRelieversForSite } = require('./routes/reliever');
const { logAction } = require('./auditLog');

// Runs one auto-assign pass for a single company: finds every shortage — BOTH whole-project
// (projects.required_manpower) AND individual sub-location (site_locations.required_manpower,
// for projects split across many physical spots, e.g. 100 buildings under one project) — ranks
// the nearest ~5 free employees for each (by live GPS distance to that specific shortage
// point — see routes/reliever.js rankRelieversForSite), and force-assigns as many of the
// top-ranked candidates as needed to close the gap (capped at 5 per shortage per pass, so one
// run never empties an entire nearby pool onto a single spot).
//
// "Effective shortage" subtracts people ALREADY covering today (accepted or pending reliever
// assignments for that exact site/location) from the raw present-vs-required gap, so repeated
// runs (e.g. the background timer in server.js) don't keep stacking more relievers onto
// somewhere already covered but whose reliever hasn't physically punched in yet.
async function runAutoAssignForCompany(companyId, { systemTriggered = false, actorUsername = 'auto-assign-system' } = {}) {
  const today = new Date().toISOString().slice(0, 10);
  const assignments = [];
  const errors = [];

  // --- Pass 1: whole-project shortages (unchanged from before sub-locations existed) ---
  const projectSites = (await pool.query(
    'SELECT name, required_manpower FROM projects WHERE company_id = $1 AND required_manpower > 0',
    [companyId]
  )).rows;

  if (projectSites.length) {
    const siteNames = projectSites.map(s => s.name);
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
       WHERE company_id = $1 AND duty_date = $2 AND status IN ('assigned', 'accepted') AND site_location_id IS NULL GROUP BY project`,
      [companyId, today]
    )).rows;
    const coveredMap = new Map(coveredRows.map(r => [r.project, r.c]));

    for (const site of projectSites) {
      const present = presentMap.get(site.name) || 0;
      const alreadyCovered = coveredMap.get(site.name) || 0;
      const effectiveShortage = Number(site.required_manpower) - present - alreadyCovered;
      if (effectiveShortage <= 0) continue;
      await assignNearestCandidates({
        companyId, today, project: site.name, siteLocationId: null, label: site.name,
        effectiveShortage, actorUsername, assignments, errors,
      });
    }
  }

  // --- Pass 2: sub-location shortages — the actual fix for "shortage hides inside a
  // healthy-looking project total" (e.g. one building down 2 people while another building
  // in the same project has 2 extra) ---
  const locations = (await pool.query(
    'SELECT id, project, name, required_manpower FROM site_locations WHERE company_id = $1 AND required_manpower > 0',
    [companyId]
  )).rows;

  if (locations.length) {
    const locIds = locations.map(l => l.id);
    const presentRows = (await pool.query(
      `SELECT e.site_location_id, COUNT(DISTINCT a.employee_id)::int AS present
       FROM attendance a JOIN employees e ON e.employee_id = a.employee_id AND e.company_id = a.company_id
       WHERE a.company_id = $1 AND a.attendance_date = $2 AND a.status = 'on_duty' AND e.site_location_id = ANY($3::int[])
       GROUP BY e.site_location_id`,
      [companyId, today, locIds]
    )).rows;
    const presentMap = new Map(presentRows.map(r => [r.site_location_id, r.present]));

    const coveredRows = (await pool.query(
      `SELECT site_location_id, COUNT(*)::int AS c FROM reliever_assignments
       WHERE company_id = $1 AND duty_date = $2 AND status IN ('assigned', 'accepted') AND site_location_id = ANY($3::int[]) GROUP BY site_location_id`,
      [companyId, today, locIds]
    )).rows;
    const coveredMap = new Map(coveredRows.map(r => [r.site_location_id, r.c]));

    for (const loc of locations) {
      const present = presentMap.get(loc.id) || 0;
      const alreadyCovered = coveredMap.get(loc.id) || 0;
      const effectiveShortage = Number(loc.required_manpower) - present - alreadyCovered;
      if (effectiveShortage <= 0) continue;
      await assignNearestCandidates({
        companyId, today, project: loc.project, siteLocationId: loc.id, label: `${loc.project} — ${loc.name}`,
        effectiveShortage, actorUsername, assignments, errors,
      });
    }
  }

  return { ranSites: projectSites.length + locations.length, assignments, errors };
}

// Shared by both passes above — ranks candidates for one shortage point (project-wide or a
// specific sub-location, depending on whether siteLocationId is set — rankRelieversForSite
// uses the sub-location's own GPS as the reference point when given one) and force-assigns
// the nearest ones up to the shortage count.
async function assignNearestCandidates({ companyId, today, project, siteLocationId, label, effectiveShortage, actorUsername, assignments, errors }) {
  let ranked;
  try {
    const result = await rankRelieversForSite(companyId, project, { limit: 5, siteLocationId });
    ranked = result.ranked;
  } catch (err) {
    errors.push({ project, site_location_id: siteLocationId, error: err.message });
    return;
  }
  if (!ranked.length) return;

  const toAssign = ranked.slice(0, Math.min(effectiveShortage, 5));
  for (const candidate of toAssign) {
    try {
      const { rows } = await pool.query(
        `INSERT INTO reliever_assignments
           (company_id, original_employee_id, reliever_employee_id, project, site_location_id, duty_date, reason, status, assigned_by, responded_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'accepted', $8, NOW())
         RETURNING id`,
        [companyId, null, candidate.employee_id, project, siteLocationId, today,
          `Auto-assigned: ${label} short ${effectiveShortage} staff (score ${candidate.score}, ${candidate.distance_km != null ? candidate.distance_km + 'km' : 'distance unknown'})`,
          actorUsername]
      );
      assignments.push({ id: rows[0].id, project, site_location_id: siteLocationId, label, employee_id: candidate.employee_id, name: candidate.name, distance_km: candidate.distance_km, score: candidate.score });
      await logAction({ user: { username: actorUsername, role: 'system', company_id: companyId } }, 'reliever_auto_assigned', {
        targetType: 'reliever_assignment', targetId: rows[0].id,
        targetLabel: `${candidate.employee_id} auto-assigned to ${label} (shortage cover)`,
      });
    } catch (err) {
      errors.push({ project, site_location_id: siteLocationId, employee_id: candidate.employee_id, error: err.message });
    }
  }
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
