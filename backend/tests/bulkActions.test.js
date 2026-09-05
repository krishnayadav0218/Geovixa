const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const { makeMockPool } = require('./helpers/mockPool');

const ADMIN = { id: 1, username: 'admin', role: 'admin', company_id: 1, employee_id: null };
function token() { return jwt.sign(ADMIN, process.env.JWT_SECRET, { expiresIn: '1h' }); }

function mountApp(routePath, routerPath, pool) {
  jest.resetModules();
  jest.doMock('../db', () => ({ pool }));
  const router = require(routerPath);
  const app = express();
  app.use(express.json());
  app.use(routePath, router);
  return app;
}

describe('Bulk actions', () => {
  test('regularization bulk-approve requires ids', async () => {
    const pool = makeMockPool([]);
    const app = mountApp('/api/regularization', '../routes/regularization', pool);

    const res = await request(app)
      .put('/api/regularization/bulk-approve')
      .set('Authorization', `Bearer ${token()}`)
      .send({});

    expect(res.status).toBe(400);
  });

  test('regularization bulk-approve approves each pending request via the same review() path', async () => {
    const pending = { id: 1, status: 'pending', employee_id: 'EMP001', company_id: 1, attendance_date: '2026-09-01', requested_status: 'on_duty', requested_time: null };
    const pool = makeMockPool([
      [/FROM regularization_requests WHERE id = \$1/i, () => ({ rows: [pending] })],
      [/UPDATE regularization_requests SET status/i, () => ({ rows: [], rowCount: 1 })],
      [/INSERT INTO attendance/i, () => ({ rows: [] })],
      [/INSERT INTO notifications/i, () => ({ rows: [] })],
    ]);
    const app = mountApp('/api/regularization', '../routes/regularization', pool);

    const res = await request(app)
      .put('/api/regularization/bulk-approve')
      .set('Authorization', `Bearer ${token()}`)
      .send({ ids: [1, 2] });

    expect(res.status).toBe(200);
    expect(res.body.approved).toBe(2);
  });

  test('incidents bulk-review updates all matching ids in one query', async () => {
    const pool = makeMockPool([
      [/UPDATE incident_reports SET status/i, () => ({ rowCount: 3 })],
    ]);
    const app = mountApp('/api/incidents', '../routes/incidents', pool);

    const res = await request(app)
      .put('/api/incidents/bulk-review')
      .set('Authorization', `Bearer ${token()}`)
      .send({ ids: [1, 2, 3], status: 'resolved' });

    expect(res.status).toBe(200);
    expect(res.body.updated).toBe(3);
  });

  test('referrals bulk-update is matched before the /:id route (no route-order collision)', async () => {
    const pool = makeMockPool([
      [/UPDATE employee_referrals SET status/i, () => ({ rowCount: 2 })],
    ]);
    const app = mountApp('/api/referrals', '../routes/referrals', pool);

    const res = await request(app)
      .put('/api/referrals/bulk-update')
      .set('Authorization', `Bearer ${token()}`)
      .send({ ids: [5, 6], status: 'hired' });

    expect(res.status).toBe(200);
    expect(res.body.updated).toBe(2);
  });

  test('referrals bulk-update rejects a missing/invalid status', async () => {
    const pool = makeMockPool([]);
    const app = mountApp('/api/referrals', '../routes/referrals', pool);

    const res = await request(app)
      .put('/api/referrals/bulk-update')
      .set('Authorization', `Bearer ${token()}`)
      .send({ ids: [5, 6], status: 'not-a-real-status' });

    expect(res.status).toBe(400);
  });
});
