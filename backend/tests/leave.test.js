const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const { makeMockPool } = require('./helpers/mockPool');

const ADMIN_TOKEN_PAYLOAD = { id: 1, username: 'admin', role: 'admin', company_id: 1, project: null };

const PENDING_REQUEST = {
  id: 55, employee_id: 'EMP001', company_id: 1, project: 'MCGM HK',
  from_date: '2026-09-10', to_date: '2026-09-12', status: 'pending',
};

function token(payload = ADMIN_TOKEN_PAYLOAD) {
  return jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: '1h' });
}

function buildApp(pool) {
  jest.resetModules();
  jest.doMock('../db', () => ({ pool }));
  jest.doMock('../mailer', () => ({ sendRequestStatusEmail: jest.fn() }));
  const leaveRoutes = require('../routes/leave');
  const app = express();
  app.use(express.json());
  app.use('/api/leave', leaveRoutes);
  return app;
}

function buildPool({ request: leaveRequest = PENDING_REQUEST } = {}) {
  const updates = [];
  const pool = makeMockPool([
    [/FROM leave_requests WHERE id = \$1 AND company_id = \$2/i, () => ({ rows: leaveRequest ? [leaveRequest] : [] })],
    [/UPDATE leave_requests SET status/i, (params) => { updates.push(params); return { rows: [], rowCount: 1 }; }],
    [/INSERT INTO notifications/i, () => ({ rows: [] })],
    [/SELECT name, email FROM employees/i, () => ({ rows: [{ name: 'Test Employee', email: null }] })],
  ]);
  pool.updates = updates;
  return pool;
}

describe('Leave approval flow', () => {
  test('admin can approve a pending leave request', async () => {
    const pool = buildPool();
    const app = buildApp(pool);

    const res = await request(app)
      .put('/api/leave/requests/55/approve')
      .set('Authorization', `Bearer ${token()}`)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.message).toMatch(/approved/i);
    expect(pool.updates[0][0]).toBe('approved');
  });

  test('admin can reject a pending leave request', async () => {
    const pool = buildPool();
    const app = buildApp(pool);

    const res = await request(app)
      .put('/api/leave/requests/55/reject')
      .set('Authorization', `Bearer ${token()}`)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.message).toMatch(/rejected/i);
    expect(pool.updates[0][0]).toBe('rejected');
  });

  test('returns 404 when the leave request does not exist (or belongs to another company)', async () => {
    const pool = buildPool({ request: null });
    const app = buildApp(pool);

    const res = await request(app)
      .put('/api/leave/requests/999/approve')
      .set('Authorization', `Bearer ${token()}`)
      .send({});

    expect(res.status).toBe(404);
  });

  test('rejects the request with no auth token at all', async () => {
    const pool = buildPool();
    const app = buildApp(pool);

    const res = await request(app).put('/api/leave/requests/55/approve').send({});

    expect(res.status).toBe(401);
  });

  test('an employee-role token cannot approve leave (admin/manager/coordinator only)', async () => {
    const pool = buildPool();
    const app = buildApp(pool);

    const res = await request(app)
      .put('/api/leave/requests/55/approve')
      .set('Authorization', `Bearer ${token({ role: 'employee', employee_id: 'EMP001', company_id: 1 })}`)
      .send({});

    expect(res.status).toBe(403);
  });
});
