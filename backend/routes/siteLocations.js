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
  // How many employees currently sit at each location — shown in the management UI so an
  // admin can see at a glance which of their 100 locations still need employees assigned.
  const counts = (await pool.query(
    'SELECT site_location_id, COUNT(*)::int AS c FROM employees WHERE company_id = $1 AND site_location_id IS NOT NULL GROUP BY site_location_id',
    [req.user.company_id]
  )).rows;
  const countMap = new Map(counts.map(r => [r.site_location_id, r.c]));
  res.json({ count: rows.length, locations: rows.map(l => ({ ...l, employee_count: countMap.get(l.id) || 0 })) });
});

// POST /api/site-locations  body: { project, name, latitude, longitude, radius_m? }  (admin only)
router.post('/', verifyAdmin, async (req, res) => {
  const project = (req.body.project || '').trim();
  const name = (req.body.name || '').trim();
  const latitude = Number(req.body.latitude);
  const longitude = Number(req.body.longitude);
  const radius_m = req.body.radius_m != null && req.body.radius_m !== '' ? Number(req.body.radius_m) : 200;

  if (!project || !name) return res.status(400).json({ error: 'project and name are required' });
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return res.status(400).json({ error: 'Valid latitude and longitude are required' });

  const { rows: projRows } = await pool.query('SELECT name FROM projects WHERE company_id = $1 AND name = $2', [req.user.company_id, project]);
  if (!projRows[0]) return res.status(400).json({ error: `Unknown project "${project}"` });

  try {
    const { rows } = await pool.query(
      'INSERT INTO site_locations (company_id, project, name, latitude, longitude, radius_m) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id',
      [req.user.company_id, project, name, latitude, longitude, radius_m]
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

      if (!name || !Number.isFinite(latitude) || !Number.isFinite(longitude)) {
        skipped.push({ row: i + 1, name: name || null, reason: 'Missing name or invalid latitude/longitude' });
        continue;
      }
      try {
        await client.query(
          `INSERT INTO site_locations (company_id, project, name, latitude, longitude, radius_m)
           VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (company_id, project, name) DO UPDATE
           SET latitude = $4, longitude = $5, radius_m = $6`,
          [req.user.company_id, project, name, latitude, longitude, radius_m]
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

  try {
    await pool.query(
      'UPDATE site_locations SET name = $1, latitude = $2, longitude = $3, radius_m = $4 WHERE id = $5 AND company_id = $6',
      [name, latitude, longitude, radius_m, req.params.id, req.user.company_id]
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
