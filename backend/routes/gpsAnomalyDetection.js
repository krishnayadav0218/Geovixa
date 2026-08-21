const { pool } = require('./db');

// Anything faster than this between two consecutive GPS points is not real movement —
// a person can't legitimately cover that distance in that time (fastest commercial
// flights cruise around 900 km/h; this threshold sits well below even that, catching
// GPS-spoofing apps that "teleport" a location instantly).
const IMPOSSIBLE_SPEED_KMH = 200;

function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Compares a new GPS point against the employee's last known live position. Returns
 * { anomalous: boolean, speedKmh, distanceKm } — never throws, so a check failure never
 * blocks the caller's actual punch/ping logic.
 *
 * Call this BEFORE writing the new live_latitude/live_longitude, while the "last known"
 * values are still the previous point.
 */
async function checkImpossibleTravel(employeeId, companyId, newLat, newLng, atTime = new Date()) {
  try {
    const { rows } = await pool.query(
      'SELECT live_latitude, live_longitude, live_last_ping_at FROM employees WHERE employee_id = $1 AND company_id = $2',
      [employeeId, companyId]
    );
    const prev = rows[0];
    if (!prev || prev.live_latitude == null || prev.live_longitude == null || !prev.live_last_ping_at) {
      return { anomalous: false }; // no prior point to compare against — nothing to flag
    }

    const elapsedHours = (atTime.getTime() - new Date(prev.live_last_ping_at).getTime()) / 3600000;
    if (elapsedHours <= 0) return { anomalous: false }; // clock skew / duplicate ping — ignore rather than false-flag

    const distanceKm = haversineKm(Number(prev.live_latitude), Number(prev.live_longitude), newLat, newLng);
    const speedKmh = distanceKm / elapsedHours;

    if (speedKmh > IMPOSSIBLE_SPEED_KMH) {
      await pool.query(
        `INSERT INTO gps_anomaly_flags (company_id, employee_id, speed_kmh, distance_km, elapsed_minutes, from_latitude, from_longitude, to_latitude, to_longitude)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [companyId, employeeId, speedKmh, distanceKm, elapsedHours * 60,
          prev.live_latitude, prev.live_longitude, newLat, newLng]
      );
      return { anomalous: true, speedKmh, distanceKm };
    }
    return { anomalous: false, speedKmh, distanceKm };
  } catch (err) {
    console.error('[gpsAnomalyDetection] check failed (non-fatal):', err.message);
    return { anomalous: false };
  }
}

module.exports = { checkImpossibleTravel, IMPOSSIBLE_SPEED_KMH, haversineKm };
