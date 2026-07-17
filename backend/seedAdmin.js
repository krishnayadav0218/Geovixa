require('dotenv').config();
const bcrypt = require('bcryptjs');
const { pool } = require('./db');

// Creates the default admin account on first boot, skips if it's already there.
// Postgres queries are async now, so this got turned into a function server.js awaits,
// instead of running straight away on require() like the old sqlite version did.
module.exports = async function seedAdmin() {
  const username = process.env.ADMIN_USERNAME || 'admin';
  const password = process.env.ADMIN_PASSWORD || 'KrystalConnect@2026';

  const { rows } = await pool.query('SELECT * FROM admins WHERE username = $1', [username]);
  if (rows[0]) {
    console.log(`Admin '${username}' already exists. Skipping.`);
    return;
  }

  const hash = bcrypt.hashSync(password, 10);
  await pool.query('INSERT INTO admins (username, password_hash) VALUES ($1, $2)', [username, hash]);
  console.log(`✅ Admin created -> username: ${username} | password: ${password}`);
  console.log('IMPORTANT: Change this password after first login / change ADMIN_PASSWORD in .env before running this again.');
};
