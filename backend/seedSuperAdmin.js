require('dotenv').config();
const bcrypt = require('bcryptjs');
const { pool } = require('./db');
const { validatePassword } = require('./policy');

const DEFAULT_PASSWORD = 'Geovixa@Owner2026';

// Creates the platform-owner (super_admin) account on first boot — this is YOUR login,
// separate from any individual company's Admin, used only to add/manage the companies you
// sell this app to (Companies panel). company_id is always NULL for this account.
module.exports = async function seedSuperAdmin() {
  const username = process.env.SUPER_ADMIN_USERNAME || 'owner';
  const usingDefault = !process.env.SUPER_ADMIN_PASSWORD;
  const password = process.env.SUPER_ADMIN_PASSWORD || DEFAULT_PASSWORD;

  if (process.env.NODE_ENV === 'production' && usingDefault) {
    throw new Error(
      'SUPER_ADMIN_PASSWORD is not set. Refusing to start in production with the default platform-owner password. ' +
      'Set SUPER_ADMIN_PASSWORD (and ideally SUPER_ADMIN_USERNAME) in your environment before deploying.'
    );
  }
  const check = validatePassword(password);
  if (!check.ok) {
    throw new Error(`SUPER_ADMIN_PASSWORD is invalid: ${check.error}`);
  }

  const { rows } = await pool.query(
    "SELECT * FROM admins WHERE username = $1 AND role = 'super_admin' AND company_id IS NULL",
    [username]
  );
  if (rows[0]) {
    console.log(`Platform owner '${username}' already exists. Skipping.`);
    return;
  }

  const hash = bcrypt.hashSync(password, 10);
  await pool.query(
    "INSERT INTO admins (username, password_hash, role, company_id) VALUES ($1, $2, 'super_admin', NULL)",
    [username, hash]
  );
  if (usingDefault) {
    console.log(`✅ Platform owner account created -> username: ${username} | password: ${password}`);
    console.log('⚠️  IMPORTANT: This is the DEFAULT password. Change it immediately, or set SUPER_ADMIN_PASSWORD in .env before running this again.');
  } else {
    console.log(`✅ Platform owner account created -> username: ${username} (password set from SUPER_ADMIN_PASSWORD env var)`);
  }
};
