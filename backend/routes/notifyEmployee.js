const { pool } = require('./db');
const { sendPush } = require('./pushNotifications');

/**
 * Central place to create an in-app notification AND send a real push to the
 * employee's device (if they have one registered and Firebase is configured).
 * Previously this only wrote the in-app row — no push was ever actually sent.
 */
async function notifyEmployee(companyId, employeeId, category, title, body = '') {
  await pool.query(
    `INSERT INTO notifications (company_id, employee_id, category, title, body) VALUES ($1, $2, $3, $4, $5)`,
    [companyId, employeeId, category, title, body]
  );

  const { rows } = await pool.query(
    'SELECT push_token FROM employees WHERE employee_id = $1 AND company_id = $2',
    [employeeId, companyId]
  );
  if (rows[0]?.push_token) {
    await sendPush(rows[0].push_token, title, body, { category });
  }
}

module.exports = { notifyEmployee };
