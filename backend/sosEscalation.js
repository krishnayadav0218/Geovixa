const { pool } = require('./db');
const { logAction } = require('./auditLog');

// If nobody acknowledges an SOS within this window, it's flagged as escalated. Previously
// an unacknowledged SOS just sat in the same "open" list forever with no distinction from
// one raised 10 seconds ago — an admin scrolling past it had no way to tell it was
// overdue without checking the timestamp on every single row themselves.
const ESCALATION_MINUTES = 5;

async function escalateStaleAlerts() {
  const { rows } = await pool.query(
    `UPDATE sos_alerts
     SET escalated = TRUE, escalated_at = NOW()
     WHERE status = 'open' AND escalated = FALSE AND created_at < NOW() - INTERVAL '${ESCALATION_MINUTES} minutes'
     RETURNING id, company_id, employee_id, type`
  );
  for (const alert of rows) {
    console.warn(`🚨 SOS #${alert.id} (${alert.employee_id}, ${alert.type}) escalated — unacknowledged for ${ESCALATION_MINUTES}+ minutes`);
    await logAction(
      { user: { company_id: alert.company_id, username: 'system', role: 'system' } },
      'sos_escalated',
      { targetType: 'sos_alert', targetId: alert.id, targetLabel: `${alert.employee_id} — ${alert.type} (unacknowledged ${ESCALATION_MINUTES}+ min)` }
    );
  }
  return rows.length;
}

function startSosEscalationLoop(intervalMs = 60 * 1000) {
  setInterval(async () => {
    try {
      const count = await escalateStaleAlerts();
      if (count > 0) console.log(`🚨 SOS escalation sweep: ${count} alert(s) newly flagged as overdue`);
    } catch (err) {
      console.warn('SOS escalation sweep failed (non-fatal):', err.message);
    }
  }, intervalMs);
}

module.exports = { escalateStaleAlerts, startSosEscalationLoop, ESCALATION_MINUTES };
