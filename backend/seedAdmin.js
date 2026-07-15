require('dotenv').config();
const bcrypt = require('bcryptjs');
const db = require('./db');

const username = process.env.ADMIN_USERNAME || 'admin';
const password = process.env.ADMIN_PASSWORD || 'Mtdc@2026';

const existing = db.prepare('SELECT * FROM admins WHERE username = ?').get(username);

if (existing) {
  console.log(`Admin '${username}' already exists. Skipping.`);
} else {
  const hash = bcrypt.hashSync(password, 10);
  db.prepare('INSERT INTO admins (username, password_hash) VALUES (?, ?)').run(username, hash);
  console.log(`✅ Admin created -> username: ${username} | password: ${password}`);
  console.log('IMPORTANT: Change this password after first login / change ADMIN_PASSWORD in .env before running this again.');
}
