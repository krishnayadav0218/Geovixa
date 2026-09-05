const express = require('express');
const request = require('supertest');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { makeMockPool } = require('./helpers/mockPool');

const COMPANY = { id: 1, name: 'Geovixa Demo', code: 'GEOVIXA', active: 1, expires_at: null };
const PASSWORD_HASH = bcrypt.hashSync('correct-horse-battery', 10);
const ADMIN_ACCOUNT = {
  id: 10, username: 'admin', password_hash: PASSWORD_HASH, role: 'admin',
  project: null, custom_role_name: null, scope_zone: null, scope_ward: null, scope_location: null,
};

function buildApp(pool) {
  jest.resetModules();
  jest.doMock('../db', () => ({ pool }));
  // Login writes an audit-log row and reads company settings — both go through the real
  // DB pool, so the mock above covers them; no separate mocking needed here.
  const authRoutes = require('../routes/auth');
  const app = express();
  app.use(express.json());
  app.use('/api/auth', authRoutes);
  return app;
}

function buildPool({ company = COMPANY, account = ADMIN_ACCOUNT } = {}) {
  return makeMockPool([
    [/FROM companies WHERE UPPER\(code\) = \$1/i, () => ({ rows: company ? [company] : [] })],
    [/FROM admins WHERE company_id = \$1 AND username = \$2/i, () => ({ rows: account ? [account] : [] })],
    [/INSERT INTO login_history/i, () => ({ rows: [] })],
    [/SELECT settings FROM companies WHERE id = \$1/i, () => ({ rows: [{ settings: {} }] })],
  ]);
}

describe('POST /api/auth/login', () => {
  test('returns a valid JWT for correct company code + username + password', async () => {
    const app = buildApp(buildPool());

    const res = await request(app).post('/api/auth/login').send({
      username: 'admin', password: 'correct-horse-battery', company_code: 'GEOVIXA',
    });

    expect(res.status).toBe(200);
    expect(res.body.token).toBeTruthy();
    expect(res.body.role).toBe('admin');
    const decoded = jwt.verify(res.body.token, process.env.JWT_SECRET);
    expect(decoded.company_id).toBe(COMPANY.id);
    expect(decoded.role).toBe('admin');
  });

  test('rejects a wrong password without revealing which part was wrong', async () => {
    const app = buildApp(buildPool());

    const res = await request(app).post('/api/auth/login').send({
      username: 'admin', password: 'totally-wrong', company_code: 'GEOVIXA',
    });

    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/Invalid Company Code, username or password/i);
    expect(res.body.token).toBeUndefined();
  });

  test('rejects an unknown company code', async () => {
    const app = buildApp(buildPool({ company: null }));

    const res = await request(app).post('/api/auth/login').send({
      username: 'admin', password: 'correct-horse-battery', company_code: 'DOESNOTEXIST',
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Company Code not found/i);
  });

  test('rejects an inactive company even with correct credentials', async () => {
    const app = buildApp(buildPool({ company: { ...COMPANY, active: 0 } }));

    const res = await request(app).post('/api/auth/login').send({
      username: 'admin', password: 'correct-horse-battery', company_code: 'GEOVIXA',
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/inactive/i);
  });

  test('rejects a missing username/password before touching the database', async () => {
    const app = buildApp(buildPool());

    const res = await request(app).post('/api/auth/login').send({ company_code: 'GEOVIXA' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/required/i);
  });
});
