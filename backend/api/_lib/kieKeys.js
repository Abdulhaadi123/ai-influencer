/**
 * ─────────────────────────────────────────────────────────────────────────────
 * The KIE key pool — which key to call KIE with.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * KIE limits what one account may start per ten seconds and how many tasks may run at once. One key is
 * therefore a ceiling for the whole studio. Keys from more than one KIE account are kept in
 * `kie_api_keys` (migration 013; added in the admin panel, sealed by keyVault.js), and every NEW request
 * takes the next one in turn.
 *
 * ── Round-robin ──────────────────────────────────────────────────────────────
 *
 * "The key used longest ago goes next", decided and recorded in ONE statement, so requests that arrive
 * together get different keys (FOR UPDATE SKIP LOCKED passes over a row another request is taking) and
 * the order survives a restart. A key that KIE has just refused (rate limit, no credits, rejected) is
 * put to the back of the line for a while, and the same request is tried with the next one (api/kie.js).
 * When every key is in that state they are all tried anyway: refusing a person because a key MIGHT still
 * be limited is worse than asking.
 *
 * ── A task stays with the key that started it ───────────────────────────────
 *
 * KIE only tells an account about its own tasks. Asking after a task (the worker, a screen's sync, the
 * proxy's recordInfo) therefore uses the key recorded in task_owners (`keyForTask`), never the next one
 * in turn. A task with no key recorded (everything from before the pool) was started with the server's
 * own KIE_API_KEY.
 *
 * ── The server's own key ─────────────────────────────────────────────────────
 *
 * KIE_API_KEY still works with no setup: it is the pool's row with source = 'env', which holds no secret
 * (the value stays in the environment). It takes its turn like the others and can be paused in the panel.
 *
 * Nothing in here logs or returns a key except to the code that is about to send it.
 */

import { one, many, query } from './db.js'
import { seal, unseal, vaultConfigured, VaultError } from './keyVault.js'

/** Overridable only so tests can stand in for KIE; production uses the default. */
const KIE_BASE = process.env.KIE_BASE_URL || 'https://api.kie.ai'
const PROBE_TIMEOUT_MS = 15_000

/**
 * How long a refused key waits at the back of the line. KIE counts its limit over ten seconds, so a rate
 * limit clears quickly; an empty account or a refused key needs a person, so those are asked again only
 * now and then (and at once when someone presses Check in the panel).
 */
export const COOLDOWN_MS = Object.freeze({
  rate_limited: 10_000,
  no_credits: 5 * 60_000,
  rejected: 5 * 60_000,
  unreadable: 60_000,
})

export const PROBLEMS = Object.freeze(Object.keys(COOLDOWN_MS))

/** The server's own key, from the environment. Read when used, so a change needs no code to reload. */
export const envKeyValue = () => process.env.KIE_API_KEY || ''

/** What ties a sealed value to its row (keyVault.js). */
const keyContext = id => `kie-key:${id}`
const webhookContext = id => `kie-webhook:${id}`

export const sealKey = (id, apiKey) => seal(apiKey, keyContext(id))
export const sealWebhookSecret = (id, secret) => seal(secret, webhookContext(id))

const COLUMNS = 'id, source, label, key_enc, webhook_enc, problem'

/**
 * A row as the code that calls KIE needs it, or null when it cannot be used (no secret for the server's
 * own key; a sealed key that no longer opens, which is noted so it stops taking turns).
 *
 * @returns {Promise<{id: string, source: 'env'|'panel', label: string, secret: string,
 *                    webhookSecret: string|null, problem: string|null}|null>}
 */
async function open(row) {
  if (row.source === 'env') {
    const secret = envKeyValue()
    return secret ? { id: row.id, source: 'env', label: row.label, secret, webhookSecret: null, problem: row.problem } : null
  }
  try {
    return {
      id: row.id, source: 'panel', label: row.label, problem: row.problem,
      secret: unseal(row.key_enc, keyContext(row.id)),
      webhookSecret: row.webhook_enc ? unseal(row.webhook_enc, webhookContext(row.id)) : null,
    }
  } catch (e) {
    if (!(e instanceof VaultError)) throw e
    console.error(`[kie-keys] the key "${row.label}" cannot be read (${e.code}); skipping it`)
    await noteKeyProblem(row.id, 'unreadable')
    return null
  }
}

/**
 * Take the next key in the rotation, recording the turn. `exclude` are keys this request has already
 * tried. Null when there is nothing to take.
 */
export async function acquireKey({ exclude = [] } = {}) {
  const skip = [...exclude]
  // Bounded: every pass either returns or adds one key to `skip`.
  for (let i = 0; i < 50; i++) {
    const row = await pickNext(skip)
    if (!row) return null
    const key = await open(row)
    if (key) return key
    skip.push(row.id)
  }
  return null
}

/**
 * The statement that is the rotation. Healthy keys first, the one used longest ago first among them;
 * keys cooling down only when no healthy one is left.
 *
 * SKIP LOCKED is what makes two requests at the same instant take two different keys. If it passes over
 * the only candidate (another request holds the row for a moment), the second statement waits for it.
 */
async function pickNext(skip) {
  const sql = lock => `
    update kie_api_keys
       set last_used_at = clock_timestamp(), uses = uses + 1
     where id = (
       select id from kie_api_keys
        where enabled
          and (source = 'panel' or $1::boolean)
          and not (id = any($2::uuid[]))
        order by (cooldown_until is not null and cooldown_until > clock_timestamp()),
                 last_used_at nulls first, created_at, id
        limit 1
          for update ${lock}
     )
    returning ${COLUMNS}`
  const params = [envKeyValue() !== '', skip]
  return (await one(sql('skip locked'), params)) ?? (await one(sql(''), params))
}

/** Whether at least one key is in the rotation: the question "is generation set up at all?". */
export async function hasKeyInRotation() {
  const row = await one(
    `select exists (select 1 from kie_api_keys where enabled and (source = 'panel' or $1::boolean)) as yes`,
    [envKeyValue() !== ''],
  )
  return row.yes
}

/**
 * A key by id, whether or not it is in the rotation (a paused key still finishes the tasks it started).
 * No id, or one that is gone, is the server's own key.
 */
export async function keyById(id) {
  const row = (id ? await one(`select ${COLUMNS} from kie_api_keys where id = $1`, [id]) : null)
    ?? (await one(`select ${COLUMNS} from kie_api_keys where source = 'env'`))
  return row ? open(row) : null
}

/** The key that started `taskId`. */
export async function keyForTask(taskId) {
  const row = typeof taskId === 'string' && taskId
    ? await one('select kie_key_id from task_owners where kie_task_id = $1', [taskId])
    : null
  return keyById(row?.kie_key_id ?? null)
}

/**
 * KIE refused this key. Put to the back of the line for a while (COOLDOWN_MS). Never throws: a failure
 * to write this down must not fail the request that found it out.
 */
export async function noteKeyProblem(id, kind) {
  if (!PROBLEMS.includes(kind)) return
  try {
    await query(
      `update kie_api_keys
          set problem = $2, problem_at = now(), cooldown_until = now() + $3::int * interval '1 millisecond'
        where id = $1`,
      [id, kind, COOLDOWN_MS[kind]],
    )
  } catch (e) {
    console.error('[kie-keys] could not record a refused key:', e?.message ?? e)
  }
}

/** KIE accepted this key: whatever was wrong is over. Only writes when something was recorded. */
export async function noteKeyWorked(key) {
  if (!key?.problem) return
  try {
    await query('update kie_api_keys set problem = null, problem_at = null, cooldown_until = null where id = $1', [key.id])
  } catch (e) {
    console.error('[kie-keys] could not clear a recovered key:', e?.message ?? e)
  }
}

/**
 * Whether KIE's answer is a refusal of the KEY, as opposed to a refusal of the request, which any key
 * would meet too. KIE reports many of these as HTTP 200 with the status inside the body, so both are read.
 * In every one of these cases KIE has done nothing, so asking again with another key is safe.
 *
 * @returns {'rate_limited'|'no_credits'|'rejected'|null}
 */
export function refusalOf(status, bodyText) {
  let code = null
  try {
    const json = JSON.parse(bodyText)
    if (json && typeof json === 'object' && typeof json.code === 'number') code = json.code
  } catch { /* not JSON: only the HTTP status can say */ }
  for (const value of [status, code]) {
    if (value === 429) return 'rate_limited'
    if (value === 402) return 'no_credits'
    if (value === 401 || value === 403) return 'rejected'
  }
  return null
}

/** Every webhook HMAC key stored with a key (api/kie-callback.js accepts a callback signed with any). */
export async function webhookSecrets() {
  const rows = await many('select id, webhook_enc from kie_api_keys where webhook_enc is not null')
  const secrets = []
  for (const row of rows) {
    try { secrets.push(unseal(row.webhook_enc, webhookContext(row.id))) } catch { /* unreadable: it cannot verify anything */ }
  }
  return secrets
}

/**
 * Ask KIE for the balance with `secret`: the cheapest call that tells a working key from a wrong one.
 *
 * @returns {Promise<{result: 'ok', balance: number|null}|{result: 'rejected'|'unreachable'|'unexpected'}>}
 */
export async function probeKey(secret) {
  let res, text
  try {
    res = await fetch(`${KIE_BASE}/api/v1/chat/credit`, {
      headers: { Authorization: `Bearer ${secret}` },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    })
    text = await res.text()
  } catch {
    return { result: 'unreachable' }
  }
  const refusal = refusalOf(res.status, text)
  if (refusal === 'rejected') return { result: 'rejected' }
  // A rate limit says the key is known; an empty account is a working key with nothing in it.
  if (refusal === 'rate_limited') return { result: 'ok', balance: null }
  if (refusal === 'no_credits') return { result: 'ok', balance: 0 }
  let json = null
  try { json = JSON.parse(text) } catch { /* handled below */ }
  if (res.ok && json?.code === 200) {
    const balance = typeof json.data === 'number' || typeof json.data === 'string' ? Number(json.data) : NaN
    return { result: 'ok', balance: Number.isFinite(balance) ? balance : null }
  }
  return { result: 'unexpected' }
}

/**
 * What to say in the log when the server starts: how many keys take turns, and the one mistake that would
 * leave keys added in the panel unusable. Lines are `{level: 'info'|'error', text}`.
 */
export async function describeKeyPool() {
  const rows = await many('select source, enabled from kie_api_keys')
  const panel = rows.filter(r => r.source === 'panel')
  const own = envKeyValue() !== '' && rows.some(r => r.source === 'env' && r.enabled)
  const readable = vaultConfigured()
  const usable = (own ? 1 : 0) + (readable ? panel.filter(r => r.enabled).length : 0)

  const lines = []
  if (usable) {
    const parts = [own ? 'the server\'s own key' : null, panel.length ? `${panel.length} added in the admin panel` : null].filter(Boolean)
    lines.push({ level: 'info', text: `KIE keys taking turns: ${usable} (${parts.join(' and ')}).` })
  } else {
    lines.push({ level: 'error', text: 'No KIE key is in rotation: set KIE_API_KEY or add a key in the admin panel. Generation is unavailable until then.' })
  }
  if (panel.length && !readable) {
    lines.push({ level: 'error', text: `${panel.length} KIE key(s) were added in the admin panel but KEY_VAULT_SECRET is not set (or is under 32 characters), so they cannot be used.` })
  }
  return lines
}
