import { randomBytes, scrypt, timingSafeEqual } from 'crypto';

/**
 * Password hashing for dashboard users (email + password sign-in). scrypt from node:crypto, so no
 * native dependency is added to the image: the gateway already builds better-sqlite3, and a second
 * native module would be a second thing to fail on an unusual platform.
 *
 * The stored string carries its own parameters (`scrypt$N$r$p$salt$hash`, salt and hash base64) so
 * they can be raised later without invalidating the hashes written before, exactly like a crypt(3)
 * string. N=2^15 with r=8, p=1 costs about 32 MiB and ~60 ms per verification on a 2020 laptop,
 * which is nothing per sign-in and a lot per guess.
 */
const SCRYPT_N = 32768;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LENGTH = 64;
const SALT_LENGTH = 16;

function scryptAsync(password: string, salt: Buffer, n: number, r: number, p: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    // maxmem must cover 128 * N * r bytes, which the 32 MiB default does not at N=2^15.
    scrypt(password, salt, KEY_LENGTH, { N: n, r, p, maxmem: 256 * n * r }, (err, key) => {
      if (err) reject(err);
      else resolve(key);
    });
  });
}

/** The self-describing hash of `password`, with a fresh random salt. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_LENGTH);
  const key = await scryptAsync(password, salt, SCRYPT_N, SCRYPT_R, SCRYPT_P);
  return ['scrypt', SCRYPT_N, SCRYPT_R, SCRYPT_P, salt.toString('base64'), key.toString('base64')].join('$');
}

/**
 * Whether `password` is the one `stored` was made from. A malformed or foreign `stored` value is
 * simply "no", never an exception, so a corrupt row cannot turn sign-in into a 500.
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const n = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (![n, r, p].every(v => Number.isInteger(v) && v > 0)) return false;
  const salt = Buffer.from(parts[4], 'base64');
  const expected = Buffer.from(parts[5], 'base64');
  if (salt.length === 0 || expected.length === 0) return false;
  let actual: Buffer;
  try {
    actual = await scryptAsync(password, salt, n, r, p);
  } catch {
    return false;
  }
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
