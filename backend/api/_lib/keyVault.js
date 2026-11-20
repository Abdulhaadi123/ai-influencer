/**
 * ─────────────────────────────────────────────────────────────────────────────
 * The key vault — API keys kept in the database, sealed.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * A KIE key added in the admin panel has to be readable by the server (it is sent to KIE with every
 * request) and by nothing else. So it is stored sealed with AES-256-GCM, under a key derived from
 * KEY_VAULT_SECRET — a value that exists only in the server's environment. A copy of the database (the
 * daily backup in S3 is one) then holds ciphertext, not a key that spends money.
 *
 *   • GCM authenticates as well as encrypts: a changed byte, a wrong secret and a ciphertext moved to
 *     another row are all refused, never decoded into something wrong.
 *   • Each value is sealed under a fresh random nonce, and is bound to a `context` (the row it belongs
 *     to), so two rows holding the same key look nothing alike and cannot be swapped.
 *   • A sealed value is `v1.<nonce>.<tag>.<ciphertext>`, base64url. The prefix is there for the day the
 *     scheme changes.
 *
 * Losing or changing KEY_VAULT_SECRET makes every sealed key unreadable (the panel says so, and the server
 * skips them); it does not damage anything else. The keys are then added again.
 *
 * What is NOT done here: protecting the secret itself. Anyone who can read the server's environment can
 * read the keys — as they could the KIE_API_KEY that was there before.
 */

import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from 'node:crypto'

/** Shorter than this is not a secret worth the name; the vault then counts as not set up. */
export const MIN_SECRET_LENGTH = 32

const VERSION = 'v1'
const NONCE_BYTES = 12
const TAG_BYTES = 16

export class VaultError extends Error {
  constructor(message, code) {
    super(message)
    this.name = 'VaultError'
    this.code = code
  }
}

/** The 32-byte encryption key, or null when KEY_VAULT_SECRET is missing or too short. */
function masterKey() {
  const secret = process.env.KEY_VAULT_SECRET || ''
  if (secret.length < MIN_SECRET_LENGTH) return null
  return Buffer.from(hkdfSync('sha256', Buffer.from(secret, 'utf8'), Buffer.from('influencer/key-vault', 'utf8'), Buffer.from('kie-api-keys v1', 'utf8'), 32))
}

/** Whether keys can be stored and read at all. */
export const vaultConfigured = () => masterKey() !== null

const b64 = buffer => buffer.toString('base64url')

/**
 * @param {string} plain    the value to protect
 * @param {string} context  what it belongs to (the row), so it cannot be moved
 * @returns {string}        the sealed text
 */
export function seal(plain, context) {
  const key = masterKey()
  if (!key) throw new VaultError('KEY_VAULT_SECRET is not set (or shorter than 32 characters).', 'VAULT_NOT_CONFIGURED')
  const nonce = randomBytes(NONCE_BYTES)
  const cipher = createCipheriv('aes-256-gcm', key, nonce, { authTagLength: TAG_BYTES })
  cipher.setAAD(Buffer.from(String(context), 'utf8'))
  const body = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()])
  return [VERSION, b64(nonce), b64(cipher.getAuthTag()), b64(body)].join('.')
}

/**
 * @param {string} sealed
 * @param {string} context  the same one it was sealed with
 * @returns {string}
 * @throws {VaultError}  VAULT_NOT_CONFIGURED, or VAULT_UNREADABLE for anything that does not open
 */
export function unseal(sealed, context) {
  const key = masterKey()
  if (!key) throw new VaultError('KEY_VAULT_SECRET is not set (or shorter than 32 characters).', 'VAULT_NOT_CONFIGURED')
  const parts = typeof sealed === 'string' ? sealed.split('.') : []
  if (parts.length !== 4 || parts[0] !== VERSION) throw new VaultError('This value is not in a form the vault can read.', 'VAULT_UNREADABLE')
  try {
    const nonce = Buffer.from(parts[1], 'base64url')
    const tag = Buffer.from(parts[2], 'base64url')
    if (nonce.length !== NONCE_BYTES || tag.length !== TAG_BYTES) throw new Error('bad lengths')
    const decipher = createDecipheriv('aes-256-gcm', key, nonce, { authTagLength: TAG_BYTES })
    decipher.setAAD(Buffer.from(String(context), 'utf8'))
    decipher.setAuthTag(tag)
    return Buffer.concat([decipher.update(Buffer.from(parts[3], 'base64url')), decipher.final()]).toString('utf8')
  } catch {
    throw new VaultError('This value could not be opened: the secret changed, or the value was altered.', 'VAULT_UNREADABLE')
  }
}

/** A one-way fingerprint, so the same key is recognised without being kept in the clear. */
export const fingerprintOf = value => createHash('sha256').update(String(value)).digest('hex')

/** `…ab12` — the last four characters, enough to tell two keys apart. */
export const hintOf = value => {
  const text = String(value)
  return text.length > 8 ? `…${text.slice(-4)}` : '…'
}
