const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const { makeMockPool } = require('./helpers/mockPool');

const ADMIN = { id: 1, username: 'admin', role: 'admin', company_id: 1, employee_id: null };
function token() { return jwt.sign(ADMIN, process.env.JWT_SECRET, { expiresIn: '1h' }); }

function buildApp(pool) {
  jest.resetModules();
  jest.doMock('../db', () => ({ pool }));
  const router = require('../routes/performance');
  const app = express();
  app.use(express.json());
  app.use('/api/performance', router);
  return app;
}

describe('Manager performance reviews', () => {
  test('rejects a rating outside 1-5', async () => {
    const pool = makeMockPool([]);
    const app = buildApp(pool);

    const res = await request(app)
      .post('/api/performance/reviews')
      .set('Authorization', `Bearer ${token()}`)
      .send({ employee_id: 'EMP001', period_label: 'Sep 2026', rating: 9 });

    expect(res.status).toBe(400);
  });

  test('rejects a review for an employee outside company/scope', async () => {
    const pool = makeMockPool([
      [/SELECT employee_id, project FROM employees WHERE employee_id = \$1 AND company_id = \$2/i, () => ({ rows: [] })],
    ]);
    const app = buildApp(pool);

    const res = await request(app)
      .post('/api/performance/reviews')
      .set('Authorization', `Bearer ${token()}`)
      .send({ employee_id: 'EMP999', period_label: 'Sep 2026', rating: 4 });

    expect(res.status).toBe(404);
  });

  test('saves a valid review with qualitative feedback', async () => {
    const pool = makeMockPool([
      [/SELECT employee_id, project FROM employees WHERE employee_id = \$1 AND company_id = \$2/i, () => ({ rows: [{ employee_id: 'EMP001', project: 'MCGM HK' }] })],
      [/INSERT INTO performance_reviews/i, () => ({ rows: [{ id: 7, created_at: '2026-09-03T00:00:00.000Z' }] })],
    ]);
    const app = buildApp(pool);

    const res = await request(app)
      .post('/api/performance/reviews')
      .set('Authorization', `Bearer ${token()}`)
      .send({ employee_id: 'EMP001', period_label: 'Sep 2026', rating: 4, strengths: 'Reliable', feedback: 'Great teamwork this month.' });

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(7);
  });

  test('lists review history for an employee, most recent first', async () => {
    const pool = makeMockPool([
      [/FROM performance_reviews pr/i, () => ({ rows: [
        { id: 2, employee_id: 'EMP001', rating: 4, created_at: '2026-09-01' },
        { id: 1, employee_id: 'EMP001', rating: 3, created_at: '2026-08-01' },
      ] })],
    ]);
    const app = buildApp(pool);

    const res = await request(app)
      .get('/api/performance/reviews?employee_id=EMP001')
      .set('Authorization', `Bearer ${token()}`);

    expect(res.status).toBe(200);
    expect(res.body.count).toBe(2);
  });
});
