require('dotenv').config();
const bcrypt = require('bcryptjs');
const { pool } = require('./db');
const { validatePassword } = require('./policy');

const DEFAULT_PASSWORD = 'Geovixa@Mgr2026';

// Creates the default manager account for the DEFAULT company on first boot. `companyId`
// comes from db.init()'s default-company resolution (see server.js).
module.exports = async function seedManager(companyId) {
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

  const { rows } = await pool.query(
    'SELECT * FROM admins WHERE username = $1 AND company_id = $2',
    [username, companyId]
  );
  if (rows[0]) {
    console.log(`Manager '${username}' already exists. Skipping.`);
    return;
  }

  const hash = bcrypt.hashSync(password, 10);
  await pool.query(
    "INSERT INTO admins (username, password_hash, role, company_id) VALUES ($1, $2, 'manager', $3)",
    [username, hash, companyId]
  );
  if (usingDefault) {
    console.log(`✅ Manager created -> username: ${username} | password: ${password}`);
    console.log('⚠️  IMPORTANT: This is the DEFAULT password. Change it immediately after first login (Settings tab), or set MANAGER_PASSWORD in .env before running this again.');
  } else {
    console.log(`✅ Manager created -> username: ${username} (password set from MANAGER_PASSWORD env var)`);
  }
};
