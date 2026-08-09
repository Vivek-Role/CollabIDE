import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

/**
 * Password hashing with scrypt from node:crypto.
 *
 * scrypt rather than bcrypt/argon2 because it is in the standard library: no
 * native module, no compile step, nothing to rebuild when Node upgrades.
 *
 * Encoded as:  scrypt$N$r$p$<salt-b64>$<hash-b64>
 *
 * The parameters live *inside* the string on purpose. Raising the cost later
 * does not invalidate existing hashes — old ones keep verifying with the
 * parameters they were created with, and can be re-hashed on next login.
 */

const scrypt = promisify(scryptCallback) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

const PREFIX = 'scrypt';
const SALT_BYTES = 16;
const KEY_LENGTH = 64;

/** Current cost. 2**15 is ~100ms on this hardware — slow enough to matter, fast
 *  enough that a login does not feel broken. */
const DEFAULT_PARAMS = { N: 2 ** 15, r: 8, p: 1 } as const;

/** scrypt needs roughly 128 * N * r bytes; at N=2**15, r=8 that is exactly the
 *  32 MB default limit, so it must be raised or every hash throws. */
const MAX_MEM = 96 * 1024 * 1024;

export async function hashPassword(password: string): Promise<string> {
  const { N, r, p } = DEFAULT_PARAMS;
  const salt = randomBytes(SALT_BYTES);
  const key = await scrypt(password, salt, KEY_LENGTH, { N, r, p, maxmem: MAX_MEM });

  return [PREFIX, N, r, p, salt.toString('base64'), key.toString('base64')].join('$');
}

export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const parts = encoded.split('$');
  if (parts.length !== 6 || parts[0] !== PREFIX) return false;

  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  const salt = Buffer.from(parts[4] ?? '', 'base64');
  const expected = Buffer.from(parts[5] ?? '', 'base64');

  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return false;
  if (salt.length === 0 || expected.length === 0) return false;

  const actual = await scrypt(password, salt, expected.length, { N, r, p, maxmem: MAX_MEM });

  // Lengths are equal by construction above, but timingSafeEqual throws if they
  // ever are not, so check first.
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}

/**
 * Burn the same work as a real verification when the email does not exist.
 *
 * Without this, "unknown email" returns in ~1ms and "wrong password" in ~100ms,
 * and that difference is a free account-enumeration oracle.
 */
let dummyHash: string | undefined;
let warming: Promise<string> | undefined;

function dummy(): Promise<string> {
  warming ??= hashPassword('an unused password, hashed once per process').then((hash) => {
    dummyHash = hash;
    return hash;
  });
  return warming;
}

export async function burnVerificationTime(): Promise<void> {
  const hash = dummyHash ?? (await dummy());
  await verifyPassword('definitely not the password', hash);
}

/**
 * Built at startup, not on first use. Otherwise the very first login against an
 * unknown email pays to create it and is measurably slower than the rest —
 * which is the exact timing signal this whole mechanism exists to remove.
 */
void dummy().catch(() => {
  // Retried on demand by burnVerificationTime; nothing to do here.
  warming = undefined;
});
