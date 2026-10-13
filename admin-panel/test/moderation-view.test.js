// The moderation page: the queue, one item at a time, and the decision. This is the
// page where a mistake costs somebody their account or their files, so every path
// that sends something is checked for exactly what it sends.

import test, { beforeEach } from 'node:test'
import assert from './assert.js'

import {
  installDom, reset, click, change, submit, press, settle, text, all, byText, fakeApi, viewContext, apiError, user, event, config, ID, dom,
} from './helpers.js'

installDom()
const { renderModeration } = await import('../views/moderation.js')
const { parseRoute } = await import('../lib/router.js')

beforeEach(reset)

const recent = seconds => new Date(Date.now() - seconds * 1000).toISOString()

const idOf = n => ID(100 + n)

/**
 * Mount the page against a small in-memory queue, so a decision really removes the
 * item from the open list, the way the server would.
 */
function open({ hash = '#/moderation', events = [event(1), event(2), event(3)], wide = false, routes = {}, cfg = config() } = {}) {
  const db = { events: events.map(e => ({ ...e })), outcome: { ok: true, restored: false, blocked: false, deleted: false, suspended: false } }
  dom().matchMedia = () => ({ matches: wide, addEventListener() {}, removeEventListener() {} })

  const api = fakeApi({
    'GET /api/admin/moderation': q => {
      const list = db.events.filter(e => q.status === 'all' || e.status === q.status)
        .filter(e => !q.source || e.source === q.source).filter(e => !q.userId || e.userId === q.userId)
      const count = s => db.events.filter(e => e.status === s).length
      return { events: list, total: list.length, page: q.page, pageSize: q.pageSize, counts: { open: count('open'), dismissed: count('dismissed'), confirmed: count('confirmed') } }
    },
    'GET /api/admin/moderation/item': q => {
      const found = db.events.find(e => e.id === q.eventId)
      if (!found) throw apiError('That item does not exist.', 404, 'NOT_FOUND')
      return { event: structuredClone(found) }
    },
    'GET /api/admin/moderation/media': { url: 'https://files.test/signed?x=1', kind: 'image', expiresIn: 60 },
    'POST /api/admin/moderation/resolve': body => {
      const found = db.events.find(e => e.id === body.eventId)
      found.status = body.resolution === 'dismiss' ? 'dismissed' : 'confirmed'
      found.reviewedBy = 'boss@test.example'
      found.reviewedAt = recent(0)
      found.reviewNote = body.note ?? null
      return { ...db.outcome }
    },
    'GET /api/admin/config': cfg,
    ...routes,
  })
  const { ctx, navigations } = viewContext(api, parseRoute(hash))
  document.body.append(ctx.container)
  const controller = renderModeration(ctx)
  return { api, db, ctx, navigations, controller, root: ctx.container }
}

/** The shell's job: when the page asks to go somewhere, the address changes and the page is told. */
async function follow(env) {
  await env.controller.update(parseRoute(env.navigations.at(-1)))
  await settle()
}

const listQuery = api => api.of('GET', '/api/admin/moderation').at(-1).input
const items = root => all(root, '.mod-item')
const resolves = api => api.of('POST', '/api/admin/moderation/resolve')
const form = () => document.querySelector('form.decision')
const choose = value => {
  const radio = document.querySelector(`input[name=decision][value=${value}]`)
  radio.checked = true
  radio.dispatchEvent(new (dom().Event)('change', { bubbles: true }))
}
const tick = (id) => document.getElementById(id)

const selectedAt = async (hash, over = {}) => {
  const env = open({ hash, ...over })
  await settle()
  return env
}

// ── The queue ────────────────────────────────────────────────────────────────

test('each item in the queue shows its source, verdict, owner, categories, excerpt and age', async () => {
  const env = await selectedAt('#/moderation', { events: [
    event(1, { source: 'prompt', action: 'blocked', categories: ['sexual', 'violence'], excerpt: 'a refused prompt' }),
    event(2, { source: 'image', action: 'held', categories: ['harassment'], excerpt: null }),
    event(3, { source: 'report', action: 'reported', categories: [], excerpt: 'x'.repeat(200) }),
  ] })
  const rows = items(env.root)
  assert.equal(rows.length, 3)
  assert.match(text(rows[0]), /Prompt/)
  assert.match(text(rows[0]), /Refused/)
  assert.match(text(rows[0]), /user1@test\.example/)
  assert.match(text(rows[0]), /a refused prompt/)
  assert.equal(rows[0].querySelector('time').getAttribute('datetime').length > 10, true)
  assert.match(text(rows[2]), /—/, 'no categories: a dash, not a blank')
  assert.ok(text(rows[2]).length < 200, 'a long excerpt is shortened')
  assert.ok(rows[0].querySelector('.badge-danger'), 'a refusal is red')
  assert.ok(rows[1].querySelector('.badge-warning'), 'a held item is amber')
})

test('the first request asks for open items from page 1; nonsense in the address is ignored', async () => {
  const plain = await selectedAt('#/moderation')
  assert.deepEqual(listQuery(plain.api), { status: 'open', source: '', userId: '', page: 1, pageSize: 25 })

  reset()
  const filtered = await selectedAt(`#/moderation?status=confirmed&source=video&userId=${ID(4)}&page=2`)
  assert.deepEqual(listQuery(filtered.api), { status: 'confirmed', source: 'video', userId: ID(4), page: 2, pageSize: 25 })

  reset()
  const bad = await selectedAt('#/moderation?status=everything&source=hacked&page=zero')
  assert.deepEqual(listQuery(bad.api), { status: 'open', source: '', userId: '', page: 1, pageSize: 25 })
})

test('the tabs carry the counts from the server and move between statuses', async () => {
  const env = await selectedAt('#/moderation?page=2', { events: [event(1), event(2, { status: 'dismissed' }), event(3, { status: 'confirmed' }), event(4, { status: 'confirmed' })] })
  const tab = label => byText(env.root, '[role=tab]', label)
  assert.equal(text(tab('Open')), 'Open1')
  assert.equal(text(tab('Dismissed')), 'Dismissed1')
  assert.equal(text(tab('Confirmed')), 'Confirmed2')
  assert.equal(tab('Open').getAttribute('aria-selected'), 'true')

  click(tab('Dismissed'))
  assert.equal(env.navigations.at(-1), '#/moderation?status=dismissed', 'page 2 is dropped')
  click(tab('All'))
  assert.equal(env.navigations.at(-1), '#/moderation?status=all')

  reset()
  const onConfirmed = await selectedAt('#/moderation?status=confirmed')
  click(byText(onConfirmed.root, '[role=tab]', 'Open'))
  assert.equal(onConfirmed.navigations.at(-1), '#/moderation', 'Open is the default, so it is not written')
})

test('the source filter narrows the queue, and "any" removes it', async () => {
  const env = await selectedAt('#/moderation')
  const source = env.root.querySelector('select[aria-label=Source]')
  assert.deepEqual(all(source, 'option').map(o => o.value), ['', 'prompt', 'prompt_assist', 'image', 'video', 'output', 'report', 'provider'])
  change(source, 'video')
  assert.equal(env.navigations.at(-1), '#/moderation?source=video')

  reset()
  const picked = await selectedAt('#/moderation?source=video&status=all')
  change(picked.root.querySelector('select[aria-label=Source]'), '')
  assert.equal(picked.navigations.at(-1), '#/moderation?status=all')
})

test('a queue narrowed to one account says so, and the chip removes just that filter', async () => {
  const env = await selectedAt(`#/moderation?userId=${ID(1)}&status=all`)
  const chip = env.root.querySelector('.chip')
  assert.match(text(chip), /One account/)
  click(chip.querySelector('button'))
  assert.equal(env.navigations.at(-1), '#/moderation?status=all')
})

test('an empty queue is good news; an empty other tab just says so; and the right pane invites a choice', async () => {
  const open1 = await selectedAt('#/moderation', { events: [] })
  assert.match(text(open1.root.querySelector('.mod-list')), /Nothing to review/)
  assert.match(text(open1.root.querySelector('.mod-list')), /all caught up/)
  assert.match(text(open1.root.querySelector('.mod-detail')), /Select an item/)

  reset()
  const other = await selectedAt('#/moderation?status=dismissed', { events: [event(1)] })
  assert.match(text(other.root.querySelector('.mod-list')), /Nothing here/)
})

test('a failed load shows the error and Try again loads again', async () => {
  let n = 0
  const env = open({ routes: { 'GET /api/admin/moderation': () => { if (++n === 1) throw apiError('Down.', 503, 'X'); return { events: [event(1)], total: 1, page: 1, pageSize: 25, counts: { open: 1, dismissed: 0, confirmed: 0 } } } } })
  await settle()
  assert.match(text(env.root.querySelector('.mod-list')), /Down\./)
  click(byText(env.root, 'button', 'Try again'))
  await settle()
  assert.equal(items(env.root).length, 1)
})

test('a long queue is paged', async () => {
  const many = Array.from({ length: 25 }, (_, i) => event(i + 1))
  const env = open({ events: many, routes: { 'GET /api/admin/moderation': () => ({ events: many, total: 60, page: 1, pageSize: 25, counts: { open: 60, dismissed: 0, confirmed: 0 } }) } })
  await settle()
  click(env.root.querySelector('[aria-label="Next page"]'))
  assert.equal(env.navigations.at(-1), '#/moderation?page=2')

  reset()
  const one = open({ events: [event(1)] })
  await settle()
  assert.equal(one.root.querySelector('.pager'), null, 'no pager for a single page')
})

// ── Choosing an item ─────────────────────────────────────────────────────────

test('on a wide screen the first item opens by itself; on a narrow one nothing does', async () => {
  const wide = open({ wide: true })
  await settle()
  assert.deepEqual(wide.navigations, [`#/moderation/${idOf(1)}`])

  reset()
  const narrow = open({ wide: false })
  await settle()
  assert.deepEqual(narrow.navigations, [])
})

test('an item already named in the address is not replaced by the first one', async () => {
  const env = open({ hash: `#/moderation/${idOf(2)}`, wide: true })
  await settle()
  assert.deepEqual(env.navigations, [])
  assert.match(text(env.root.querySelector('.mod-detail')), /user2@test\.example/)
})

test('clicking an item selects it and keeps the filters; the selected one is marked', async () => {
  const env = await selectedAt('#/moderation?source=prompt')
  click(items(env.root)[1])
  assert.deepEqual(env.navigations, [`#/moderation/${idOf(2)}?source=prompt`])
  await follow(env)
  const rows = items(env.root)
  assert.equal(rows[1].getAttribute('aria-selected'), 'true')
  assert.equal(rows[0].getAttribute('aria-selected'), 'false')
  assert.ok(env.root.querySelector('.mod-layout').classList.contains('has-selection'))
  assert.equal(env.api.of('GET', '/api/admin/moderation').length, 1, 'choosing does not reload the queue')
  assert.equal(env.api.of('GET', '/api/admin/moderation/item').length, 0, 'it was already loaded')
})

test('"All items" returns to the list; the page is told the selection is gone', async () => {
  const env = await selectedAt(`#/moderation/${idOf(1)}?status=open`)
  click(byText(env.root, 'button', 'All items'))
  assert.equal(env.navigations.at(-1), '#/moderation?status=open')
  await follow(env)
  assert.match(text(env.root.querySelector('.mod-detail')), /Select an item/)
  assert.ok(!env.root.querySelector('.mod-layout').classList.contains('has-selection'))
})

test('j and k move through the list; they stop at the ends, ignore typing, modifiers and other keys', async () => {
  const env = await selectedAt(`#/moderation/${idOf(1)}`)
  const key = (k, init, target = document) => press(target, k, init)

  key('j')
  assert.equal(env.navigations.at(-1), `#/moderation/${idOf(2)}`)
  await follow(env)
  key('j')
  assert.equal(env.navigations.at(-1), `#/moderation/${idOf(3)}`)
  await follow(env)
  const count = env.navigations.length
  key('j')
  assert.equal(env.navigations.length, count, 'past the last item: nothing')
  key('k')
  assert.equal(env.navigations.at(-1), `#/moderation/${idOf(2)}`)

  const before = env.navigations.length
  key('x')
  key('j', { ctrlKey: true })
  key('j', { metaKey: true })
  key('j', { altKey: true })
  const textarea = document.createElement('textarea'); document.body.append(textarea)
  key('k', {}, textarea)
  const sel = document.createElement('select'); document.body.append(sel)
  key('k', {}, sel)
  assert.equal(env.navigations.length, before)
})

test('k at the first item stays put, and once the page is left the keys do nothing', async () => {
  const env = await selectedAt(`#/moderation/${idOf(1)}`)
  const before = env.navigations.length
  press(document, 'k')
  assert.equal(env.navigations.length, before)
  env.controller.destroy()
  press(document, 'j')
  assert.equal(env.navigations.length, before, 'the key listener was removed')
})

// ── The item ─────────────────────────────────────────────────────────────────

test('the item shows who, what model and task, what was submitted and the verdict', async () => {
  const env = await selectedAt(`#/moderation/${idOf(1)}`, { events: [event(1, { model: 'kling-3.0/video', taskId: 'task-abcdefghijklmnopqrstuvwxyz', excerpt: 'refused words', userStatus: 'suspended' })] })
  const detail = env.root.querySelector('.mod-detail')
  assert.match(text(detail), /Sexual content/)
  assert.equal(detail.querySelector('a.link').getAttribute('href'), `#/users/${ID(1)}`)
  assert.match(text(detail), /user1@test\.example/)
  assert.match(text(detail), /Suspended/)
  assert.match(text(detail), /kling-3\.0\/video/)
  assert.match(text(detail), /What was submitted/)
  assert.equal(detail.querySelector('blockquote').textContent, 'refused words')
})

test('a report says "what they said" and, with no scores, names how it was reported', async () => {
  const env = await selectedAt(`#/moderation/${idOf(1)}`, { events: [event(1, { source: 'report', action: 'reported', categories: ['sexual', 'violence'], scores: {}, excerpt: 'this is wrong' })] })
  const detail = env.root.querySelector('.mod-detail')
  assert.match(text(detail), /What they said/)
  assert.match(text(detail), /Reported as: Sexual content, Violence/)
  assert.equal(detail.querySelector('.scores'), null)
})

test('scores are bars, toned by the rules the server reports, with the review and refuse lines marked', async () => {
  const env = await selectedAt(`#/moderation/${idOf(1)}`, { events: [event(1, { categories: ['sexual', 'violence', 'harassment'], scores: { sexual: 0.93, violence: 0.9, harassment: 0.99, 'self-harm': 0.3 } })] })
  const rows = all(env.root, '.score-row')
  const byLabel = label => rows.find(r => r.textContent.includes(label))
  assert.equal(rows.length, 4)
  assert.ok(byLabel('Sexual').querySelector('.score-danger'), '0.93 is over the 0.85 refuse line')
  assert.ok(byLabel('Violence').querySelector('.score-warning'), '0.9 is over the 0.8 review line, with no refuse line')
  assert.ok(byLabel('Harassment').querySelector('.score-neutral'), 'a category set to ignore never colours')
  assert.equal(byLabel('Harassment').querySelector('.score-mark'), null)
  assert.equal(byLabel('Sexual').querySelector('.score-mark-review').title, 'Held for review at 0.5')
  assert.equal(byLabel('Sexual').querySelector('.score-mark-block').title, 'Refused at 0.85')
  assert.equal(byLabel('Violence').querySelector('.score-mark-block'), null)
  assert.match(text(rows[0]), /0\.99/, 'sorted highest first, shown to two places')
  assert.equal(rows[0].querySelector('[role=meter]').getAttribute('aria-valuenow'), '0.99')
})

test('if the rules cannot be fetched the item still shows, just without the lines', async () => {
  const env = open({ hash: `#/moderation/${idOf(1)}`, routes: { 'GET /api/admin/config': () => { throw apiError('no', 500, 'X') } } })
  await settle()
  assert.ok(env.root.querySelector('.score-row'))
  assert.equal(env.root.querySelector('.score-mark'), null)
})

test('rules that arrive after the item redraw only the bars — a note being typed and a revealed file stay as they are', async () => {
  let release
  const env = open({
    hash: `#/moderation/${idOf(1)}`,
    events: withFile(),
    routes: { 'GET /api/admin/config': () => new Promise(r => { release = () => r(config()) }) },
  })
  await settle()
  assert.equal(env.root.querySelector('.score-mark'), null, 'no lines yet')
  document.getElementById('mod-note').value = 'half-written note'
  choose('confirm')
  click(byText(env.root, '.reveal button', 'Reveal file'))
  await settle()

  release()
  await settle()
  assert.ok(env.root.querySelector('.score-mark-block'), 'the lines appear')
  assert.equal(document.getElementById('mod-note').value, 'half-written note')
  assert.equal(document.querySelector('input[name=decision][value=confirm]').checked, true)
  assert.ok(env.root.querySelector('.reveal img'), 'the revealed file was not hidden again')
  assert.equal(env.api.of('GET', '/api/admin/moderation/item').length, 0)
})

test('a score outside 0–1 cannot draw outside its track', async () => {
  const env = await selectedAt(`#/moderation/${idOf(1)}`, { events: [event(1, { scores: { sexual: 7, violence: -3 } })] })
  const fills = all(env.root, '.score-fill')
  assert.deepEqual(fills.map(f => f.style.width), ['100%', '0%'])
})

test('what the file is and whether its owner can see it', async () => {
  for (const [assetStatus, pattern] of [['blocked', /blocked: its owner cannot see it/], ['clear', /let through and its owner can see it/], ['unchecked', /not been checked yet/]]) {
    reset()
    const env = await selectedAt(`#/moderation/${idOf(1)}`, { events: [event(1, { assetId: ID(50), assetKind: 'image', assetStatus })] })
    assert.match(text(env.root.querySelector('.mod-detail')), pattern, assetStatus)
  }
  reset()
  const video = await selectedAt(`#/moderation/${idOf(1)}`, { events: [event(1, { assetId: ID(50), assetKind: 'video', assetStatus: 'clear' })] })
  assert.match(text(video.root.querySelector('.mod-detail')), /The video/)
  assert.match(text(video.root.querySelector('.reveal')), /Video hidden/)
})

test('an item with no file has no file section and no delete option', async () => {
  const env = await selectedAt(`#/moderation/${idOf(1)}`, { events: [event(1, { assetId: null })] })
  assert.equal(env.root.querySelector('.reveal'), null)
  choose('confirm')
  assert.equal(tick('mod-delete'), null)
  assert.ok(tick('mod-suspend'))
})

// ── Revealing the file ───────────────────────────────────────────────────────

const withFile = (over = {}) => [event(1, { assetId: ID(50), assetKind: 'image', assetStatus: 'blocked', ...over })]

test('the file stays hidden — and nothing is fetched — until Reveal is pressed, which says it is recorded', async () => {
  const env = await selectedAt(`#/moderation/${idOf(1)}`, { events: withFile() })
  assert.equal(env.api.of('GET', '/api/admin/moderation/media').length, 0)
  assert.match(text(env.root.querySelector('.reveal')), /Image hidden/)
  assert.match(text(env.root.querySelector('.reveal')), /recorded in the audit log/)
  assert.equal(env.root.querySelector('.reveal img, .reveal video'), null)
})

test('Reveal fetches by the event id, shows the picture from the link given, and notes that it expires and was recorded', async () => {
  const env = await selectedAt(`#/moderation/${idOf(1)}`, { events: withFile() })
  click(byText(env.root, '.reveal button', 'Reveal file'))
  await settle()
  assert.deepEqual(env.api.of('GET', '/api/admin/moderation/media')[0].input, { eventId: idOf(1) })
  const img = env.root.querySelector('.reveal img')
  assert.equal(img.getAttribute('src'), 'https://files.test/signed?x=1')
  assert.equal(img.getAttribute('alt'), 'The file under review')
  assert.match(text(env.root.querySelector('.reveal')), /expires in 60 seconds/)
  assert.match(text(env.root.querySelector('.reveal')), /view was recorded/)
})

test('a video is shown in a player that does not start by itself', async () => {
  const env = await selectedAt(`#/moderation/${idOf(1)}`, { events: withFile({ assetKind: 'video' }), routes: { 'GET /api/admin/moderation/media': { url: 'https://files.test/v.mp4', kind: 'video', expiresIn: 30 } } })
  click(byText(env.root, '.reveal button', 'Reveal file'))
  await settle()
  const video = env.root.querySelector('.reveal video')
  assert.equal(video.getAttribute('src'), 'https://files.test/v.mp4')
  assert.equal(video.hasAttribute('autoplay'), false)
  assert.ok(video.hasAttribute('controls'))
})

test('if the file cannot be shown the reason is given, with Try again; and again works', async () => {
  let n = 0
  const env = await selectedAt(`#/moderation/${idOf(1)}`, { events: withFile(), routes: { 'GET /api/admin/moderation/media': () => { if (++n === 1) throw apiError('The file is gone.', 404, 'NOT_FOUND'); return { url: 'https://files.test/x', kind: 'image', expiresIn: 60 } } } })
  click(byText(env.root, '.reveal button', 'Reveal file'))
  await settle()
  assert.match(text(env.root.querySelector('.reveal')), /The file is gone/)
  click(byText(env.root, '.reveal button', 'Try again'))
  await settle()
  assert.ok(env.root.querySelector('.reveal img'))
})

test('moving to another item hides the file again — a reveal never carries over', async () => {
  const env = await selectedAt(`#/moderation/${idOf(1)}`, { events: [...withFile(), event(2, { assetId: ID(51), assetKind: 'image', assetStatus: 'blocked' })] })
  click(byText(env.root, '.reveal button', 'Reveal file'))
  await settle()
  assert.ok(env.root.querySelector('.reveal img'))
  await env.controller.update(parseRoute(`#/moderation/${idOf(2)}`))
  await settle()
  assert.equal(env.root.querySelector('.reveal img'), null)
  assert.match(text(env.root.querySelector('.reveal')), /Image hidden/)
})

// ── An item that is not in the loaded page ───────────────────────────────────

test('a shared link to an item outside the page asks for that one item', async () => {
  const env = open({ hash: `#/moderation/${idOf(9)}?status=all`, events: [event(1), event(9, { status: 'dismissed', reviewNote: 'looked fine', reviewedBy: 'boss@test.example', reviewedAt: recent(7200) })] })
  // Make the list not contain it: ask for the open tab's page of the list.
  env.api.routes['GET /api/admin/moderation'] = () => ({ events: [event(1)], total: 1, page: 1, pageSize: 25, counts: { open: 1, dismissed: 1, confirmed: 0 } })
  await env.controller.update(parseRoute(`#/moderation/${idOf(9)}?status=all&source=prompt`))
  await settle()
  assert.deepEqual(env.api.of('GET', '/api/admin/moderation/item')[0].input, { eventId: idOf(9) })
  assert.match(text(env.root.querySelector('.mod-detail')), /user9@test\.example/)
})

test('an item that does not exist says so kindly, with a way back', async () => {
  const env = open({ hash: `#/moderation/${idOf(77)}?status=all` })
  await settle()
  const detail = env.root.querySelector('.mod-detail')
  assert.match(text(detail), /That item was not found/)
  click(byText(detail, 'button', 'Back to the list'))
  assert.equal(env.navigations.at(-1), '#/moderation?status=all')
})

test('any other failure fetching the item can be retried', async () => {
  let n = 0
  const env = open({ hash: `#/moderation/${idOf(77)}`, routes: { 'GET /api/admin/moderation/item': () => { if (++n === 1) throw apiError('Slow.', 503, 'X'); return { event: event(77) } } } })
  await settle()
  assert.match(text(env.root.querySelector('.mod-detail')), /Slow\./)
  click(byText(env.root.querySelector('.mod-detail'), 'button', 'Try again'))
  await settle()
  assert.match(text(env.root.querySelector('.mod-detail')), /user77@test\.example/)
})

test('an answer for an item you have already moved away from is thrown away', async () => {
  let release
  const env = open({ hash: `#/moderation/${idOf(77)}`, routes: { 'GET /api/admin/moderation/item': () => new Promise(r => { release = () => r({ event: event(77) }) }) } })
  await settle()
  await env.controller.update(parseRoute(`#/moderation/${idOf(2)}`))
  await settle()
  release()
  await settle()
  assert.match(text(env.root.querySelector('.mod-detail')), /user2@test\.example/)
  assert.doesNotMatch(text(env.root.querySelector('.mod-detail')), /user77/)
})

// ── Deciding ─────────────────────────────────────────────────────────────────

test('the decision form starts on Dismiss, labelled so, with the extras hidden', async () => {
  await selectedAt(`#/moderation/${idOf(1)}`, { events: withFile() })
  assert.equal(document.querySelector('input[name=decision][value=dismiss]').checked, true)
  assert.equal(text(form().querySelector('button[type=submit]')), 'Dismiss')
  assert.ok(form().querySelector('.decision-extras').classList.contains('hidden'))
  assert.match(text(form()), /A blocked file goes back to its owner/)
})

test('choosing Confirm shows the extras and renames the button; going back hides them', async () => {
  await selectedAt(`#/moderation/${idOf(1)}`, { events: withFile() })
  choose('confirm')
  assert.equal(text(form().querySelector('button[type=submit]')), 'Confirm violation')
  assert.equal(form().querySelector('.decision-extras').classList.contains('hidden'), false)
  assert.match(text(form()), /Delete the file permanently/)
  assert.match(text(form()), /Administrators are never suspended/)
  choose('dismiss')
  assert.equal(text(form().querySelector('button[type=submit]')), 'Dismiss')
  assert.ok(form().querySelector('.decision-extras').classList.contains('hidden'))
})

test('dismissing sends exactly: the item, "dismiss", the trimmed note, and no destructive flags', async () => {
  const env = await selectedAt(`#/moderation/${idOf(1)}`, { events: withFile() })
  const note = document.getElementById('mod-note')
  note.value = '  looked fine to me  '
  submit(form()); await settle()
  assert.deepEqual(resolves(env.api)[0].input, { eventId: idOf(1), resolution: 'dismiss', note: 'looked fine to me', deleteContent: false, suspendUser: false })
})

test('an empty note is not sent at all', async () => {
  const env = await selectedAt(`#/moderation/${idOf(1)}`)
  document.getElementById('mod-note').value = '   '
  submit(form()); await settle()
  assert.equal(resolves(env.api)[0].input.note, undefined)
})

test('the delete and suspend boxes only count when confirming: ticked, then switched back to Dismiss, they are not sent', async () => {
  const env = await selectedAt(`#/moderation/${idOf(1)}`, { events: withFile() })
  choose('confirm')
  tick('mod-delete').checked = true
  tick('mod-suspend').checked = true
  choose('dismiss')
  submit(form()); await settle()
  assert.deepEqual(resolves(env.api)[0].input, { eventId: idOf(1), resolution: 'dismiss', note: undefined, deleteContent: false, suspendUser: false })
})

test('confirming with both boxes ticked sends both; with neither, neither', async () => {
  const both = await selectedAt(`#/moderation/${idOf(1)}`, { events: withFile() })
  choose('confirm')
  tick('mod-delete').checked = true
  tick('mod-suspend').checked = true
  submit(form()); await settle()
  assert.deepEqual(resolves(both.api)[0].input, { eventId: idOf(1), resolution: 'confirm', note: undefined, deleteContent: true, suspendUser: true })

  reset()
  const neither = await selectedAt(`#/moderation/${idOf(1)}`, { events: withFile() })
  choose('confirm')
  submit(form()); await settle()
  assert.deepEqual(resolves(neither.api)[0].input, { eventId: idOf(1), resolution: 'confirm', note: undefined, deleteContent: false, suspendUser: false })
})

test('the outcome is stated back in a sentence, and the sidebar count is refreshed', async () => {
  const env = await selectedAt(`#/moderation/${idOf(1)}`, { events: withFile() })
  env.db.outcome = { ok: true, restored: true, blocked: false, deleted: false, suspended: false }
  submit(form()); await settle()
  const toast = document.querySelector('.toast-success')
  assert.match(text(toast), /Decision saved/)
  assert.match(text(toast), /Dismissed — the strike is withdrawn; the file is back in their gallery\./)
  assert.equal(env.navigations.refreshed, 1)

  reset()
  const confirm = await selectedAt(`#/moderation/${idOf(1)}`, { events: withFile() })
  confirm.db.outcome = { ok: true, restored: false, blocked: true, deleted: false, suspended: true }
  choose('confirm')
  submit(form()); await settle()
  assert.match(text(document.querySelector('.toast-success')), /Confirmed; the file is now blocked and hidden from them; the account was suspended\./)
})

test('while the decision is being saved it cannot be sent again', async () => {
  let release
  const env = await selectedAt(`#/moderation/${idOf(1)}`, { routes: { 'POST /api/admin/moderation/resolve': () => new Promise(r => { release = () => r({ ok: true }) }) } })
  const button = form().querySelector('button[type=submit]')
  submit(form())
  assert.equal(button.disabled, true)
  await settle()
  release()
  await settle()
  assert.equal(resolves(env.api).length, 1)
})

test('a refused decision is explained in the form, can be sent again, and clears the message when it works', async () => {
  let n = 0
  const env = await selectedAt(`#/moderation/${idOf(1)}`, { routes: { 'POST /api/admin/moderation/resolve': () => {
    if (++n === 1) throw apiError('Someone else already decided this.', 409, 'ALREADY_RESOLVED')
    return { ok: true }
  } } })
  submit(form()); await settle()
  const error = form().querySelector('[role=alert]')
  assert.match(text(error), /already decided/)
  assert.equal(error.classList.contains('form-error-empty'), false)
  assert.equal(form().querySelector('button[type=submit]').disabled, false)
  assert.equal(document.querySelector('.toast-success'), null)
  assert.equal(env.navigations.refreshed, undefined)
  submit(form()); await settle()
  assert.equal(resolves(env.api).length, 2)
})

// ── After deciding ───────────────────────────────────────────────────────────

test('on the Open tab, deciding reloads the queue and moves to the item that took its place', async () => {
  const env = await selectedAt(`#/moderation/${idOf(1)}`)
  submit(form()); await settle()
  assert.equal(env.api.of('GET', '/api/admin/moderation').length, 2, 'the queue was reloaded')
  assert.equal(env.navigations.at(-1), `#/moderation/${idOf(2)}`, 'the next one, not a gap')

  await follow(env)
  assert.match(text(env.root.querySelector('.mod-detail')), /user2@test\.example/)
  assert.equal(items(env.root).length, 2)
})

test('deciding the middle item moves to the one that follows it; the last moves back to the new last', async () => {
  const env = await selectedAt(`#/moderation/${idOf(2)}`)
  submit(form()); await settle()
  assert.equal(env.navigations.at(-1), `#/moderation/${idOf(3)}`)

  reset()
  const last = await selectedAt(`#/moderation/${idOf(3)}`)
  submit(form()); await settle()
  assert.equal(last.navigations.at(-1), `#/moderation/${idOf(2)}`)
})

test('deciding the last open item returns to the list, which then says it is all caught up', async () => {
  const env = await selectedAt(`#/moderation/${idOf(1)}`, { events: [event(1)] })
  submit(form()); await settle()
  assert.equal(env.navigations.at(-1), '#/moderation')
  await follow(env)
  assert.match(text(env.root.querySelector('.mod-list')), /Nothing to review/)
  assert.match(text(env.root.querySelector('.mod-detail')), /Select an item/)
})

test('on the All tab the item stays and shows how it was decided', async () => {
  const env = await selectedAt(`#/moderation/${idOf(1)}?status=all`)
  document.getElementById('mod-note').value = 'fine'
  submit(form()); await settle()
  assert.equal(env.navigations.filter(h => h.startsWith('#/moderation/')).length, 0, 'no jump to another item')
  const detail = env.root.querySelector('.mod-detail')
  assert.equal(detail.querySelector('form.decision'), null, 'the form is gone')
  assert.match(text(detail.querySelector('.callout')), /Dismissed by boss@test\.example/)
  assert.match(text(detail.querySelector('.callout')), /fine/)
})

test('an item that was already decided shows who and when, or that no note was left — and offers no form', async () => {
  const env = await selectedAt(`#/moderation/${idOf(1)}?status=all`, { events: [event(1, { status: 'confirmed', reviewedBy: 'boss@test.example', reviewedAt: recent(7200), reviewNote: null }), event(2, { status: 'dismissed', reviewNote: 'looked fine' })] })
  const detail = env.root.querySelector('.mod-detail')
  assert.equal(detail.querySelector('form.decision'), null)
  const callout = detail.querySelector('.callout')
  assert.match(text(callout), /Confirmed by boss@test\.example 2 h ago/)
  assert.match(text(callout), /No note was left/)
  assert.ok(callout.classList.contains('callout-danger'))
  assert.match(text(items(env.root)[0]), /Confirmed/)

  await env.controller.update(parseRoute(`#/moderation/${idOf(2)}?status=all`))
  await settle()
  assert.ok(env.root.querySelector('.mod-detail .callout').classList.contains('callout-success'))
  assert.match(text(env.root.querySelector('.mod-detail .callout')), /looked fine/)
})

// ── Following the address ────────────────────────────────────────────────────

test('update: a changed filter reloads the queue, a changed selection does not', async () => {
  const env = await selectedAt('#/moderation')
  await env.controller.update(parseRoute(`#/moderation/${idOf(2)}`))
  await settle()
  assert.equal(env.api.of('GET', '/api/admin/moderation').length, 1)
  await env.controller.update(parseRoute(`#/moderation/${idOf(2)}?status=all`))
  await settle()
  assert.equal(env.api.of('GET', '/api/admin/moderation').length, 2)
  assert.equal(listQuery(env.api).status, 'all')
})

test('an older queue request is cancelled when a newer one replaces it', async () => {
  const env = await selectedAt('#/moderation')
  env.controller.update(parseRoute('#/moderation?status=all'))
  env.controller.update(parseRoute('#/moderation?status=dismissed'))
  await settle()
  const calls = env.api.of('GET', '/api/admin/moderation')
  assert.equal(calls[1].signal.aborted, true)
  assert.equal(calls[2].signal.aborted, false)
})

test('destroy cancels what is in flight', async () => {
  const env = await selectedAt(`#/moderation/${idOf(1)}`)
  env.controller.destroy()
  assert.equal(env.api.of('GET', '/api/admin/moderation')[0].signal.aborted, true)
})

test('everything from the server is text: hostile emails, excerpts, notes and models build no elements', async () => {
  const evil = '<img src=x onerror=1><script>1</script>'
  await selectedAt(`#/moderation/${idOf(1)}?status=all`, { events: [event(1, {
    email: evil, excerpt: evil, model: evil, taskId: evil, reviewNote: evil, reviewedBy: evil, reviewedAt: recent(5), status: 'dismissed', categories: ['sexual'],
  })] })
  assert.equal(document.querySelectorAll('.mod-layout img, .mod-layout script').length, 0)
})

void user
