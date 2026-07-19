// Central place for password / PIN strength rules, so every route (auth, managers,
// coordinators, employees) enforces the exact same policy instead of each having its
// own ad-hoc `.length < 6` check.

// Admin / Manager / Coordinator passwords: at least 8 characters, at least one letter
// AND at least one number. (Not a full complexity policy — no special-char requirement —
// but meaningfully stronger than the old "any 6 characters" rule.)
function validatePassword(password) {
  if (!password || typeof password !== 'string') {
    return { ok: false, error: 'Password is required' };
  }
  if (password.length < 8) {
    return { ok: false, error: 'Password must be at least 8 characters long' };
  }
  if (!/[A-Za-z]/.test(password)) {
    return { ok: false, error: 'Password must contain at least one letter' };
  }
  if (!/[0-9]/.test(password)) {
    return { ok: false, error: 'Password must contain at least one number' };
  }
  return { ok: true };
}

// Employee PIN: exactly 4-6 digits. Deliberately numeric-only (keyboard-free on a phone
// lock screen) but long enough that it isn't trivially guessable, and never accepted as
// a raw fallback — every employee must have one to log in.
function validatePin(pin) {
  if (!pin || typeof pin !== 'string') {
    return { ok: false, error: 'PIN is required' };
  }
  if (!/^\d{4,6}$/.test(pin)) {
    return { ok: false, error: 'PIN must be 4 to 6 digits' };
  }
  return { ok: true };
}

// Used only to auto-generate a PIN for bulk-imported employees / legacy employees that
// pre-date the PIN column, so nobody is left with no PIN at all (which would either lock
// them out or, worse, tempt a fallback to no-PIN login). Admin must distribute these.
function generateRandomPin() {
  return String(Math.floor(1000 + Math.random() * 9000)); // 4-digit, 1000-9999
}

module.exports = { validatePassword, validatePin, generateRandomPin };
