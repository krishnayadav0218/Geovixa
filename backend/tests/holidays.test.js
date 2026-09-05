const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const { makeMockPool } = require('./helpers/mockPool');

const ADMIN = { id: 1, username: 'admin', role: 'admin', company_id: 1 };
const EMPLOYEE = { id: 2, employee_id: 'EMP001', role: 'employee', company_id: 1 };
function token(payload) { return jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: '1h' }); }

function buildApp(pool) {
  jest.resetModules();
  jest.doMock('../db', () => ({ pool }));
  const holidayRoutes = require('../routes/holidays');
  const app = express();
  app.use(express.json());
  app.use('/api/holidays', holidayRoutes);
  return app;
}

describe('Holiday calendar', () => {
  test('any logged-in role can list holidays for a year', async () => {
    const pool = makeMockPool([
      [/FROM company_holidays\s+WHERE company_id = \$1 AND EXTRACT\(YEAR/i, () => ({ rows: [
        { id: 1, holiday_date: '2026-01-26', name: 'Republic Day' },
        { id: 2, holiday_date: '2026-08-15', name: 'Independence Day' },
      ] })],
    ]);
    const app = buildApp(pool);

    const res = await request(app)
      .get('/api/holidays?year=2026')
      .set('Authorization', `Bearer ${token(EMPLOYEE)}`);

    expect(res.status).toBe(200);
    expect(res.body.year).toBe(2026);
    expect(res.body.holidays).toHaveLength(2);
  });

  test('defaults to the current year when none is given', async () => {
    let capturedParams;
    const pool = makeMockPool([
      [/FROM company_holidays/i, (params) => { capturedParams = params; return { rows: [] }; }],
    ]);
    const app = buildApp(pool);

    await request(app).get('/api/holidays').set('Authorization', `Bearer ${token(EMPLOYEE)}`);

    expect(capturedParams[1]).toBe(new Date().getFullYear());
  });

  test('listing without a token is rejected', async () => {
    const app = buildApp(makeMockPool([]));
    const res = await request(app).get('/api/holidays?year=2026');
    expect(res.status).toBe(401);
  });

  test('admin can add a holiday', async () => {
    const pool = makeMockPool([
      [/INSERT INTO company_holidays/i, () => ({ rows: [{ id: 5 }] })],
    ]);
    const app = buildApp(pool);

    const res = await request(app)
      .post('/api/holidays')
      .set('Authorization', `Bearer ${token(ADMIN)}`)
      .send({ holiday_date: '2026-10-02', name: 'Gandhi Jayanti' });

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(5);
  });

  test('adding a holiday requires both date and name', async () => {
    const app = buildApp(makeMockPool([]));

    const res = await request(app)
      .post('/api/holidays')
      .set('Authorization', `Bearer ${token(ADMIN)}`)
      .send({ holiday_date: '2026-10-02' });

    expect(res.status).toBe(400);
  });

  test('a non-admin (e.g. employee) cannot add a holiday', async () => {
    const app = buildApp(makeMockPool([]));

    const res = await request(app)
      .post('/api/holidays')
      .set('Authorization', `Bearer ${token(EMPLOYEE)}`)
      .send({ holiday_date: '2026-10-02', name: 'Gandhi Jayanti' });

    expect(res.status).toBe(403);
  });

  test('admin can delete a holiday', async () => {
    const pool = makeMockPool([
      [/DELETE FROM company_holidays/i, () => ({ rowCount: 1 })],
    ]);
    const app = buildApp(pool);

    const res = await request(app)
      .delete('/api/holidays/5')
      .set('Authorization', `Bearer ${token(ADMIN)}`);

    expect(res.status).toBe(200);
  });

  test('deleting a non-existent holiday returns 404', async () => {
    const pool = makeMockPool([
      [/DELETE FROM company_holidays/i, () => ({ rowCount: 0 })],
    ]);
    const app = buildApp(pool);

    const res = await request(app)
      .delete('/api/holidays/999')
      .set('Authorization', `Bearer ${token(ADMIN)}`);

    expect(res.status).toBe(404);
  });
});
