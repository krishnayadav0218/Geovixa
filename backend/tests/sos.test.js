const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const { makeMockPool } = require('./helpers/mockPool');

const EMPLOYEE = { id: 1, employee_id: 'EMP001', role: 'employee', company_id: 1 };
const ADMIN = { id: 2, username: 'admin', role: 'admin', company_id: 1 };
function token(payload) { return jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: '1h' }); }

function buildApp(pool) {
  jest.resetModules();
  jest.doMock('../db', () => ({ pool }));
  jest.doMock('../realtime', () => ({ emitToCompany: jest.fn() })); // real-time push isn't under test here
  const sosRoutes = require('../routes/sos');
  const app = express();
  app.use(express.json());
  app.use('/api/sos', sosRoutes);
  return app;
}

// `settings: {}` -> mergeSettings() defaults every feature/permission to enabled, matching
// how a brand-new company with no customization behaves in production.
function buildPool({ companySettings = {}, employeeProject = 'MCGM HK', alertRow = { id: 9 } } = {}) {
  return makeMockPool([
    [/SELECT settings FROM companies WHERE id = \$1/i, () => ({ rows: [{ settings: companySettings }] })],
    [/SELECT project FROM employees WHERE employee_id = \$1 AND company_id = \$2/i, () => ({ rows: [{ project: employeeProject }] })],
    [/INSERT INTO sos_alerts/i, () => ({ rows: [alertRow] })],
    [/INSERT INTO audit_log/i, () => ({ rows: [] })],
    [/FROM sos_alerts s LEFT JOIN employees/i, () => ({ rows: [
      { id: 9, status: 'open', employee_id: 'EMP001', type: 'medical', created_at: new Date().toISOString() },
    ] })],
    [/UPDATE sos_alerts SET status = 'acknowledged'/i, (params) => ({ rows: [{ id: Number(params[1]) }] })],
    [/UPDATE sos_alerts SET status = 'resolved'/i, (params) => ({ rows: [{ id: Number(params[1]) }] })],
  ]);
}

describe('SOS alerts', () => {
  test('employee can raise an SOS alert', async () => {
    const app = buildApp(buildPool());

    const res = await request(app)
      .post('/api/sos')
      .set('Authorization', `Bearer ${token(EMPLOYEE)}`)
      .send({ type: 'medical', latitude: 19.07, longitude: 72.87 });

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(9);
  });

  test('unknown SOS type is coerced to "other" rather than rejected — a jammed dropdown should never block a real emergency', async () => {
    const app = buildApp(buildPool());

    const res = await request(app)
      .post('/api/sos')
      .set('Authorization', `Bearer ${token(EMPLOYEE)}`)
      .send({ type: 'not-a-real-type' });

    expect(res.status).toBe(200);
  });

  test('SOS is blocked when the company has the feature turned off', async () => {
    const app = buildApp(buildPool({ companySettings: { features: { sos: false } } }));

    const res = await request(app)
      .post('/api/sos')
      .set('Authorization', `Bearer ${token(EMPLOYEE)}`)
      .send({ type: 'fire' });

    expect(res.status).toBe(403);
  });

  test('admin sees the live SOS feed with an open-count summary', async () => {
    const app = buildApp(buildPool());

    const res = await request(app)
      .get('/api/sos')
      .set('Authorization', `Bearer ${token(ADMIN)}`);

    expect(res.status).toBe(200);
    expect(res.body.openCount).toBe(1);
    expect(res.body.alerts).toHaveLength(1);
  });

  test('admin without SOS role-permission is blocked from the feed', async () => {
    const app = buildApp(buildPool({ companySettings: { role_permissions: { admin: { sos: false } } } }));

    const res = await request(app)
      .get('/api/sos')
      .set('Authorization', `Bearer ${token(ADMIN)}`);

    expect(res.status).toBe(403);
  });

  test('admin can acknowledge an open alert', async () => {
    const app = buildApp(buildPool());

    const res = await request(app)
      .put('/api/sos/9/acknowledge')
      .set('Authorization', `Bearer ${token(ADMIN)}`)
      .send({});

    expect(res.status).toBe(200);
  });

  test('acknowledging an already-acknowledged/non-open alert returns 400', async () => {
    const pool = makeMockPool([
      [/UPDATE sos_alerts SET status = 'acknowledged'/i, () => ({ rows: [] })],
    ]);
    const app = buildApp(pool);

    const res = await request(app)
      .put('/api/sos/9/acknowledge')
      .set('Authorization', `Bearer ${token(ADMIN)}`)
      .send({});

    expect(res.status).toBe(400);
  });

  test('admin can resolve an alert with a resolution note', async () => {
    const app = buildApp(buildPool());

    const res = await request(app)
      .put('/api/sos/9/resolve')
      .set('Authorization', `Bearer ${token(ADMIN)}`)
      .send({ resolution_note: 'False alarm, employee confirmed safe by phone.' });

    expect(res.status).toBe(200);
  });

  test('an employee (not admin/manager/coordinator) cannot acknowledge alerts', async () => {
    const app = buildApp(buildPool());

    const res = await request(app)
      .put('/api/sos/9/acknowledge')
      .set('Authorization', `Bearer ${token(EMPLOYEE)}`)
      .send({});

    expect(res.status).toBe(403);
  });
});
