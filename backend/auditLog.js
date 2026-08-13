const { pool } = require('./db');

// Records one row in audit_log — every sensitive platform-owner (super_admin) action gets
// logged here: creating/editing/deleting a company, changing its settings/logo/plan,
// resetting a company Admin's password, and impersonating a company's Admin. Read-only
// history; nothing in the app ever deletes these rows.
//
// Deliberately fire-and-forget: a logging failure should never break the actual action it's
// recording, so this swallows its own errors (just prints a console warning) rather than
// letting a broken audit_log table (e.g. mid-migration) take down company management.
async function logAction(req, action, { targetType, targetId, targetLabel, details } = {}) {
  try {
    await pool.query(
      `INSERT INTO audit_log (actor_username, actor_role, action, target_type, target_id, target_label, details, company_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        (req.user && req.user.username) || 'unknown',
        (req.user && req.user.role) || 'unknown',
        action,
        targetType || null,
        targetId ? String(targetId) : null,
        targetLabel || null,
        details ? (typeof details === 'string' ? details : JSON.stringify(details)) : null,
        (req.user && req.user.company_id) || null,
      ]
    );
  } catch (err) {
    console.warn('audit_log write failed (action still succeeded):', err.message);
  }
}

// Records one login attempt (success or failure) for the Audit & Security module. Called
// directly from routes/auth.js — separate from logAction since a login attempt doesn't have
// a req.user yet (that's the whole point of logging it).
async function logLoginAttempt(req, { companyId, username, role, success, reason }) {
  try {
    await pool.query(
      `INSERT INTO login_history (company_id, username, role, success, reason, ip_address, user_agent)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        companyId || null,
        username || null,
        role || null,
        !!success,
        reason || null,
        req.ip || (req.headers && req.headers['x-forwarded-for']) || null,
        (req.headers && req.headers['user-agent']) || null,
      ]
    );
  } catch (err) {
    console.warn('login_history write failed (login still processed):', err.message);
  }
}

module.exports = { logAction, logLoginAttempt };
