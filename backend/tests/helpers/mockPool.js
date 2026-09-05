// Lightweight stand-in for `{ pool } = require('../db')` used by every route file.
// Real tests against a live Postgres instance are out of scope here (no DB available
// in CI) — instead this matches each query by a substring/regex of its SQL text and
// returns canned rows, which is enough to exercise the actual route logic (validation,
// geofence math, status transitions, auth checks) end-to-end via supertest.
//
// Usage in a test file:
//   const { makeMockPool } = require('./helpers/mockPool');
//   const pool = makeMockPool([
//     [/FROM employees WHERE employee_id/i, () => ({ rows: [{ ...emp }] })],
//     [/INSERT INTO attendance/i, () => ({ rows: [], rowCount: 1 })],
//   ]);
//   jest.mock('../../db', () => ({ pool }));

function makeMockPool(routes) {
  const calls = [];
  const query = jest.fn(async (sql, params) => {
    calls.push({ sql, params });
    for (const [pattern, handler] of routes) {
      const matches = pattern instanceof RegExp ? pattern.test(sql) : sql.includes(pattern);
      if (matches) {
        const result = typeof handler === 'function' ? handler(params, sql) : handler;
        return { rows: [], rowCount: 0, ...result };
      }
    }
    throw new Error(`[mockPool] No route matched for query: ${sql}`);
  });
  return { query, calls };
}

module.exports = { makeMockPool };
