const jwt = require('jsonwebtoken');

// Generic role-checking middleware factory.
// Usage: verifyRole(['admin']), verifyRole(['admin','manager']), verifyRole(['employee'])
function verifyRole(allowedRoles) {
  return function (req, res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ error: 'No token provided' });

    try {
      const token = authHeader.split(' ')[1];
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      if (!allowedRoles.includes(decoded.role)) {
        return res.status(403).json({ error: 'You do not have permission to access this' });
      }
      req.user = decoded; // { id/employee_id, username/name, role }
      next();
    } catch (err) {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }
  };
}

// Optional auth: attaches req.user if a valid token is present, but never blocks the request.
// Used on the punch endpoint so the Android app (no login) and the new web app (employee login) both work.
function optionalAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader) return next();
  try {
    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;
  } catch (err) {
    // ignore invalid token here, punch route will fall back to body employee_id
  }
  next();
}

const verifyAdmin = verifyRole(['admin']);
// Coordinator role gets the same (manager-level: view + download only) access as Manager.
const verifyAdminOrManager = verifyRole(['admin', 'manager', 'coordinator']);
// report_viewer = the admin-defined custom roles (Area Officer, Supervisor, etc.) — Reports
// ONLY, never Employees/Attendance/Managers/Settings, which is why this is a separate,
// narrower middleware used only by routes/export.js instead of being folded into
// verifyAdminOrManager above.
const verifyReports = verifyRole(['admin', 'manager', 'coordinator', 'report_viewer']);
const verifyEmployee = verifyRole(['employee']);
// client = a read-only Client Portal account (external, scoped to specific sites via
// client_sites — see routes/clientAccounts.js / routes/clientPortal.js). Never has any
// HR/attendance-edit/payroll access — strictly GET endpoints in routes/clientPortal.js.
const verifyClient = verifyRole(['client']);
// super_admin = the PLATFORM OWNER's account (you, the person selling this app to multiple
// companies) — company_id IS NULL, used only by routes/companies.js to create/manage
// companies. It never has access to any single company's employees/attendance/reports.
const verifySuperAdmin = verifyRole(['super_admin']);

module.exports = {
  verifyRole, optionalAuth, verifyAdmin, verifyAdminOrManager, verifyReports, verifyEmployee,
  verifySuperAdmin, verifyClient,
};
