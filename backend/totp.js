// Minimal TOTP (Time-based One-Time Password, RFC 6238) implementation for the platform
// owner's (super_admin) optional 2FA login step — built entirely on Node's built-in `crypto`
// module so it doesn't need an extra npm dependency just for this. Compatible with any
// standard authenticator app (Google Authenticator, Authy, 1Password, etc.) since it follows
// the same RFC 6238 / RFC 4226 (HOTP) algorithm those apps already implement.

const crypto = require('crypto');

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const STEP_SECONDS = 30; // standard TOTP time-step
const DIGITS = 6;

// Generates a random 20-byte secret and returns it Base32-encoded (the format authenticator
// apps expect when you scan/enter it).
function generateSecret() {
  const bytes = crypto.randomBytes(20);
  return base32Encode(bytes);
}

function base32Encode(buffer) {
  let bits = 0;
  let value = 0;
  let output = '';
  for (let i = 0; i < buffer.length; i++) {
    value = (value << 8) | buffer[i];
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }
  return output;
}

function base32Decode(base32) {
  const clean = base32.toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0;
  let value = 0;
  const bytes = [];
  for (let i = 0; i < clean.length; i++) {
    const idx = BASE32_ALPHABET.indexOf(clean[i]);
    if (idx === -1) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

// Computes the 6-digit TOTP code for a given secret at a given Unix time (seconds).
function generateToken(base32Secret, atTimeSeconds = Math.floor(Date.now() / 1000)) {
  const key = base32Decode(base32Secret);
  const counter = Math.floor(atTimeSeconds / STEP_SECONDS);

  const counterBuffer = Buffer.alloc(8);
  counterBuffer.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  counterBuffer.writeUInt32BE(counter % 0x100000000, 4);

  const hmac = crypto.createHmac('sha1', key).update(counterBuffer).digest();
  const offset = hmac[hmac.length - 1] & 0xf;
  const binary =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);

  const token = (binary % 10 ** DIGITS).toString().padStart(DIGITS, '0');
  return token;
}

// Verifies a 6-digit code against the secret, allowing ±1 time-step (30s) of clock drift —
// the same tolerance window virtually every TOTP implementation uses, since phone/server
// clocks are rarely perfectly in sync.
function verifyToken(base32Secret, token) {
  if (!token || !/^\d{6}$/.test(String(token).trim())) return false;
  const clean = String(token).trim();
  const now = Math.floor(Date.now() / 1000);
  for (let drift = -1; drift <= 1; drift++) {
    if (generateToken(base32Secret, now + drift * STEP_SECONDS) === clean) return true;
  }
  return false;
}

// Builds the otpauth:// URI an authenticator app's QR-code scanner expects.
function buildOtpAuthUrl(secret, accountLabel, issuer = 'Geovixa') {
  const encodedIssuer = encodeURIComponent(issuer);
  const encodedLabel = encodeURIComponent(`${issuer}:${accountLabel}`);
  return `otpauth://totp/${encodedLabel}?secret=${secret}&issuer=${encodedIssuer}&algorithm=SHA1&digits=${DIGITS}&period=${STEP_SECONDS}`;
}

module.exports = { generateSecret, generateToken, verifyToken, buildOtpAuthUrl };
