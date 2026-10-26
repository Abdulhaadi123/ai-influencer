// db/reprice.js — the costing document applied to the price list: what it changes, what it must not touch,
// that it can be run twice, and that the gate in front of KIE then charges exactly what it wrote.

import test, { before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { startStack } from '../helpers/stack.js'

const BACKEND = fileURLToPath(new URL('../../', import.meta.url))

let stack
let reprice, plan, describe, main, parseArgs, shareFromPercent, RepriceError
let markup

before(async () => {
  stack = await startStack({})
  ;({ reprice, plan, describe, main, parseArgs, shareFromPercent, RepriceError } = await stack.load('db/reprice.js'))
  markup = await stack.load('api/_lib/markup.js')
})
after(async () => { delete process.env.BILLING_ENFORCED; await stack?.stop() })
beforeEach(async () => {
  delete process.env.BILLING_ENFORCED
  await stack.reset()
  await stack.sql('delete from model_prices')
})

/** The five prices production has today: KIE's own numbers, 1:1. */
const TODAY = [
  ['nano-banana-pro', 'per_image', 18],
  ['kling-3.0/video', 'per_second', 20],
  ['kling-3.0/motion-control:720p', 'per_second', 20],
  ['kling-3.0/motion-control:1080p', 'per_second', 27],
  ['kling-3.0/motion-control', 'per_second', 27],
]
const NEW = { 'nano-banana-pro': 46, 'kling-3.0/video': 52, 'kling-3.0/motion-control:720p': 52, 'kling-3.0/motion-control:1080p': 69, 'kling-3.0/motion-control': 69 }

async function seedToday(rows = TODAY) {
  for (const [model, unit, credits] of rows) {
    await stack.sql('insert into model_prices (model, unit, credits) values ($1, $2, $3)', [model, unit, credits])
  }
}
const prices = async () => Object.fromEntries((await stack.sql('select model, credits::float8 as credits from model_prices order by model')).map(r => [r.model, r.credits]))
const auditRows = () => stack.sql(`select admin_id, admin_email, action, target_type, target_id, details from admin_audit_log where action = 'price.console-reprice' order by id`)

// ── The preview ──────────────────────────────────────────────────────────────

test('a preview says what would change and changes nothing — not a price, not the audit log', async () => {
  await seedToday()
  const before = await prices()
  const result = await reprice({})
  assert.equal(result.applied, false)
  assert.deepEqual(Object.fromEntries(result.changes.map(c => [c.model, c.to])), NEW)
  assert.deepEqual(Object.fromEntries(result.changes.map(c => [c.model, c.from])), Object.fromEntries(TODAY.map(([m, , c]) => [m, c])))
  assert.deepEqual(await prices(), before)
  assert.deepEqual(await auditRows(), [])
})

test('every price in the preview loses money now and earns the target after', async () => {
  await seedToday()
  const { changes } = await reprice({})
  for (const c of changes) {
    assert.ok(c.marginNow < -0.75, `${c.model} now ${c.marginNow}`)
    assert.ok(c.marginNew >= 0.3 && c.marginNew < 0.32, `${c.model} new ${c.marginNew}`)
  }
})

// ── Applying it ──────────────────────────────────────────────────────────────

test('applied: the five prices become the document\'s, nothing else in the row changes, and the app sees them', async () => {
  await seedToday()
  await stack.sql(`update model_prices set label = 'Nano Banana Pro', note = 'checked 22 Oct', enabled = false where model = 'nano-banana-pro'`)
  const result = await reprice({ apply: true })
  assert.equal(result.applied, true)
  assert.deepEqual(await prices(), NEW)

  const row = await stack.one(`select label, note, enabled, unit from model_prices where model = 'nano-banana-pro'`)
  assert.deepEqual({ ...row }, { label: 'Nano Banana Pro', note: 'checked 22 Oct', enabled: false, unit: 'per_image' }, 'a switched-off model stays off, and its words stay')

  // The app asks the server what each thing costs; an enabled model is listed with the new number
  // (the image model was switched off above, so the app is not told about it at all).
  const u = await stack.createUser()
  const seen = (await stack.api('GET', '/api/billing/me', { token: u.token })).body.prices
  const enabled = Object.fromEntries(Object.entries(NEW).filter(([model]) => model !== 'nano-banana-pro'))
  assert.deepEqual(Object.fromEntries(seen.map(p => [p.model, p.credits])), enabled)
})

test('applied: one audit entry as the server console, with every old and new price, and nobody is named as the editor', async () => {
  await seedToday()
  const admin = await stack.createUser({ role: 'admin', scope: 'admin' })
  await stack.sql(`update model_prices set updated_by = $1`, [admin.id])
  await reprice({ apply: true })

  const log = await auditRows()
  assert.equal(log.length, 1)
  assert.equal(log[0].admin_id, null)
  assert.equal(log[0].admin_email, 'the server console')
  assert.equal(log[0].details.margin, 0.3)
  assert.equal(log[0].details.commission, 0.2)
  assert.deepEqual(log[0].details.prices['nano-banana-pro'], { kieCredits: 18, from: 18, to: 46 })
  assert.deepEqual(log[0].details.prices['kling-3.0/motion-control:1080p'], { kieCredits: 27, from: 27, to: 69 })
  assert.equal(Object.keys(log[0].details.prices).length, 5)

  const editors = await stack.sql('select updated_by from model_prices')
  assert.ok(editors.every(r => r.updated_by === null), 'the panel does not credit the last administrator with this')
})

test('running it again changes nothing — a price is never marked up twice — and writes no second audit entry', async () => {
  await seedToday()
  await reprice({ apply: true })
  const once = await prices()
  const again = await reprice({ apply: true })
  assert.deepEqual(again.changes, [])
  assert.equal(again.same.length, 5)
  assert.deepEqual(await prices(), once)
  assert.equal((await auditRows()).length, 1)
  for (let i = 0; i < 3; i++) await reprice({ apply: true })
  assert.deepEqual(await prices(), NEW)
})

test('it works from KIE\'s price, not from the price a row holds: any starting number ends at the same place', async () => {
  await seedToday([['nano-banana-pro', 'per_image', 1], ['kling-3.0/video', 'per_second', 99999], ['kling-3.0/motion-control', 'per_second', 0]])
  await reprice({ apply: true })
  assert.deepEqual(await prices(), { 'nano-banana-pro': 46, 'kling-3.0/video': 52, 'kling-3.0/motion-control': 69 })
})

test('another margin or commission moves every price the same way, and each still earns its target', async () => {
  for (const [margin, commission] of [[0.4, 0.2], [0.2, 0.15], [0.5, 0.3], [0, 0.2], [0.3, 0]]) {
    await stack.sql('delete from model_prices')
    await seedToday()
    const { changes } = await reprice({ apply: true, margin, commission })
    const now = await prices()
    for (const [model, unit, kie] of TODAY) {
      assert.equal(now[model], markup.userCredits(kie, { margin, commission }), `${model} at ${margin}/${commission}`)
      assert.ok(markup.marginOf(kie, now[model], { commission }) >= margin - 1e-9)
    }
    assert.ok(changes.length > 0)
  }
})

// ── What it leaves alone ─────────────────────────────────────────────────────

test('a row it has no cost for is left exactly as it is, and named', async () => {
  await seedToday()
  await stack.sql(`insert into model_prices (model, unit, credits, enabled) values ('some-new/model-nobody-listed', 'per_second', 20, true), ('free-model', 'per_video', 0, true)`)
  const result = await reprice({ apply: true })
  const now = await prices()
  assert.equal(now['some-new/model-nobody-listed'], 20)
  assert.equal(now['free-model'], 0)
  assert.deepEqual(result.others.map(o => o.model).sort(), ['free-model', 'some-new/model-nobody-listed'])
  assert.match(describe(result).join('\n'), /some-new\/model-nobody-listed \(20\)/)
})

test('a row whose unit is not KIE\'s is left alone and said so — a per-video price must not be read as per-second', async () => {
  await seedToday([['nano-banana-pro', 'per_video', 18], ['kling-3.0/video', 'per_second', 20]])
  const result = await reprice({ apply: true })
  assert.equal((await prices())['nano-banana-pro'], 18)
  assert.equal((await prices())['kling-3.0/video'], 52)
  assert.equal(result.skipped.length, 1)
  assert.equal(result.skipped[0].model, 'nano-banana-pro')
  assert.match(result.skipped[0].reason, /per_video.*per_image/)
})

test('a model with no row is named, not created: it stays unavailable until someone adds a price', async () => {
  await seedToday([['nano-banana-pro', 'per_image', 18]])
  const result = await reprice({ apply: true })
  assert.deepEqual(result.missing.sort(), markup.KIE_COST.map(c => c.model).filter(m => m !== 'nano-banana-pro').sort())
  assert.ok(result.missing.includes('kling-3.0/video') && result.missing.includes('veo3_fast'))
  assert.equal((await stack.sql('select 1 from model_prices')).length, 1)
  assert.match(describe(result).join('\n'), /No price row/)
})

test('an empty price list changes nothing and says so', async () => {
  const result = await reprice({ apply: true })
  assert.deepEqual(result.changes, [])
  assert.equal(result.missing.length, markup.KIE_COST.length)
  assert.deepEqual(await auditRows(), [])
})

test('two runs at once end in one consistent state with one audit entry', async () => {
  await seedToday()
  await Promise.all([reprice({ apply: true }), reprice({ apply: true }), reprice({ apply: true })])
  assert.deepEqual(await prices(), NEW)
  assert.equal((await auditRows()).length, 1)
})

test('a price an administrator set by hand to a listed model is replaced — the preview shows it first', async () => {
  await seedToday()
  await stack.sql(`update model_prices set credits = 75 where model = 'nano-banana-pro'`)
  const preview = await reprice({})
  const change = preview.changes.find(c => c.model === 'nano-banana-pro')
  assert.equal(change.from, 75)
  assert.equal(change.to, 46)
  assert.match(describe(preview).join('\n'), /nano-banana-pro\s+per_image\s+18\s+75\s+46/)
})

// ── The whole list, as production has it ─────────────────────────────────────

/** Worked out by hand from KIE's numbers (× 2.551, rounded up) — not by the code under test. */
const ALL_AT_DEFAULTS = {
  'nano-banana-pro': 46,
  'kling-3.0/video': 52, 'kling-3.0/motion-control:720p': 52, 'kling-3.0/motion-control:1080p': 69, 'kling-3.0/motion-control': 69,
  'kling/v3-turbo-image-to-video': 58, 'kling/v2-5-turbo-image-to-video-pro': 22, 'kling/v2-1-master-image-to-video': 82,
  'kling-2.6/motion-control:720p': 29, 'kling-2.6/motion-control:1080p': 46, 'kling-2.6/motion-control': 46,
  'wan/2-6-image-to-video': 54, 'wan/2-5-image-to-video': 52, 'wan/2-2-animate-move': 32,
  'hailuo/2-3-image-to-video-pro': 35, 'minimax-h3/image-to-video': 21, 'minimax-h3/text-to-video': 34,
  'pixverse-v6/image-to-video': 47, 'bytedance/seedance-2-mini': 21, 'bytedance/seedance-2-fast': 64, 'grok-imagine/image-to-video': 21,
  veo3_fast: 166, 'veo-3-1': 166,
}
/** Seedance 2.5 had no row on the live server: 158 a second × 2.551, rounded up. */
const SEEDANCE_25 = 'bytedance/seedance-2-5'

/** The 23 rows the live server listed in its preview, each at KIE's own number — the prices today. */
const seedProduction = () => seedToday(markup.KIE_COST.filter(c => c.model !== SEEDANCE_25).map(c => [c.model, c.unit, c.kieCredits]))

test('the live list: all 23 models are repriced in one go, to the credit, and a second run finds nothing to do', async () => {
  await seedProduction()
  assert.equal((await stack.sql('select 1 from model_prices')).length, 23)

  const preview = await reprice({})
  assert.equal(preview.changes.length, 23)
  assert.deepEqual([preview.same, preview.skipped, preview.others, preview.additions], [[], [], [], []])
  assert.deepEqual(preview.missing, [SEEDANCE_25], 'Seedance 2.5 is named, not created')
  assert.deepEqual((await prices())['veo3_fast'], 65, 'a preview changes nothing')

  const done = await reprice({ apply: true })
  assert.equal(done.changes.length, 23)
  assert.deepEqual(await prices(), ALL_AT_DEFAULTS)

  const log = await auditRows()
  assert.equal(log.length, 1)
  assert.equal(Object.keys(log[0].details.prices).length, 23)
  assert.deepEqual(log[0].details.prices.veo3_fast, { kieCredits: 65, from: 65, to: 166 })

  const again = await reprice({ apply: true })
  assert.deepEqual(again.changes, [])
  assert.equal(again.same.length, 23)
  assert.deepEqual(await prices(), ALL_AT_DEFAULTS)
})

test('the live list: not one model is left charging less than it costs', async () => {
  await seedProduction()
  await reprice({ apply: true })
  const now = await prices()
  for (const c of markup.KIE_COST.filter(x => x.model !== SEEDANCE_25)) {
    assert.ok(markup.marginOf(c.kieCredits, now[c.model]) >= 0.3, `${c.model} earns ${markup.marginOf(c.kieCredits, now[c.model])}`)
  }
  assert.ok(!(SEEDANCE_25 in now), 'and nothing was put on sale that nobody asked for')
})

test('the live list, charged through the gate: a Veo video 166, 8 s of Seedance Mini 168, 5 s of Wan 2.5 260, 10 s of Kling 2.1 Master 820', async () => {
  await seedProduction()
  await reprice({ apply: true })
  const u = await stack.createUser()
  await give(u.id, 5000)
  enforce()

  const charge = async (model, input) => {
    const before = await balance(u)
    const res = await createTask(u.token, model, input)
    assert.equal(res.status, 200, `${model}: ${JSON.stringify(res.body)}`)
    return before - await balance(u)
  }
  assert.equal(await charge('veo3_fast', { prompt: 'a friendly person in a park', generation_type: 'REFERENCE_2_VIDEO', duration: 8 }), 166, 'per video: no seconds multiplied in')
  assert.equal(await charge('bytedance/seedance-2-mini', { prompt: 'a friendly person in a park', duration: 8 }), 168)
  assert.equal(await charge('wan/2-5-image-to-video', { prompt: 'a friendly person in a park', duration: '5' }), 260)
  assert.equal(await charge('kling/v2-1-master-image-to-video', { prompt: 'a friendly person in a park', duration: 10 }), 820)
})

// ── Putting a model with no row on sale: --add ───────────────────────────────

test('--add in a preview shows the row that would be created and creates nothing', async () => {
  await seedProduction()
  const preview = await reprice({ add: true })
  assert.deepEqual(preview.additions.map(a => [a.model, a.unit, a.kieCredits, a.from, a.to]), [[SEEDANCE_25, 'per_second', 158, null, 404]])
  assert.ok(preview.additions[0].marginNew >= 0.3)
  assert.equal((await stack.sql('select 1 from model_prices')).length, 23, 'nothing was inserted')
  const text = describe(preview).join('\n')
  assert.match(text, /bytedance\/seedance-2-5\s+per_second\s+158\s+-\s+404\s+-\s+→ 30%\s+\(no row yet: will be added, switched on\)/)
  assert.ok(!/No price row/.test(text), 'it is planned, so it is not also reported as unavailable')
})

test('--add --apply creates the row, switched on, at 404 a second, reprices the rest, and writes one audit entry that says so', async () => {
  await seedProduction()
  const done = await reprice({ add: true, apply: true })
  assert.equal(done.changes.length, 23)
  assert.deepEqual(done.added.map(a => a.model), [SEEDANCE_25])

  const row = await stack.one(`select model, unit, credits::float8 as credits, enabled, updated_by from model_prices where model = $1`, [SEEDANCE_25])
  assert.deepEqual({ ...row }, { model: SEEDANCE_25, unit: 'per_second', credits: 404, enabled: true, updated_by: null })
  assert.deepEqual(await prices(), { ...ALL_AT_DEFAULTS, [SEEDANCE_25]: 404 })

  const log = await auditRows()
  assert.equal(log.length, 1)
  assert.deepEqual(log[0].details.added, { [SEEDANCE_25]: { kieCredits: 158, to: 404 } })
  assert.equal(Object.keys(log[0].details.prices).length, 23)

  const again = await reprice({ add: true, apply: true })
  assert.deepEqual([again.changes, again.added, again.additions], [[], [], []])
  assert.equal(again.same.length, 24)
  assert.equal((await auditRows()).length, 1, 'a second run writes nothing')
})

test('--add on its own, with the rest already priced, only creates the missing row', async () => {
  await seedProduction()
  await reprice({ apply: true })
  const before = await prices()
  const done = await reprice({ add: true, apply: true })
  assert.deepEqual(done.changes, [])
  assert.deepEqual(done.added.map(a => a.model), [SEEDANCE_25])
  assert.deepEqual(await prices(), { ...before, [SEEDANCE_25]: 404 })
})

test('--add never touches a model that has a row: a switched-off one stays off, a hand-set price is only replaced as before', async () => {
  await seedProduction()
  await stack.sql(`insert into model_prices (model, unit, credits, enabled) values ($1, 'per_second', 999, false)`, [SEEDANCE_25])
  const done = await reprice({ add: true, apply: true })
  assert.deepEqual([done.additions, done.added], [[], []])
  const row = await stack.one(`select credits::float8 as credits, enabled from model_prices where model = $1`, [SEEDANCE_25])
  assert.deepEqual({ ...row }, { credits: 404, enabled: false }, 'repriced like any listed row, and still off')
})

test('--add with a row of another unit for the model is left alone and named, not duplicated', async () => {
  await seedProduction()
  await stack.sql(`insert into model_prices (model, unit, credits) values ($1, 'per_video', 77)`, [SEEDANCE_25])
  const done = await reprice({ add: true, apply: true })
  assert.deepEqual(done.added, [])
  assert.equal(done.skipped.length, 1)
  assert.equal((await prices())[SEEDANCE_25], 77)
})

test('three --add runs at once leave one Seedance 2.5 row and one audit entry', async () => {
  await seedProduction()
  await Promise.all([1, 2, 3].map(() => reprice({ add: true, apply: true })))
  assert.equal((await stack.sql(`select 1 from model_prices where model = $1`, [SEEDANCE_25])).length, 1)
  assert.equal((await auditRows()).length, 1)
  assert.deepEqual(await prices(), { ...ALL_AT_DEFAULTS, [SEEDANCE_25]: 404 })
})


test('after --add, Seedance 2.5 is charged 404 a second: 4 s is 1,616, and 15 s (6,060) is refused with the real price', async () => {
  await seedProduction()
  await reprice({ add: true, apply: true })
  const u = await stack.createUser()
  await give(u.id, 5000)
  enforce()

  const four = await createTask(u.token, SEEDANCE_25, { prompt: 'a friendly person in a park', duration: 4 })
  assert.equal(four.status, 200)
  assert.equal(await balance(u), 5000 - 1616)

  const fifteen = await createTask(u.token, SEEDANCE_25, { prompt: 'a friendly person in a park', duration: 15 })
  assert.equal(fifteen.status, 402)
  assert.equal(fifteen.body.code, 'INSUFFICIENT_CREDITS')
  assert.equal(fifteen.body.price, 6060)
  assert.equal(fifteen.body.balance, 3384)
})

test('without --add Seedance 2.5 stays refused for want of a price, and nothing is charged', async () => {
  await seedProduction()
  await reprice({ apply: true })
  const u = await stack.createUser()
  await give(u.id, 5000)
  enforce()
  const res = await createTask(u.token, SEEDANCE_25, { prompt: 'a friendly person in a park', duration: 4 })
  assert.equal(res.status, 403)
  assert.equal(res.body.code, 'MODEL_UNAVAILABLE')
  assert.equal(await balance(u), 5000)
})

// ── The gate charges what was written ────────────────────────────────────────

const enforce = () => { process.env.BILLING_ENFORCED = 'true' }
const give = (userId, credits) => stack.sql(`insert into credit_ledger (user_id, kind, delta, ref) values ($1, 'grant', $2, $3)`, [userId, credits, `test-grant-${Math.random()}`])
const ledger = userId => stack.sql(`select kind, delta::float8 as delta, model from credit_ledger where user_id = $1 order by id`, [userId])
const balance = async user => (await stack.api('GET', '/api/billing/me', { token: user.token })).body.balance
const createTask = (token, model, input) => stack.api('POST', '/api/kie/api/v1/jobs/createTask', { token, body: { model, input } })
const sentToKie = () => stack.kie.requests.filter(r => r.path === '/api/v1/jobs/createTask')

test('after repricing, an image costs 46: taken first, refused with the real shortfall, and given back when it fails', async () => {
  await seedToday()
  await reprice({ apply: true })
  const u = await stack.createUser()
  await give(u.id, 100)
  enforce()

  const first = await createTask(u.token, 'nano-banana-pro', { prompt: 'a friendly person in a park' })
  assert.equal(first.status, 200)
  assert.equal(await balance(u), 54)
  const second = await createTask(u.token, 'nano-banana-pro', { prompt: 'a friendly person in a park' })
  assert.equal(second.status, 200)
  assert.equal(await balance(u), 8)

  const third = await createTask(u.token, 'nano-banana-pro', { prompt: 'a friendly person in a park' })
  assert.equal(third.status, 402)
  assert.equal(third.body.code, 'INSUFFICIENT_CREDITS')
  assert.equal(third.body.price, 46)
  assert.equal(third.body.balance, 8)
  assert.equal(sentToKie().length, 2, 'KIE was not asked the third time')

  // A job that fails gives back 46, once.
  const taskId = first.body.data.taskId
  await stack.api('POST', '/api/jobs/register', { token: u.token, body: { entries: [{ taskId, kind: 'image', label: 'Image', model: 'nano-banana-pro' }] } })
  stack.kie.tasks.set(taskId, { taskId, state: 'fail', failMsg: 'Internal Error', failCode: '500', creditsConsumed: 0 })
  await stack.api('GET', `/api/jobs/sync?taskId=${taskId}`, { token: u.token })
  await stack.api('GET', `/api/jobs/sync?taskId=${taskId}`, { token: u.token })
  assert.equal(await balance(u), 54)
  assert.deepEqual((await ledger(u.id)).map(r => [r.kind, r.delta]), [['grant', 100], ['spend', -46], ['spend', -46], ['refund', 46]])
})

test('after repricing, a 5-second Kling video costs 260 (5 × 52) and a 10-second one 520', async () => {
  await seedToday()
  await reprice({ apply: true })
  const u = await stack.createUser()
  await give(u.id, 1000)
  enforce()

  assert.equal((await createTask(u.token, 'kling-3.0/video', { prompt: 'walking in a park', duration: '5' })).status, 200)
  assert.equal(await balance(u), 740)
  assert.equal((await createTask(u.token, 'kling-3.0/video', { prompt: 'walking in a park', duration: 10 })).status, 200)
  assert.equal(await balance(u), 220)
  const short = await createTask(u.token, 'kling-3.0/video', { prompt: 'walking in a park', duration: '5' })
  assert.equal(short.status, 402, '220 is not enough for 260')
  assert.equal(short.body.price, 260)
})

test('what the five prices earn at the worst pack: a profit on every one, and the 20,000 pack\'s credit buys what it should', async () => {
  await seedToday()
  await reprice({ apply: true })
  const now = await prices()
  for (const [model, , kie] of TODAY) {
    const revenue = now[model] * (70 / 20000) * 0.8
    const cost = kie * 0.005
    assert.ok(revenue > cost * 1.4, `${model}: revenue $${revenue.toFixed(4)} on a cost of $${cost.toFixed(4)}`)
  }
})

// ── The command ──────────────────────────────────────────────────────────────

function run(argv) {
  const out = []
  const err = []
  return main({ argv, out: l => out.push(l), err: l => err.push(l) }).then(code => ({ code, out: out.join('\n'), err: err.join('\n') }))
}

test('the command: with no flags it only previews, in a table, and says it changed nothing', async () => {
  await seedToday()
  const r = await run([])
  assert.equal(r.code, 0)
  assert.match(r.out, /Profit margin 30%, store commission 20%/)
  assert.match(r.out, /nano-banana-pro\s+per_image\s+18\s+18\s+46\s+-79% → 30%/)
  assert.match(r.out, /kling-3\.0\/video\s+per_second\s+20\s+20\s+52\s+-79% → 31%/)
  assert.match(r.out, /5,000-credit pack then buys about 108 images \(277 before\)/)
  assert.match(r.out, /only a preview — nothing was changed/)
  assert.deepEqual(await prices(), Object.fromEntries(TODAY.map(([m, , c]) => [m, c])))
})

test('the command: --apply writes, says so, and the second time says there is nothing to do', async () => {
  await seedToday()
  const done = await run(['--apply'])
  assert.equal(done.code, 0)
  assert.match(done.out, /Done: 5 prices changed, live now/)
  assert.deepEqual(await prices(), NEW)
  const again = await run(['--apply'])
  assert.equal(again.code, 0)
  assert.match(again.out, /Nothing to change/)
  assert.match(again.out, /already this price/)
})

test('the command: --margin and --commission, in either spelling', async () => {
  await seedToday()
  const a = await run(['--margin', '40', '--commission', '15'])
  assert.match(a.out, /Profit margin 40%, store commission 15%/)
  const b = await run(['--margin=40%', '--commission=15'])
  assert.match(b.out, /Profit margin 40%, store commission 15%/)
  assert.equal(a.out, b.out)
})

test('the command: a typo is refused in words, never taken as the default, and nothing is changed', async () => {
  await seedToday()
  const before = await prices()
  for (const argv of [['--aply'], ['apply'], ['--margin'], ['--margin', '--apply'], ['--margin', 'abc'], ['--margin', '95'], ['--margin', '-5'], ['--commission', '70'], ['--commission='], ['--margin', '30', '--wat']]) {
    const r = await run(argv)
    assert.equal(r.code, 1, argv.join(' '))
    assert.ok(r.err.length > 0 && r.out === '', argv.join(' '))
  }
  assert.deepEqual(await prices(), before)
  assert.match((await run(['--aply'])).err, /do not know "--aply"/)
  assert.match((await run(['--margin', '95'])).err, /margin must be a percentage from 0 to 90/)
})

test('the command: --add previews the row it would create, then --add --apply says the model was put on sale', async () => {
  await seedProduction()
  const preview = await run(['--add'])
  assert.equal(preview.code, 0)
  assert.match(preview.out, /bytedance\/seedance-2-5\s+per_second\s+158\s+-\s+404/)
  assert.match(preview.out, /only a preview — nothing was changed/)
  assert.equal((await stack.sql(`select 1 from model_prices where model = $1`, [SEEDANCE_25])).length, 0)

  const done = await run(['--add', '--apply'])
  assert.equal(done.code, 0)
  assert.match(done.out, /Done: 23 prices changed and 1 model put on sale, live now/)
  assert.equal((await prices())[SEEDANCE_25], 404)

  const again = await run(['--add', '--apply'])
  assert.match(again.out, /Nothing to change/)
})

test('the command: without --add a model with no row is named, with the way to put it on sale', async () => {
  await seedProduction()
  const r = await run([])
  assert.match(r.out, /No price row, so unavailable until one is added \(here with --add, or in the admin panel\): bytedance\/seedance-2-5/)
})

test('the command: --help explains itself and touches nothing', async () => {
  await seedToday()
  const r = await run(['--help'])
  assert.equal(r.code, 0)
  assert.match(r.out, /--apply/)
  assert.deepEqual(await prices(), Object.fromEntries(TODAY.map(([m, , c]) => [m, c])))
})

test('percentages: 30, 30%, 12.5 and 0 are shares; anything else is refused', () => {
  assert.equal(shareFromPercent('30', 'margin', 0.9), 0.3)
  assert.equal(shareFromPercent('30%', 'margin', 0.9), 0.3)
  assert.equal(shareFromPercent(' 12.5 ', 'margin', 0.9), 0.125)
  assert.equal(shareFromPercent('0', 'margin', 0.9), 0)
  assert.equal(shareFromPercent('90', 'margin', 0.9), 0.9)
  for (const bad of ['', ' ', 'x', '91', '-1', 'NaN', 'Infinity', '1e3', undefined, null]) {
    assert.throws(() => shareFromPercent(bad, 'margin', 0.9), RepriceError, String(bad))
  }
})

function runFile(args, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['db/reprice.js', ...args], { cwd: BACKEND, env: { ...process.env, ...env } })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', c => { stdout += c })
    child.stderr.on('data', c => { stderr += c })
    child.on('error', reject)
    child.on('close', code => resolve({ code, stdout, stderr }))
  })
}

test('run as `node db/reprice.js`: a bad flag exits 1 with its reason, --help exits 0, and a database that cannot be reached exits 2 in plain words', async () => {
  // (Decided before the database is touched, so these need none: the embedded test database serves one
  // connection at a time and the app under test is holding it.)
  const refused = await runFile(['--margin', 'lots'])
  assert.equal(refused.code, 1)
  assert.match(refused.stderr, /margin must be a percentage/)

  const help = await runFile(['--help'])
  assert.equal(help.code, 0)
  assert.match(help.stdout, /Usage: node db\/reprice\.js/)

  const down = await runFile([], { DATABASE_URL: 'postgres://nobody:nothing@127.0.0.1:1/none' })
  assert.equal(down.code, 2)
  assert.match(down.stderr, /Could not finish/)
})
