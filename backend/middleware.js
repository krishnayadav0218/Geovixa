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
// Krystal role gets the same (manager-level: view + download only) access as Manager.
const verifyAdminOrManager = verifyRole(['admin', 'manager', 'krystal']);
const verifyEmployee = verifyRole(['employee']);

module.exports = { verifyRole, optionalAuth, verifyAdmin, verifyAdminOrManager, verifyEmployee };
