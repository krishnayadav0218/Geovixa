require('dotenv').config();
const bcrypt = require('bcryptjs');
const db = require('./db');

const username = process.env.MANAGER_USERNAME || 'manager';
const password = process.env.MANAGER_PASSWORD || 'Krystal@Mgr2026';

const existing = db.prepare('SELECT * FROM admins WHERE username = ?').get(username);

if (existing) {
  console.log(`Manager '${username}' already exists. Skipping.`);
} else {
  const hash = bcrypt.hashSync(password, 10);
  db.prepare("INSERT INTO admins (username, password_hash, role) VALUES (?, ?, 'manager')").run(username, hash);
  console.log(`✅ Manager created -> username: ${username} | password: ${password}`);
  console.log('IMPORTANT: Change this password after first login / change MANAGER_PASSWORD in .env before running this again.');
}
