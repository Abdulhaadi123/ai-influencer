/**
 * Admin — the KIE key pool.
 *
 *   GET  /api/admin/kie-keys
 *   POST /api/admin/kie-keys/add     { label, key, webhookSecret?, verify? }
 *   POST /api/admin/kie-keys/update  { id, enabled?, label?, webhookSecret? }
 *   POST /api/admin/kie-keys/check   { id }
 *   POST /api/admin/kie-keys/delete  { id }
 *
 * The keys the server calls KIE with, taken in turn for every new request (api/_lib/kieKeys.js). The
 * server's own KIE_API_KEY is the first row and is always there; the others are added here, so a studio
 * that has outgrown one KIE account's limits can add the keys of more accounts without touching the server.
 *
 * The key is typed in once and never shown again: it is sealed (api/_lib/keyVault.js) before it reaches the
 * database, and no response, log line or audit entry in this file ever carries it. All that is shown is a
 * hint (`…ab12`) to tell two keys apart.
 */

import { randomUUID } from 'node:crypto'

import { many, one, transaction } from '../_lib/db.js'
import { adminRoute, audit, requiredText } from '../_lib/admin.js'
import { badRequest, notFound, noStore, HttpError } from '../_lib/http.js'
import { isUuid } from '../_lib/validate.js'
import { fingerprintOf, hintOf, unseal, vaultConfigured, VaultError } from '../_lib/keyVault.js'
import { COOLDOWN_MS, envKeyValue, probeKey, sealKey, sealWebhookSecret } from '../_lib/kieKeys.js'
import { ACTIVE_STATES } from '../_lib/kieStatus.js'
import { callbackUrlFor } from '../kie-callback.js'

const COLUMNS = `id, source, label, key_enc, webhook_enc, key_hint, enabled, last_used_at, uses, cooldown_until,
                 problem, problem_at, balance, balance_at, created_at`

/** KIE keys are plain visible characters; anything with a space or a control character was pasted wrong. */
const VISIBLE = /^[\x21-\x7e]+$/

function readSecret(value, field, { min, max = 256 }) {
  const text = typeof value === 'string' ? value.trim() : ''
  if (!text) throw badRequest(`${field} is required.`)
  if (!VISIBLE.test(text)) throw badRequest(`${field} must be letters, numbers and symbols only, with no spaces.`)
  if (text.length < min || text.length > max) throw badRequest(`${field} must be ${min} to ${max} characters.`)
  return text
}

function readId(value) {
  if (!isUuid(value)) throw badRequest('That is not a key id.')
  return value.toLowerCase()
}

/**
 * A row as the panel sees it. `state` is what to show:
 *   missing     the server's own key, but KIE_API_KEY is not set
 *   paused      switched off here
 *   unreadable  sealed under a KEY_VAULT_SECRET that is no longer the one in use
 *   cooling     KIE refused it a moment ago; it waits at the back of the line (`problem` says why)
 *   active      in the rotation
 */
function shape(row, { running = 0, now = Date.now() } = {}) {
  const own = row.source === 'env'
  const ownKey = envKeyValue()
  let readable = true
  if (!own) {
    try { unseal(row.key_enc, `kie-key:${row.id}`) } catch (e) { if (!(e instanceof VaultError)) throw e; readable = false }
  }
  const cooling = row.cooldown_until && new Date(row.cooldown_until).getTime() > now
  const state = own && !ownKey ? 'missing'
    : !row.enabled ? 'paused'
      : !readable ? 'unreadable'
        : cooling ? 'cooling'
          : 'active'
  return {
    id: row.id,
    source: row.source,
    label: row.label,
    hint: own ? (ownKey ? hintOf(ownKey) : null) : row.key_hint,
    enabled: row.enabled,
    state,
    problem: row.problem,
    problemAt: row.problem_at,
    cooldownUntil: cooling ? row.cooldown_until : null,
    uses: Number(row.uses),
    lastUsedAt: row.last_used_at,
    balance: row.balance === null ? null : Number(row.balance),
    balanceAt: row.balance_at,
    // Whether a task started with this key asks KIE for a callback (otherwise the worker collects it).
    callbacks: callbackUrlFor({ source: row.source, webhookSecret: row.webhook_enc ? 'stored' : null }) !== null,
    running,
    createdAt: row.created_at,
  }
}

/** Jobs still running, by the key that started them (a job with no key recorded belongs to the server's own). */
async function runningByKey() {
  const rows = await many(
    `select coalesce(t.kie_key_id, (select id from kie_api_keys where source = 'env')) as key_id, count(*)::int as n
       from generation_jobs j left join task_owners t on t.kie_task_id = j.kie_task_id
      where j.state = any($1::text[])
      group by 1`,
    [ACTIVE_STATES],
  )
  return new Map(rows.map(r => [r.key_id, r.n]))
}

export const list = adminRoute(async (_req, res) => {
  const [rows, running] = await Promise.all([
    many(`select ${COLUMNS} from kie_api_keys order by (source = 'env') desc, created_at, id`),
    runningByKey(),
  ])
  const now = Date.now()
  noStore(res)
  res.json({
    keys: rows.map(row => shape(row, { running: running.get(row.id) ?? 0, now })),
    // Without this secret a key cannot be stored (or opened): the page says so instead of failing on the first try.
    vault: { configured: vaultConfigured() },
  })
}, { tag: '[admin/kie-keys]', message: 'Unable to load the keys.' })

export const add = adminRoute(async (req, res, admin) => {
  // A request that is wrong is the caller's to fix whatever the server's setup, so it is read first.
  const label = requiredText(req.body?.label, 'The name', 60)
  const apiKey = readSecret(req.body?.key, 'The key', { min: 16 })
  const hasWebhook = req.body?.webhookSecret !== undefined && req.body?.webhookSecret !== null && req.body?.webhookSecret !== ''
  const webhookSecret = hasWebhook ? readSecret(req.body.webhookSecret, 'The webhook key', { min: 8 }) : null
  const verify = req.body?.verify !== false
  if (!vaultConfigured()) {
    throw new HttpError(503, 'Keys cannot be stored yet: set KEY_VAULT_SECRET (32 or more random characters) in the server\'s .env, then restart the api and worker.', 'VAULT_NOT_CONFIGURED')
  }

  const fingerprint = fingerprintOf(apiKey)
  if (envKeyValue() && fingerprintOf(envKeyValue()) === fingerprint) {
    throw new HttpError(409, 'This is the server\'s own key (KIE_API_KEY). It is already in the list.', 'DUPLICATE_KEY')
  }
  const same = await one('select label from kie_api_keys where fingerprint = $1', [fingerprint])
  if (same) throw new HttpError(409, `This key is already in the list as "${same.label}".`, 'DUPLICATE_KEY')

  // Asked of KIE before the key is kept, so a mistyped one is caught here and not by the first person to generate.
  let balance = null
  if (verify) {
    const probe = await probeKey(apiKey)
    if (probe.result === 'rejected') throw new HttpError(422, 'KIE does not accept this key. Check that it was copied whole.', 'KEY_REJECTED')
    if (probe.result !== 'ok') throw new HttpError(502, 'KIE could not be reached to check this key. Try again, or add it without checking.', 'KIE_UNREACHABLE')
    balance = probe.balance
  }

  const id = randomUUID()
  let row
  try {
    row = await transaction(async client => {
      const { rows } = await client.query(
        `insert into kie_api_keys (id, source, label, key_enc, webhook_enc, key_hint, fingerprint, balance, balance_at)
         values ($1, 'panel', $2, $3, $4, $5, $6, $7::numeric, case when $7::numeric is null then null else now() end)
         returning ${COLUMNS}`,
        [id, label, sealKey(id, apiKey), webhookSecret ? sealWebhookSecret(id, webhookSecret) : null, hintOf(apiKey), fingerprint, balance],
      )
      await audit(admin, 'kie-key.add', { targetType: 'kie-key', targetId: id, details: { label, hint: hintOf(apiKey), checked: verify, webhookKey: Boolean(webhookSecret) } }, client)
      return rows[0]
    })
  } catch (e) {
    // Two people adding the same key at the same moment: the second finds the first's row.
    if (e?.code === '23505') throw new HttpError(409, 'This key is already in the list.', 'DUPLICATE_KEY')
    throw e
  }
  noStore(res)
  res.json({ key: shape(row) })
}, { tag: '[admin/kie-keys/add]', message: 'Unable to add this key.' })

export const update = adminRoute(async (req, res, admin) => {
  const id = readId(req.body?.id)
  const body = req.body || {}
  const changes = {}
  if ('enabled' in body) {
    if (typeof body.enabled !== 'boolean') throw badRequest('enabled must be true or false.')
    changes.enabled = body.enabled
  }
  if ('label' in body) changes.label = requiredText(body.label, 'The name', 60)
  if ('webhookSecret' in body) {
    changes.webhookSecret = body.webhookSecret === null || body.webhookSecret === ''
      ? null
      : readSecret(body.webhookSecret, 'The webhook key', { min: 8 })
  }
  if (!Object.keys(changes).length) throw badRequest('There is nothing to change.')

  const row = await transaction(async client => {
    const { rows: [current] } = await client.query('select source from kie_api_keys where id = $1 for update', [id])
    if (!current) throw notFound('That key does not exist.')
    if ('webhookSecret' in changes && current.source === 'env') {
      throw badRequest('The server\'s own key uses KIE_WEBHOOK_SECRET from the server\'s .env.')
    }
    if ('webhookSecret' in changes && changes.webhookSecret !== null && !vaultConfigured()) {
      throw new HttpError(503, 'Keys cannot be stored yet: set KEY_VAULT_SECRET in the server\'s .env first.', 'VAULT_NOT_CONFIGURED')
    }
    const { rows } = await client.query(
      `update kie_api_keys
          set enabled = coalesce($2::boolean, enabled),
              label = coalesce($3::text, label),
              webhook_enc = case when $4::boolean then $5::text else webhook_enc end,
              updated_at = now()
        where id = $1
        returning ${COLUMNS}`,
      [id, changes.enabled ?? null, changes.label ?? null, 'webhookSecret' in changes,
        changes.webhookSecret ? sealWebhookSecret(id, changes.webhookSecret) : null],
    )
    await audit(admin, 'kie-key.update', {
      targetType: 'kie-key', targetId: id,
      details: {
        label: rows[0].label,
        ...('enabled' in changes ? { enabled: changes.enabled } : {}),
        ...('label' in changes ? { renamed: true } : {}),
        ...('webhookSecret' in changes ? { webhookKey: changes.webhookSecret === null ? 'removed' : 'set' } : {}),
      },
    }, client)
    return rows[0]
  })
  noStore(res)
  res.json({ key: shape(row) })
}, { tag: '[admin/kie-keys/update]', message: 'Unable to change this key.' })

/** Ask KIE what is left on a key, and put what it says on the record. */
export const check = adminRoute(async (req, res, admin) => {
  const id = readId(req.body?.id)
  const row = await one(`select ${COLUMNS} from kie_api_keys where id = $1`, [id])
  if (!row) throw notFound('That key does not exist.')

  let secret
  if (row.source === 'env') {
    secret = envKeyValue()
    if (!secret) throw badRequest('KIE_API_KEY is not set on the server.')
  } else {
    try {
      secret = unseal(row.key_enc, `kie-key:${row.id}`)
    } catch (e) {
      if (!(e instanceof VaultError)) throw e
      throw new HttpError(409, 'This key cannot be opened: KEY_VAULT_SECRET is not the one it was added under. Remove it and add it again.', 'KEY_UNREADABLE')
    }
  }

  const probe = await probeKey(secret)
  if (probe.result !== 'ok' && probe.result !== 'rejected') {
    throw new HttpError(502, 'KIE could not be reached to check this key. Please try again.', 'KIE_UNREACHABLE')
  }

  const fresh = await transaction(async client => {
    if (probe.result === 'rejected') {
      await client.query(
        `update kie_api_keys
            set problem = 'rejected', problem_at = now(), cooldown_until = now() + $2::int * interval '1 millisecond'
          where id = $1`,
        [id, COOLDOWN_MS.rejected],
      )
    } else {
      // A person has just seen it work: whatever KIE refused earlier no longer applies.
      await client.query(
        `update kie_api_keys
            set balance = coalesce($2::numeric, balance), balance_at = case when $2::numeric is null then balance_at else now() end,
                problem = null, problem_at = null, cooldown_until = null
          where id = $1`,
        [id, probe.balance],
      )
    }
    await audit(admin, 'kie-key.check', { targetType: 'kie-key', targetId: id, details: { label: row.label, result: probe.result } }, client)
    const { rows } = await client.query(`select ${COLUMNS} from kie_api_keys where id = $1`, [id])
    return rows[0]
  })
  noStore(res)
  res.json({ key: shape(fresh), result: probe.result })
}, { tag: '[admin/kie-keys/check]', message: 'Unable to check this key.' })

export const remove = adminRoute(async (req, res, admin) => {
  const id = readId(req.body?.id)
  await transaction(async client => {
    const { rows: [row] } = await client.query('select source, label from kie_api_keys where id = $1 for update', [id])
    if (!row) throw notFound('That key does not exist.')
    if (row.source === 'env') {
      throw badRequest('The server\'s own key comes from KIE_API_KEY and cannot be removed here. Pause it instead, or remove it from the server\'s .env.')
    }
    // A task can only be followed with the key that started it. Removing the key under a running job would
    // leave that job unanswerable (and its result uncollected); pausing the key keeps it working until they finish.
    const { rows: [busy] } = await client.query(
      `select count(*)::int as n from task_owners t join generation_jobs j on j.kie_task_id = t.kie_task_id
        where t.kie_key_id = $1 and j.state = any($2::text[])`,
      [id, ACTIVE_STATES],
    )
    if (busy.n) {
      throw new HttpError(409, `${busy.n} generation${busy.n === 1 ? ' is' : 's are'} still running with this key. Pause it, and remove it once they have finished.`, 'KEY_IN_USE')
    }
    await client.query('delete from kie_api_keys where id = $1', [id])
    await audit(admin, 'kie-key.delete', { targetType: 'kie-key', targetId: id, details: { label: row.label } }, client)
  })
  res.json({ ok: true })
}, { tag: '[admin/kie-keys/delete]', message: 'Unable to remove this key.' })
