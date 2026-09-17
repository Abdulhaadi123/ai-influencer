/**
 * ─────────────────────────────────────────────────────────────────────────────
 * Passwords.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Stored only as Argon2id hashes, with OWASP's recommended settings: 19 MiB of
 * memory, 2 iterations, 1 lane. Argon2id is deliberately slow and memory-hungry
 * to compute, so a stolen table of hashes cannot be guessed through quickly.
 *
 * The rule for this file and everything that calls it: a password is hashed or
 * verified and then dropped. It is never logged, never stored in any other form,
 * never returned, and never put in an error message.
 */

import { hash, verify } from '@node-rs/argon2'
import { randomBytes } from 'node:crypto'

const ARGON2 = { memoryCost: 19456, timeCost: 2, parallelism: 1 }

export const MIN_PASSWORD_LENGTH = 10

/** Long enough for any passphrase; short enough that hashing stays cheap. */
export const MAX_PASSWORD_LENGTH = 128

/** The passwords that head every credential-stuffing list. */
const TOO_COMMON = /^(password|12345678|qwerty|letmein|welcome)/i

/** @returns {string|null} what is wrong with the password, for the person choosing it */
export function passwordProblem(password) {
  const p = typeof password === 'string' ? password : ''
  if (p.length < MIN_PASSWORD_LENGTH) return `Use at least ${MIN_PASSWORD_LENGTH} characters.`
  if (p.length > MAX_PASSWORD_LENGTH) return `Use ${MAX_PASSWORD_LENGTH} characters or fewer.`
  if (!/[a-zA-Z]/.test(p) || !/[0-9]/.test(p)) return 'Include at least one letter and one number.'
  if (TOO_COMMON.test(p)) return 'That password is too easy to guess.'
  return null
}

export function hashPassword(password) {
  return hash(password, ARGON2)
}

let dummyHash = null

/**
 * Check a password against a stored hash.
 *
 * With no hash — no such account — it still does the full, slow verification
 * against a throwaway hash. Returning at once would make "no account" answer
 * measurably faster than "wrong password", which tells anyone timing the
 * response which email addresses are registered.
 *
 * @param {string|null} passwordHash
 * @returns {Promise<boolean>}
 */
export async function verifyPassword(passwordHash, password) {
  if (typeof password !== 'string' || !password || password.length > MAX_PASSWORD_LENGTH) return false

  if (!passwordHash) {
    dummyHash ??= await hash(randomBytes(24).toString('hex'), ARGON2)
    await verify(dummyHash, password).catch(() => false)
    return false
  }

  try {
    return await verify(passwordHash, password)
  } catch {
    return false
  }
}
