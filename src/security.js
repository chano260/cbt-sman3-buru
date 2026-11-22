const crypto = require('node:crypto');

const HASH_PREFIX = 'scrypt$';

function hashPassword(plain) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(plain), salt, 32).toString('hex');
  return `${HASH_PREFIX}${salt}$${hash}`;
}

function isHashed(stored) {
  return typeof stored === 'string' && stored.startsWith(HASH_PREFIX);
}

function verifyPassword(plain, stored) {
  if (!isHashed(stored)) return false;
  const [, salt, hash] = stored.split('$');
  const expected = Buffer.from(hash, 'hex');
  const actual = crypto.scryptSync(String(plain), salt, expected.length);
  return crypto.timingSafeEqual(expected, actual);
}

function safeEqual(a, b) {
  const ba = Buffer.from(String(a || ''));
  const bb = Buffer.from(String(b || ''));
  return ba.length > 0 && ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

function randomToken(bytes = 24) {
  return crypto.randomBytes(bytes).toString('hex');
}

// Password bawaan akun staf (tercatat di kode & panduan) — wajib diganti saat dipakai login
const DEFAULT_STAFF_PASSWORDS = ['admin123', 'guru123', 'pengawas123'];
function isDefaultStaffPassword(pw) {
  return DEFAULT_STAFF_PASSWORDS.includes(String(pw || '').trim());
}

module.exports = { hashPassword, isHashed, verifyPassword, safeEqual, randomToken, DEFAULT_STAFF_PASSWORDS, isDefaultStaffPassword };
