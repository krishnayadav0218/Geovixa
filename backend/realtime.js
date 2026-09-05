const jwt = require('jsonwebtoken');

let io = null;

// Attaches Socket.io to the same HTTP server Express is already using (see server.js) —
// no separate port, so it works behind Render's single-port free-tier setup unchanged.
//
// Every connection must present the same JWT the REST API already issues (Admin/Manager/
// Coordinator login) via the client's `auth: { token }` handshake option — verified here with
// the same JWT_SECRET as every other route, so a socket can only ever join its OWN company's
// room. This mirrors the company_id scoping already enforced on every REST endpoint; without
// it, any browser tab could otherwise ask to join an arbitrary company's room and see another
// tenant's live SOS alerts / employee locations.
function init(server) {
  const { Server } = require('socket.io');
  io = new Server(server, {
    cors: { origin: '*' }, // same reasoning as app.use(cors()) in server.js — Bearer-token API, no cookies
  });

  io.use((socket, next) => {
    try {
      const token = socket.handshake.auth && socket.handshake.auth.token;
      if (!token) return next(new Error('No token provided'));
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      if (!['admin', 'manager', 'coordinator'].includes(decoded.role)) {
        return next(new Error('Not authorized for real-time updates'));
      }
      socket.geovixaUser = decoded;
      next();
    } catch (err) {
      next(new Error('Invalid or expired token'));
    }
  });

  io.on('connection', (socket) => {
    socket.join(`company:${socket.geovixaUser.company_id}`);
  });

  return io;
}

// Fire-and-forget: if Socket.io hasn't been initialized (e.g. a unit test importing a route
// module directly) or companyId is missing, this is a silent no-op — real-time push is a
// progressive enhancement, the 15-90s polling fallbacks already in app.js still work either way.
function emitToCompany(companyId, event, payload) {
  if (!io || !companyId) return;
  io.to(`company:${companyId}`).emit(event, payload);
}

module.exports = { init, emitToCompany };
