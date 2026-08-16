const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { verifyAdmin, verifyAdminOrManager } = require('../middleware');
const { effectiveProjects } = require('../projectScope');

// GET /api/site-locations?project=MTDC — list locations for one project (or all, if no
// project given), scoped to the caller's own project access.
router.get('/', verifyAdminOrManager, async (req, res) => {
  const scopeProjects = await effectiveProjects(req, pool);
  const params = [req.user.company_id];
  const conditions = ['company_id = $1'];
  if (req.query.project) { params.push(req.query.project); conditions.push(`project = $${params.length}`); }
  if (scopeProjects && scopeProjects.length) { params.push(scopeProjects); conditions.push(`project = ANY($${params.length}::text[])`); }

  const { rows } = await pool.query(
    `SELECT * FROM site_locations WHERE ${conditions.join(' AND ')} ORDER BY project, name`,
    params
  );
  if (!rows.length) return res.json({ count: 0, locations: [] });

  // How many employees are ASSIGNED to each location at all (deployment headcount), and
  // separately how many of those are actually on_duty TODAY (present) — the difference
  // between assigned/present/required is exactly what makes per-location shortage visible,
  // which a project-wide total alone was hiding (see db.js comment on this migration).
  const assignedCounts = (await pool.query(
    'SELECT site_location_id, COUNT(*)::int AS c FROM employees WHERE company_id = $1 AND site_location_id IS NOT NULL GROUP BY site_location_id',
    [req.user.company_id]
  )).rows;
  const assignedMap = new Map(assignedCounts.map(r => [r.site_location_id, r.c]));

  const today = new Date().toISOString().slice(0, 10);
  const presentCounts = (await pool.query(
    `SELECT e.site_location_id, COUNT(DISTINCT a.employee_id)::int AS c
     FROM attendance a JOIN employees e ON e.employee_id = a.employee_id AND e.company_id = a.company_id
     WHERE a.company_id = $1 AND a.attendance_date = $2 AND a.status = 'on_duty' AND e.site_location_id IS NOT NULL
     GROUP BY e.site_location_id`,
    [req.user.company_id, today]
  )).rows;
  const presentMap = new Map(presentCounts.map(r => [r.site_location_id, r.c]));

  res.json({
    count: rows.length,
    locations: rows.map(l => {
      const present = presentMap.get(l.id) || 0;
      const required = Number(l.required_manpower) || 0;
      return {
        ...l,
        employee_count: assignedMap.get(l.id) || 0,
        present_today: present,
        shortage: Math.max(0, required - present),
      };
    }),
  });
});

// POST /api/site-locations  body: { project, name, latitude, longitude, radius_m?, required_manpower? }  (admin only)
router.post('/', verifyAdmin, async (req, res) => {
  const project = (req.body.project || '').trim();
  const name = (req.body.name || '').trim();
  const latitude = Number(req.body.latitude);
  const longitude = Number(req.body.longitude);
  const radius_m = req.body.radius_m != null && req.body.radius_m !== '' ? Number(req.body.radius_m) : 200;
  const required_manpower = req.body.required_manpower != null && req.body.required_manpower !== '' ? Number(req.body.required_manpower) : 0;

  if (!project || !name) return res.status(400).json({ error: 'project and name are required' });
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return res.status(400).json({ error: 'Valid latitude and longitude are required' });

  const { rows: projRows } = await pool.query('SELECT name FROM projects WHERE company_id = $1 AND name = $2', [req.user.company_id, project]);
  if (!projRows[0]) return res.status(400).json({ error: `Unknown project "${project}"` });

  try {
    const { rows } = await pool.query(
      'INSERT INTO site_locations (company_id, project, name, latitude, longitude, radius_m, required_manpower) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id',
      [req.user.company_id, project, name, latitude, longitude, radius_m, required_manpower]
    );
    res.json({ message: 'Location added', id: rows[0].id });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: `A location named "${name}" already exists under ${project}` });
    res.status(500).json({ error: err.message });
  }
});

// POST /api/site-locations/bulk  body: { project, locations: [{ name, latitude, longitude, radius_m? }, ...] }
// (admin only) — for the "100 locations under one project" case: paste a whole batch at
// once instead of the single-add form 100 times. Rows with bad data are skipped and
// reported back individually, matching the pattern used by employees.js's bulk import.
router.post('/bulk', verifyAdmin, async (req, res) => {
  const project = (req.body.project || '').trim();
  const locations = req.body.locations;
  if (!project) return res.status(400).json({ error: 'project is required' });
  if (!Array.isArray(locations) || !locations.length) return res.status(400).json({ error: 'locations array is required' });

  const { rows: projRows } = await pool.query('SELECT name FROM projects WHERE company_id = $1 AND name = $2', [req.user.company_id, project]);
  if (!projRows[0]) return res.status(400).json({ error: `Unknown project "${project}"` });

  const client = await pool.connect();
  let added = 0;
  const skipped = [];
  try {
    await client.query('BEGIN');
    for (let i = 0; i < locations.length; i++) {
      const loc = locations[i];
      const name = (loc.name || '').toString().trim();
      const latitude = Number(loc.latitude);
      const longitude = Number(loc.longitude);
      const radius_m = loc.radius_m != null && loc.radius_m !== '' ? Number(loc.radius_m) : 200;
      const required_manpower = loc.required_manpower != null && loc.required_manpower !== '' ? Number(loc.required_manpower) : 0;

      if (!name || !Number.isFinite(latitude) || !Number.isFinite(longitude)) {
        skipped.push({ row: i + 1, name: name || null, reason: 'Missing name or invalid latitude/longitude' });
        continue;
      }
      try {
        await client.query(
          `INSERT INTO site_locations (company_id, project, name, latitude, longitude, radius_m, required_manpower)
           VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (company_id, project, name) DO UPDATE
           SET latitude = $4, longitude = $5, radius_m = $6, required_manpower = $7`,
          [req.user.company_id, project, name, latitude, longitude, radius_m, required_manpower]
        );
        added++;
      } catch (err) {
        skipped.push({ row: i + 1, name, reason: err.message });
      }
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    return res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
  res.json({ message: `${added} location(s) added/updated`, added, skipped });
});

// PUT /api/site-locations/:id  (admin only)
router.put('/:id', verifyAdmin, async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM site_locations WHERE id = $1 AND company_id = $2', [req.params.id, req.user.company_id]);
  const existing = rows[0];
  if (!existing) return res.status(404).json({ error: 'Location not found' });

  const name = req.body.name !== undefined ? req.body.name.trim() : existing.name;
  const latitude = req.body.latitude !== undefined && req.body.latitude !== '' ? Number(req.body.latitude) : existing.latitude;
  const longitude = req.body.longitude !== undefined && req.body.longitude !== '' ? Number(req.body.longitude) : existing.longitude;
  const radius_m = req.body.radius_m !== undefined && req.body.radius_m !== '' ? Number(req.body.radius_m) : existing.radius_m;
  const required_manpower = req.body.required_manpower !== undefined && req.body.required_manpower !== '' ? Number(req.body.required_manpower) : existing.required_manpower;

  try {
    await pool.query(
      'UPDATE site_locations SET name = $1, latitude = $2, longitude = $3, radius_m = $4, required_manpower = $5 WHERE id = $6 AND company_id = $7',
      [name, latitude, longitude, radius_m, required_manpower, req.params.id, req.user.company_id]
    );
    res.json({ message: 'Location updated' });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: `A location named "${name}" already exists under this project` });
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/site-locations/:id  (admin only) — employees assigned here fall back to their
// project's own geofence (ON DELETE SET NULL on employees.site_location_id), never left broken.
router.delete('/:id', verifyAdmin, async (req, res) => {
  const result = await pool.query('DELETE FROM site_locations WHERE id = $1 AND company_id = $2', [req.params.id, req.user.company_id]);
  if (result.rowCount === 0) return res.status(404).json({ error: 'Location not found' });
  res.json({ message: 'Location removed' });
});

module.exports = router;
