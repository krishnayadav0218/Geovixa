const { pool } = require('./db');
const { notifyEmployee } = require('./notifyEmployee');

// How far ahead of the scheduled shift_start_time to send the reminder.
const REMINDER_LEAD_MINUTES = 30;

/**
 * Runs every few minutes, looks at today's shift_roster rows that have a
 * shift_start_time set, and sends a one-time reminder push/notification roughly
 * REMINDER_LEAD_MINUTES before that time. `reminder_sent` prevents duplicates.
 */
async function sendDueShiftReminders() {
  const now = new Date();
  const todayStr = now.toISOString().slice(0, 10);

  const { rows } = await pool.query(
    `SELECT id, company_id, employee_id, project, shift_start_time
     FROM shift_roster
     WHERE roster_date = $1 AND reminder_sent = FALSE AND shift_start_time IS NOT NULL
       AND status = 'scheduled'`,
    [todayStr]
  );

  let sent = 0;
  for (const row of rows) {
    // shift_start_time is stored as "HH:MM" text against today's date.
    const [h, m] = (row.shift_start_time || '').split(':').map(Number);
    if (Number.isNaN(h) || Number.isNaN(m)) continue;

    const shiftStart = new Date(now);
    shiftStart.setHours(h, m, 0, 0);
    const minutesUntilShift = (shiftStart.getTime() - now.getTime()) / 60000;

    // Fire once the shift is within the lead window (and not already past) —
    // a sweep every few minutes means this could catch it a little early/late,
    // which is fine for a reminder (not a precise alarm).
    if (minutesUntilShift <= REMINDER_LEAD_MINUTES && minutesUntilShift > -5) {
      await notifyEmployee(
        row.company_id, row.employee_id, 'shift_reminder',
        'Upcoming shift reminder',
        `Your shift${row.project ? ` at ${row.project}` : ''} starts at ${row.shift_start_time} — don't forget to punch in.`
      );
      await pool.query('UPDATE shift_roster SET reminder_sent = TRUE WHERE id = $1', [row.id]);
      sent++;
    }
  }
  return sent;
}

function startShiftReminderLoop(intervalMs = 5 * 60 * 1000) {
  setInterval(async () => {
    try {
      const count = await sendDueShiftReminders();
      if (count > 0) console.log(`⏰ Shift reminders: ${count} employee(s) notified`);
    } catch (err) {
      console.warn('Shift reminder sweep failed (non-fatal):', err.message);
    }
  }, intervalMs);
}

module.exports = { sendDueShiftReminders, startShiftReminderLoop };
