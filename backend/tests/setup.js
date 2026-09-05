// Runs before the test framework is installed, before every test file.
// Route modules (and server.js) read these at require-time, and db.js throws
// immediately if DATABASE_URL is missing — so these must exist before anything
// under test is required. Tests never hit a real Postgres instance: every route
// test mocks '../db' directly (see tests/helpers/mockPool.js), so this value is
// never actually used to open a connection.
process.env.JWT_SECRET = 'test-jwt-secret-only-used-in-automated-tests-1234567890';
process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test_db_never_used';
process.env.NODE_ENV = 'test';
