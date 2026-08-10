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
      `INSERT INTO audit_log (actor_username, actor_role, action, target_type, target_id, target_label, details)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        (req.user && req.user.username) || 'unknown',
        (req.user && req.user.role) || 'unknown',
        action,
        targetType || null,
        targetId ? String(targetId) : null,
        targetLabel || null,
        details ? (typeof details === 'string' ? details : JSON.stringify(details)) : null,
      ]
    );
  } catch (err) {
    console.warn('audit_log write failed (action still succeeded):', err.message);
  }
}

module.exports = { logAction };
