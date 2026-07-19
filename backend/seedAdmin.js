require('dotenv').config();
const bcrypt = require('bcryptjs');
const { pool } = require('./db');
const { validatePassword } = require('./policy');

const DEFAULT_PASSWORD = 'KrystalConnect@2026';

// Creates the default admin account on first boot, skips if it's already there.
// Postgres queries are async now, so this got turned into a function server.js awaits,
// instead of running straight away on require() like the old sqlite version did.
module.exports = async function seedAdmin() {
  const username = process.env.ADMIN_USERNAME || 'admin';
  const usingDefault = !process.env.ADMIN_PASSWORD;
  const password = process.env.ADMIN_PASSWORD || DEFAULT_PASSWORD;

  // SECURITY: a well-known default password ("change-this-password" or the old hardcoded
  // KrystalConnect@2026) sitting on a live, internet-reachable admin login is a real risk —
  // anyone who reads the public README/source knows it. In production, refuse to boot with
  // it instead of silently seeding a guessable account.
  if (process.env.NODE_ENV === 'production' && usingDefault) {
    throw new Error(
      'ADMIN_PASSWORD is not set. Refusing to start in production with the default admin password. ' +
      'Set ADMIN_PASSWORD (and ideally ADMIN_USERNAME) in your environment before deploying.'
    );
  }
  const check = validatePassword(password);
  if (!check.ok) {
    throw new Error(`ADMIN_PASSWORD is invalid: ${check.error}`);
  }

  const { rows } = await pool.query('SELECT * FROM admins WHERE username = $1', [username]);
  if (rows[0]) {
    console.log(`Admin '${username}' already exists. Skipping.`);
    return;
  }

  const hash = bcrypt.hashSync(password, 10);
  await pool.query('INSERT INTO admins (username, password_hash) VALUES ($1, $2)', [username, hash]);
  if (usingDefault) {
    console.log(`✅ Admin created -> username: ${username} | password: ${password}`);
    console.log('⚠️  IMPORTANT: This is the DEFAULT password. Change it immediately after first login (Settings tab), or set ADMIN_PASSWORD in .env before running this again.');
  } else {
    console.log(`✅ Admin created -> username: ${username} (password set from ADMIN_PASSWORD env var)`);
  }
};
