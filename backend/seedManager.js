require('dotenv').config();
const bcrypt = require('bcryptjs');
const { pool } = require('./db');
const { validatePassword } = require('./policy');

const DEFAULT_PASSWORD = 'KrystalConnect@Mgr2026';

module.exports = async function seedManager() {
  const username = process.env.MANAGER_USERNAME || 'manager';
  const usingDefault = !process.env.MANAGER_PASSWORD;
  const password = process.env.MANAGER_PASSWORD || DEFAULT_PASSWORD;

  if (process.env.NODE_ENV === 'production' && usingDefault) {
    throw new Error(
      'MANAGER_PASSWORD is not set. Refusing to start in production with the default manager password. ' +
      'Set MANAGER_PASSWORD (and ideally MANAGER_USERNAME) in your environment before deploying.'
    );
  }
  const check = validatePassword(password);
  if (!check.ok) {
    throw new Error(`MANAGER_PASSWORD is invalid: ${check.error}`);
  }

  const { rows } = await pool.query('SELECT * FROM admins WHERE username = $1', [username]);
  if (rows[0]) {
    console.log(`Manager '${username}' already exists. Skipping.`);
    return;
  }

  const hash = bcrypt.hashSync(password, 10);
  await pool.query("INSERT INTO admins (username, password_hash, role) VALUES ($1, $2, 'manager')", [username, hash]);
  if (usingDefault) {
    console.log(`✅ Manager created -> username: ${username} | password: ${password}`);
    console.log('⚠️  IMPORTANT: This is the DEFAULT password. Change it immediately after first login (Settings tab), or set MANAGER_PASSWORD in .env before running this again.');
  } else {
    console.log(`✅ Manager created -> username: ${username} (password set from MANAGER_PASSWORD env var)`);
  }
};
