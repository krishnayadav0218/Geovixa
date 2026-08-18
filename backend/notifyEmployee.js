const { pool } = require('./db');

/**
 * Central place to create an in-app notification (and, once a device push_token
 * exists for the employee, this is also where you'd call FCM's send API — kept
 * as a single hook so that wiring doesn't have to be duplicated per route).
 */
async function notifyEmployee(companyId, employeeId, category, title, body = '') {
  await pool.query(
    `INSERT INTO notifications (company_id, employee_id, category, title, body) VALUES ($1, $2, $3, $4, $5)`,
    [companyId, employeeId, category, title, body]
  );
  // TODO once Firebase Admin SDK credentials are configured: look up
  // employees.push_token for employeeId and send an FCM push here too, so the
  // native Android app's push notifications actually fire for this event.
}

module.exports = { notifyEmployee };
