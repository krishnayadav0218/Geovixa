require('dotenv').config();
const bcrypt = require('bcryptjs');
const { pool } = require('./db');

module.exports = async function seedManager() {
  const username = process.env.MANAGER_USERNAME || 'manager';
  const password = process.env.MANAGER_PASSWORD || 'Krystal@Mgr2026';

  const { rows } = await pool.query('SELECT * FROM admins WHERE username = $1', [username]);
  if (rows[0]) {
    console.log(`Manager '${username}' already exists. Skipping.`);
    return;
  }

  const hash = bcrypt.hashSync(password, 10);
  await pool.query("INSERT INTO admins (username, password_hash, role) VALUES ($1, $2, 'manager')", [username, hash]);
  console.log(`✅ Manager created -> username: ${username} | password: ${password}`);
  console.log('IMPORTANT: Change this password after first login / change MANAGER_PASSWORD in .env before running this again.');
};
