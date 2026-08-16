const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { verifyAdminOrManager } = require('../middleware');
const { effectiveProjects } = require('../projectScope');

// A facility-operations Q&A assistant. This is intent-matching against known question
// patterns + querying the DB for the real answer — NOT a general-purpose LLM (there's no
// language model embedded in this app). It reliably answers the specific kinds of questions
// an ops manager actually asks ("how many absent today", "which sites are critical",
// "how many open SOS alerts") by recognizing keywords and running the matching query, the
// same way the original brief's example exchanges work. Ambiguous or out-of-scope questions
// get a clear "I can help with X, Y, Z" fallback rather than a wrong guess.
const today = () => new Date().toISOString().slice(0, 10);

async function answerAbsentToday(companyId, scopeProjects) {
  let empQuery = 'SELECT employee_id, project FROM employees WHERE company_id = $1 AND active = 1';
  const empParams = [companyId];
  if (scopeProjects && scopeProjects.length) { empParams.push(scopeProjects); empQuery += ` AND project = ANY($${empParams.length}::text[])`; }
  const employees = (await pool.query(empQuery, empParams)).rows;
  if (!employees.length) return 'There are no active employees to check.';

  const empIds = employees.map(e => e.employee_id);
  const presentRows = (await pool.query(
    `SELECT DISTINCT employee_id FROM attendance WHERE company_id = $1 AND attendance_date = $2 AND status = 'on_duty' AND employee_id = ANY($3::text[])`,
    [companyId, today(), empIds]
  )).rows;
  const presentSet = new Set(presentRows.map(r => r.employee_id));
  const absentCount = employees.length - presentSet.size;

  const siteCounts = new Map();
  employees.forEach(e => { if (!presentSet.has(e.employee_id)) siteCounts.set(e.project, (siteCounts.get(e.project) || 0) + 1); });
  const bySite = Array.from(siteCounts.entries()).sort((a, b) => b[1] - a[1]).slice(0, 5)
    .map(([site, c]) => `${site}: ${c}`).join(', ');

  return `${absentCount} employee(s) absent today out of ${employees.length} active.${bySite ? ` Top sites: ${bySite}.` : ''}`;
}

async function answerCriticalSites(companyId, scopeProjects) {
  let siteQuery = 'SELECT name, required_manpower FROM projects WHERE company_id = $1 AND required_manpower > 0';
  const siteParams = [companyId];
  if (scopeProjects && scopeProjects.length) { siteParams.push(scopeProjects); siteQuery += ` AND name = ANY($${siteParams.length}::text[])`; }
  const sites = (await pool.query(siteQuery, siteParams)).rows;
  if (!sites.length) return 'No sites have a required-manpower target set, so shortage can\'t be checked yet.';

  const siteNames = sites.map(s => s.name);
  const presentRows = (await pool.query(
    `SELECT e.project, COUNT(DISTINCT a.employee_id)::int AS present
     FROM attendance a JOIN employees e ON e.employee_id = a.employee_id AND e.company_id = a.company_id
     WHERE a.company_id = $1 AND a.attendance_date = $2 AND a.status = 'on_duty' AND e.project = ANY($3::text[])
     GROUP BY e.project`,
    [companyId, today(), siteNames]
  )).rows;
  const presentMap = new Map(presentRows.map(r => [r.project, r.present]));

  const critical = sites
    .map(s => ({ name: s.name, shortage: Math.max(0, Number(s.required_manpower) - (presentMap.get(s.name) || 0)) }))
    .filter(s => s.shortage > 0)
    .sort((a, b) => b.shortage - a.shortage);

  if (!critical.length) return 'No sites are currently short-staffed. Everything looks covered.';
  return `${critical.length} site(s) currently short-staffed: ` + critical.map(s => `${s.name} (short ${s.shortage})`).join(', ') + '.';
}

async function answerSosAlerts(companyId, scopeProjects) {
  const params = [companyId];
  let query = "SELECT type, project FROM sos_alerts WHERE company_id = $1 AND status = 'open'";
  if (scopeProjects && scopeProjects.length) { params.push(scopeProjects); query += ` AND project = ANY($${params.length}::text[])`; }
  const rows = (await pool.query(query, params)).rows;
  if (!rows.length) return 'No open SOS alerts right now.';
  const byType = new Map();
  rows.forEach(r => byType.set(r.type, (byType.get(r.type) || 0) + 1));
  return `${rows.length} open SOS alert(s): ` + Array.from(byType.entries()).map(([t, c]) => `${t} (${c})`).join(', ') + '. Check the SOS Alerts tab immediately.';
}

async function answerOvertime(companyId, scopeProjects) {
  const monthStart = new Date(); monthStart.setDate(1);
  const monthStartStr = monthStart.toISOString().slice(0, 10);
  const params = [companyId, monthStartStr];
  let query = "SELECT COALESCE(SUM(ot_hours),0) AS hrs, COALESCE(SUM(ot_amount),0) AS amt, COUNT(*)::int AS c FROM overtime_records WHERE company_id = $1 AND work_date >= $2";
  if (scopeProjects && scopeProjects.length) { params.push(scopeProjects); query += ` AND project = ANY($${params.length}::text[])`; }
  const { rows } = await pool.query(query, params);
  const r = rows[0];
  return `This month so far: ${Number(r.hrs).toFixed(1)} OT hours across ${r.c} record(s), totalling ₹${Math.round(r.amt).toLocaleString('en-IN')}.`;
}

async function answerRelieverStatus(companyId, scopeProjects) {
  const today_ = today();
  const params = [companyId, today_];
  let query = "SELECT status FROM reliever_assignments WHERE company_id = $1 AND duty_date = $2";
  if (scopeProjects && scopeProjects.length) { params.push(scopeProjects); query += ` AND project = ANY($${params.length}::text[])`; }
  const rows = (await pool.query(query, params)).rows;
  const onDuty = rows.filter(r => r.status === 'accepted').length;
  const pending = rows.filter(r => r.status === 'assigned').length;
  return `${onDuty} reliever(s) on duty today, ${pending} still awaiting accept/reject.`;
}

async function answerMaintenanceTickets(companyId, scopeProjects) {
  const params = [companyId];
  let query = "SELECT priority, status FROM maintenance_tickets WHERE company_id = $1 AND status NOT IN ('resolved','verified','closed')";
  if (scopeProjects && scopeProjects.length) { params.push(scopeProjects); query += ` AND project = ANY($${params.length}::text[])`; }
  const rows = (await pool.query(query, params)).rows;
  if (!rows.length) return 'No open maintenance tickets.';
  const critical = rows.filter(r => r.priority === 'critical' || r.priority === 'high').length;
  return `${rows.length} open maintenance ticket(s), ${critical} high/critical priority.`;
}

const INTENTS = [
  { keywords: ['absent', 'gair hazir', 'not present', 'kitne employee'], handler: answerAbsentToday },
  { keywords: ['critical', 'shortage', 'short staff', 'kami', 'kam employee'], handler: answerCriticalSites },
  { keywords: ['sos', 'emergency alert', 'panic'], handler: answerSosAlerts },
  { keywords: ['overtime', 'ot ', ' ot', 'ot hours', 'ot amount'], handler: answerOvertime },
  { keywords: ['reliever', 'releaver'], handler: answerRelieverStatus },
  { keywords: ['maintenance', 'ticket', 'complaint'], handler: answerMaintenanceTickets },
];

// POST /api/ai-assistant/query  body: { question }
router.post('/query', verifyAdminOrManager, async (req, res) => {
  const question = (req.body.question || '').toLowerCase().trim();
  if (!question) return res.status(400).json({ error: 'question is required' });

  const scopeProjects = await effectiveProjects(req, pool);
  const matched = INTENTS.find(intent => intent.keywords.some(k => question.includes(k)));

  if (!matched) {
    return res.json({
      answer: "I can help with: how many employees are absent today, which sites are critical/short-staffed, open SOS alerts, this month's overtime, reliever status, and open maintenance tickets. Try asking one of those.",
      matched: false,
    });
  }

  try {
    const answer = await matched.handler(req.user.company_id, scopeProjects);
    res.json({ answer, matched: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
