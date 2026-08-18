const express = require('express');
const router = express.Router();
const { execFile } = require('child_process');
const path = require('path');
const { pool } = require('../db');
const { verifyAdminOrManager } = require('../middleware');
const { effectiveProjects } = require('../projectScope');

const SCRIPT_PATH = path.join(__dirname, '..', 'ml', 'predict_shortage.py');

function runPythonForecast(payload, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const child = execFile('python3', [SCRIPT_PATH], { timeout: timeoutMs, maxBuffer: 5 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) { console.warn('Predictive ML unavailable, falling back to JS calc:', stderr.trim() || err.message); return resolve(null); }
      try {
        const parsed = JSON.parse(stdout);
        if (parsed.error) { console.warn('Predictive ML error, falling back:', parsed.error); return resolve(null); }
        resolve(parsed.forecasts);
      } catch (e) { resolve(null); }
    });
    child.stdin.write(JSON.stringify(payload));
    child.stdin.end();
  });
}

// Same historical-shortfall-rate logic as the Python script's fallback path, in plain JS —
// used when Python/scikit-learn isn't available so this feature never hard-depends on it.
function jsForecast(sites) {
  return sites.map(s => {
    if (!s.required_manpower || s.required_manpower <= 0) {
      return { project: s.project, shortage_probability: null, confidence: 'n/a', basis: 'No required-manpower target set for this site.' };
    }
    const sameDay = s.history.filter(h => h.day_of_week === s.tomorrow_day_of_week);
    const pool_ = sameDay.length >= 4 ? sameDay : s.history;
    if (!pool_.length) {
      return { project: s.project, shortage_probability: null, confidence: 'none', basis: 'No attendance history yet for this site.' };
    }
    const shortfalls = pool_.map(h => (h.present < s.required_manpower ? 1 : 0));
    const rate = Math.round((shortfalls.reduce((a, b) => a + b, 0) / shortfalls.length) * 100) / 100;
    return {
      project: s.project, shortage_probability: rate,
      confidence: sameDay.length >= 8 ? 'high' : sameDay.length >= 4 ? 'medium' : 'low',
      basis: sameDay.length >= 4
        ? `Based on ${sameDay.length} previous occurrences of this same weekday.`
        : `Based on ${pool_.length} day(s) of overall history (not enough same-weekday data yet).`,
    };
  });
}

// GET /api/predictive/forecast — tomorrow's shortage-probability forecast per site, using up
// to the last 12 weeks of same-weekday attendance history.
router.get('/forecast', verifyAdminOrManager, async (req, res) => {
  const companyId = req.user.company_id;
  const scopeProjects = await effectiveProjects(req, pool);

  let siteQuery = 'SELECT name, required_manpower FROM projects WHERE company_id = $1 AND required_manpower > 0';
  const siteParams = [companyId];
  if (scopeProjects && scopeProjects.length) { siteParams.push(scopeProjects); siteQuery += ` AND name = ANY($${siteParams.length}::text[])`; }
  const sites = (await pool.query(siteQuery, siteParams)).rows;
  if (!sites.length) return res.json({ forecasts: [] });

  const siteNames = sites.map(s => s.name);
  const since = new Date(Date.now() - 84 * 86400000).toISOString().slice(0, 10); // 12 weeks back

  // Present count per site per day, for the last 12 weeks.
  const presentRows = (await pool.query(
    `SELECT e.project, a.attendance_date, COUNT(DISTINCT a.employee_id)::int AS present
     FROM attendance a JOIN employees e ON e.employee_id = a.employee_id AND e.company_id = a.company_id
     WHERE a.company_id = $1 AND a.status = 'on_duty' AND a.attendance_date >= $2 AND e.project = ANY($3::text[])
     GROUP BY e.project, a.attendance_date ORDER BY a.attendance_date ASC`,
    [companyId, since, siteNames]
  )).rows;

  const tomorrow = new Date(Date.now() + 86400000);
  // JS getDay(): 0=Sunday..6=Saturday. Convert to Python's weekday(): 0=Monday..6=Sunday.
  const tomorrowDow = (tomorrow.getDay() + 6) % 7;

  const bySite = new Map();
  sites.forEach(s => bySite.set(s.name, { project: s.name, required_manpower: Number(s.required_manpower), tomorrow_day_of_week: tomorrowDow, history: [] }));
  presentRows.forEach(r => {
    const entry = bySite.get(r.project);
    if (!entry) return;
    const d = new Date(r.attendance_date);
    const dow = (d.getDay() + 6) % 7;
    entry.history.push({ date: r.attendance_date, day_of_week: dow, present: r.present });
  });

  const payload = { sites: Array.from(bySite.values()) };
  let forecasts = await runPythonForecast(payload);
  let method = 'ml';
  if (!forecasts) { forecasts = jsForecast(payload.sites); method = 'heuristic'; }

  forecasts.sort((a, b) => (b.shortage_probability || 0) - (a.shortage_probability || 0));
  res.json({ forecast_for_date: tomorrow.toISOString().slice(0, 10), method, forecasts });
});

module.exports = router;
