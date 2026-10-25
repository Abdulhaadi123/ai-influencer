# Backend

The API, the generation worker and the database for AI Influencer Studio.
**Self-contained** — nothing here imports the app or the web UI, and it has its
own `package.json`, so deploying it does not bring React or Expo onto a server.

```
backend/
  api/              the endpoints
    auth/           accounts and the pages email links open
    admin/          the admin panel's API (its page is the separate admin-panel/ folder)
    reports/        "report this result"
    _lib/           database, sessions, passwords, email, S3, errors
      moderation/   content moderation: policy, classifier, frames, enforcement
  db/
    migrations/     the schema — applied automatically when the API starts
    migrate.js
  lib/              rate limiting
  test/             unit and integration tests — `npm test`
  server/
    index.js        the API server (Express)
    worker.js       always-on job collector
  backup/           daily database dump to S3
  Dockerfile
  docker-compose.yml
  Caddyfile
```

The admin panel's page — HTML, CSS and JavaScript with no build step — is its own folder,
[`../admin-panel/`](../admin-panel/README.md), with its own tests. This server only hands the
files out (`ADMIN_UI_DIR`, default `../admin-panel`).

---

## What runs

`docker compose up -d --build` starts five containers:

| Container | What it does |
|---|---|
| `postgres` | PostgreSQL 16. **No public port** — only the containers below reach it. Data in the `postgres_data` volume. |
| `api` | Serves `/api/*` and the email-link pages. Applies pending migrations on start. |
| `worker` | Asks KIE about running jobs and collects finished results into S3. **Exactly one.** |
| `backup` | `pg_dump` to `s3://$S3_BUCKET/backups/` once a day. |
| `caddy` | TLS with automatic certificates, in front of `api`. |

**Do not run two workers.** They would double the request rate against KIE's
per-account limit. `replicas: 1` says so; keep it.

### Why the worker matters

KIE results expire 24 hours after they finish. Without the worker, the phone is
the only thing watching — close the app mid-generation and nothing collects the
result. The worker watches every user's jobs, stores finished results, and files
them in the gallery, so the user opens the app and the video is simply there.

**The callback below does not replace it.** A webhook can be missed — a deploy,
a restart, a dropped connection — and nothing else would ever notice. The
worker is the safety net; keep it running.

### Gallery previews

Every image and video also gets a small JPEG preview (`api/_lib/thumbnails.js`): the
picture scaled to 512 pixels wide, or a frame from the start of a clip — tens of
kilobytes instead of megabytes. The app draws its gallery squares, list rows and
avatars from it, and fetches the full file only when one is opened. Measured on the
emulator with real KIE files: the influencer list went from 3.4 MB to 0.14 MB, and
opening a gallery from 9.1 MB of images plus three video players to 0.46 MB.

A preview is made when a result is stored and when an upload is confirmed, after the
answer has gone; the worker makes the ones still missing — everything stored before
previews existed, newest first, ten per cycle. It needs ffmpeg, which the image
installs (it is also what moderation uses); without it files are stored as before and
the app draws them from the full file. A preview sits beside its file under the
user's prefix (`<asset>.thumb.jpg`, recorded in `assets.thumb_key`), is handed out by
`download-url` (`thumbUrl`) with the same ownership and moderation checks, and is
deleted with its file. Previews are not counted against the storage quota (about 1%
of the files).

---

## Generation callbacks (webhook)

Every `createTask` this server sends carries a `callBackUrl`, so KIE posts the
result to `POST /webhooks/kie` within seconds of a job finishing instead of the
worker discovering it up to a minute later.

It is the only endpoint with no session — KIE cannot hold one — so it proves the
sender another way:

- **Signature.** `X-Webhook-Signature` is `base64(HMAC-SHA256(taskId + "." +
  timestamp, KIE_WEBHOOK_SECRET))`, compared in constant time, with
  `X-Webhook-Timestamp` no more than 15 minutes out. Anything else is refused.
- **Nothing in the payload is trusted but the task id.** The owner, influencer
  and label come from our own `generation_jobs` row. A callback naming a user
  would otherwise be a way to write into someone else's account.
- **No secret, no callbacks.** With `KIE_WEBHOOK_SECRET` empty the server does
  not ask for them and refuses any that arrive — an unsigned "this job is done,
  here is the file" is exactly the request an attacker would forge.

**Setup:** generate the *Webhook HMAC key* at <https://kie.ai/settings>, put it
in `.env` as `KIE_WEBHOOK_SECRET`, make sure `PUBLIC_BASE_URL` is set, and
restart. The API says so at startup when callbacks are off.

---

## Content moderation

The app makes images and video of people from text and photos users supply, so
what goes in and what comes out is checked. All of it lives in
`api/_lib/moderation/`; the endpoints only call `service.js`.

| Checked | When | If refused |
|---|---|---|
| The text of a generation request (any field — the whole body is walked, so a new model's fields are covered) | before KIE is called | `400 CONTENT_BLOCKED`, nothing is spent |
| Every file the request names — ours, and any link on KIE's hosts (fetched and read, never trusted for where it lives) | before KIE is called | `400 CONTENT_BLOCKED` / `MEDIA_UNVERIFIABLE` / `MEDIA_NOT_ALLOWED`; `409 MEDIA_NOT_READY` for an upload not yet sealed (below) |
| A file sent through the proxy to KIE (`/api/file-base64-upload`) | before it is forwarded | `400 CONTENT_BLOCKED` / `MEDIA_UNVERIFIABLE` |
| An uploaded file | in the background after `/api/storage/confirm`, and again on first use | blocked for good |
| A generated result | when it is stored (webhook, worker, ingest) | quarantined: hidden from its owner, kept for an admin |
| Suggestion text (`/api/prompt-assist`) | before it is rewritten | `400 CONTENT_BLOCKED`, not a strike. Text held for review still gets its suggestion, with `notice: { code: 'REVIEW', message }` beside it; a rewriter that refuses ("I'm sorry, I can't…") gives `suggestion: null` and `notice: DECLINED`, never its refusal as the person's new text. The app draws the notice (or the 400's message) under the field — silence read as "nothing happened". |

The app asks for a suggestion on its own each time typing pauses, so one sentence typed in bursts is several
requests. A `prompt_assist` event **updates** the open one of the same kind from the same person that begins the same
way (first 12 characters, within 15 minutes) instead of adding another, so the queue — and the Moderation badge —
shows one item per draft, with the latest text (`recordEvent`, `moderation/events.js`).
| A task KIE's own filter refuses ("flagged as sensitive") | when the failed job settles (callback, sync, worker) | the job fails with KIE's words and nothing is charged; a `provider` item appears in the queue (`providerRefusals.js`, migration 003) — **not a strike**, since KIE does not say whether the prompt, the reference or its own output was the trouble |

The classifier is OpenAI's `omni-moderation-latest` (free; reuses `OPENAI_API_KEY`).
Video is checked by sampling frames with ffmpeg, which the Docker image installs.
The endpoint accepts **one image per request** (more is HTTP 400 `too_many_images` —
found by calling it for real), so each frame is sent on its own and the worst
score wins (`splitForRequests` in `openai.js`). A request's time limit is
`MODERATION_TIMEOUT_MS` plus a few seconds per megabyte sent (`timeoutFor`): a 2 MB
PNG took 12–19 s to answer on a slow link and, against a flat 15 s, stayed
`unchecked` forever.
**KIE's own filter** is also switched on, server-side, for the models that have one
(`api/_lib/moderation/kieFilters.js`) — `nsfw_checker` defaults to **off** at KIE.

**What it cannot do.** OpenAI scores `sexual/minors` for *text only*; for an image
it reports 0. So an image of a minor is not caught by this classifier, and the
hard "any minors content suspends the account" rule only ever fires on text. If
that matters, add an image-capable check (AWS Rekognition's face age range, for
example) — `classifyImageBytes` and `classifyStored` in `service.js` are the
places. Frame sampling can also miss a flash between two sampled frames, and the
first display of a result inside the create wizard comes straight from the
generator, before it is stored and checked.

**What a file is comes from its bytes, never from what the client called it.**
Audio is the one kind with no classifier, so it is the one kind let through
unchecked — and that made "this is audio" a way round the check for everything else
(an `uploadPath` of `audio/…`, a `data:audio/…` header, or an upload declared as
`audio/mpeg` all used to send an explicit image to KIE unread). `sniff.js` now
recognises audio by its first bytes (**MP3, WAV, M4A** — the types the app stores);
only a file that really is audio skips the check, and a file that is none of image,
video or audio is refused `MEDIA_UNVERIFIABLE`. Other audio formats are therefore
refused. Audio itself is still not looked at.

**A link on KIE's hosts is not a checked file.** It may be something KIE generated,
a file uploaded through the proxy, or something left at a guessable address, so it
is downloaded when a request uses it (SSRF-safe, 15 s limit, size-capped), classified
like any file, and the verdict is remembered for ten minutes. At most 8 such links
per request; a link that cannot be fetched is refused (or let through, with
`MODERATION_FAIL_MODE=open`). The app's own screens send our S3 links, not KIE's, so
nothing in the app is slowed by this.

**An upload is sealed so the bytes checked are the bytes sent** (`seal.js`, migration
`006_sealed_uploads.sql`, `assets.sealed_at`). The presigned upload link pins the
key and the length, not the content, lives 30 minutes and can be used again — so a
file could be replaced *after* it had been checked. `/api/storage/confirm` therefore
copies the file, inside S3, to a key no link names (`…-sealed.<ext>`), points the
asset at the copy and deletes the original; if that fails the upload is not
confirmed and the app uploads again. An upload that was never confirmed is sealed
when it is first used, and that request is answered `409 MEDIA_NOT_READY` — the
retry names the sealed file. Uploads that predate sealing, and anything the server
wrote itself, count as sealed once their link has expired, so nothing existing needs
migrating. A second use of the old link writes to a key nothing refers to; it is
swept with the account's other files. The IAM user needs `s3:GetObject` and
`s3:PutObject` (CopyObject), which it already has.

**Policy** is in `policy.js`: *block*, *review* (allowed, but a person looks) or
*allow*, per category. The defaults are a starting point — watch the admin queue
for a week, then tune with `MODERATION_THRESHOLDS`, for example
`{"sexual":{"block":0.9},"violence":{"review":null}}`. The minors rule cannot be
switched off or loosened past 0.5.

**Strikes.** A refused prompt or upload is a strike; one tap that sends three
prompts is one strike (counted per minute). `MODERATION_STRIKE_LIMIT` (5) strikes
in `MODERATION_STRIKE_WINDOW_DAYS` (30) suspends the account, as does any minors
refusal at once. Results the generator made, suggestion requests and user reports
are never strikes. Dismissing an event in the admin panel withdraws its strike.
Restoring a suspended account does **not** clear its strikes — at the limit, its next
refusal suspends it again — so dismiss the items that were wrong first. Admins are
never suspended automatically. (Counting is by clock minute, so two refusals a second
apart across a minute boundary count as two.)

**When the checker is down.** Requests are refused (`MODERATION_FAIL_MODE=closed`,
the default) — a refused request costs a minute, an unchecked one a policy
violation. Results already paid for are the opposite: they are stored and shown,
and the worker checks them again later (with a growing wait), quarantining any that
turn out bad.

**Privacy.** A refused prompt keeps a 400-character excerpt in `moderation_events`
so a reviewer can see what was refused; scores are kept, image contents never are.
It all goes when the account is deleted.

**Config:** `MODERATION_ENABLED`, `MODERATION_FAIL_MODE`, `MODERATION_THRESHOLDS`,
`MODERATION_STRIKE_LIMIT`, `MODERATION_STRIKE_WINDOW_DAYS`, `MODERATION_SUSPEND_ON_MINORS`,
`MODERATION_VIDEO_FRAMES`, `KIE_NSFW_CHECKER` — see `.env.example`. With no
`OPENAI_API_KEY` moderation is off, and the server says so when it starts.

---

## Admin panel

`https://<your domain>/admin` — **Influenza Admin**, a single-page app served by this
server (plain ES modules, no build step, no dependencies) that calls `/api/admin/*`.
It is light only, in the Influenza app's own palette (a navy frame, the app's violet for
what can be pressed, white cards), set in one typeface (Inter, served from `admin-panel/fonts/`);
the name is set once in `admin-panel/lib/brand.js`. Pages:
Overview, Accounts, Generations, Moderation, Credits, Pricing, Audit log, Settings. Where you are and
what you filtered by live in the address (`#/users?q=mia&status=suspended`,
`#/moderation/<id>`), so a link can be sent to a colleague and Back/Forward work.

- **Who.** An account whose `users.role` is `admin`, checked against the database
  on every request (so demoting someone takes effect at once). **The first admin is
  made on the server** with `db/create-admin.js` — it creates the account (confirmed,
  active, administrator) or promotes an existing one, and writes it to the audit log. The
  password goes through a pipe, so it is never in the command line, `ps` or the shell history:
  ```bash
  cd ~/ai-influencer/backend
  read -rp "Email: " E; read -rsp "Password: " P; echo
  printf '%s\n%s\n' "$E" "$P" | docker compose exec -T api node db/create-admin.js
  unset E P
  ```
  (An empty second line keeps an existing account's password.) Alternatively `ADMIN_EMAILS`
  (comma separated; applied at start, only for existing accounts with a confirmed email, and
  ignored while `REQUIRE_EMAIL_CONFIRMATION=false`) or SQL:
  `update users set role = 'admin' where lower(email) = 'you@example.com';`
  Removing an address from the list does not demote anyone; do that in the panel.
- **Administrators and app users sign in to different places.** An administrator account
  signs in to the panel (the panel sends `scope: 'admin'` to `/api/auth/login`) and gets an
  *admin session*, which works on `/api/admin/*` and nowhere in the app; at the app's own
  sign-in it is refused (`403 ADMIN_ACCOUNT`, after the right password). Every other account
  signs in to the app and gets an *app session*; at the panel it is refused
  (`403 NOT_ADMIN`). A session keeps its scope through every refresh (`sessions.scope`,
  migration 008), and the pairing with the role is checked on every call: promoting an
  account signs its phone out of the app on the next call, demoting one stops its panel
  session. Staff who need to try the app use a second, ordinary account. The profile
  endpoints (`/api/auth/me`, change password) take either kind, so an administrator can
  change their own password. Sessions that existed before migration 008 are app sessions,
  so each administrator signs in to the panel once more after it ships.
- **What.**
  - *Overview* — what needs attention first (store purchases that did not become credits,
    moderation off or without a key, items waiting, a high failure rate, models in use
    without a price, callbacks off), then two rows of figures — the platform (accounts,
    generations running and started, items to review) and the credits (bought, spent, held,
    what KIE charged) — and KIE cost per day and per model for the last 7, 30 or 90 whole
    UTC days. Every figure says what it counts.
  - *Accounts* — search by email or name, filter, sort (by credits too), page; each row shows
    the credits the account holds; a side panel per account (credits and their history,
    strikes against the limit, devices, files, recent generations and flags); suspend (with
    a reason), restore, make/remove admin, give or take back credits, delete (the account's
    email must be typed).
  - *Generations* (`#/jobs`) — every generation with its status, model (the name given on the
    Pricing page, with the id under it), what the person was charged in credits (net of a
    refund) and what KIE charged us. Read-only.
  - *Moderation* — the queue with live counts; one item at a time with the scores
    against the review/refuse lines; the file stays hidden until *Reveal*, which is
    recorded; dismiss or confirm (optionally delete the file and/or suspend the
    owner); deciding moves to the next item. `j`/`k` move through the list.
  - *Credits* — what people bought and spent in the last 7, 30 or 90 days, what they hold
    now, what KIE charged meanwhile, and the packs sold (live or test); below, two lists: every
    change to every balance, and every message the store (RevenueCat) sent with what became of
    it. A purchase that should have become credits and did not (an unknown account, a product
    we do not sell, a test purchase while those are off) is marked in red and counted on the
    tab, on the sidebar and on the overview.
  - *Pricing* (`#/prices`) — credits per model and an on/off switch that is enforced at once;
    turning a model off asks first. Says whether charging is on. Models used without a price
    are listed (a price kept for one mode of a model, `<model>:<mode>`, prices the model).
  - *Audit log* — filter by family of action and by admin. Append-only.
  - *Settings* — how moderation and KIE are configured. Read-only.
- **Safety.** Every admin action is written to `admin_audit_log` in the same
  transaction as the action — if the entry cannot be written, the action does not
  happen. Role changes take turns and the person making one must still be an admin
  when it runs, so two admins demoting each other cannot leave nobody. Viewing a
  user's file is logged. The page's Content-Security-Policy forbids inline script,
  inline style and framing; the panel never inserts server data as HTML; it keeps
  nothing that outlives the tab (no `localStorage`, no cookie): the access token lives in
  memory and the refresh token in the tab's `sessionStorage` (so a reload does not sign out;
  closing the tab does), so there is no CSRF. Tests enforce all of that over every panel file.
- **Where the panel lives.** In the repository's `admin-panel/` folder, beside `backend/`. The
  server looks there, or at `ADMIN_UI_DIR`; in Docker, `docker-compose.yml` mounts the folder
  read-only at `/admin-panel`. Without it the server still starts, logs a warning, and answers
  `/admin` with `404 ADMIN_UI_MISSING`. A panel-only change deploys with `git pull` and
  `docker compose restart api` — no image rebuild (files are read once in production).
- **Adding a file to the panel.** The panel is served from a fixed list
  (`PANEL_FILES` in `api/admin/ui.js`); a test fails if `admin-panel/` and the list disagree.
  The typeface (`fonts/inter-latin.woff2`, SIL Open Font License, licence beside it) is on that
  list too, and the page's policy allows fonts from this origin only (`font-src 'self'`).
- **Not private by itself.** Nothing stops the internet reaching `/admin`; the
  login does. For more, restrict it in the `Caddyfile` (a commented example is there).

### What KIE charged

When a job settles, KIE's `creditsConsumed` (from `recordInfo` or the callback) is
stored on the job (`generation_jobs.kie_credits`; `0` for a failed task, null when
KIE did not say). It is the studio's cost: the app never sees it — it is removed from
`/api/jobs/sync` and from the `/api/kie` proxy's status answers, as the account
balance is. Prices set in the admin panel are recorded, not yet charged — billing is
a separate piece of work.

The server also decides `callBackUrl` and `nsfw_checker` itself: anything the client
sends for either is dropped, so a request cannot point KIE's callback somewhere else
or switch KIE's filter off.

---

## Credits

Users buy packs of credits and every generation spends the model's price — KIE's own
model: prepaid, taken only for work that succeeds, and credits never expire. Purchases
reach us from **RevenueCat**; nothing here talks to Google Play or the App Store.

```
app ──buys a pack──► RevenueCat ──POST /webhooks/revenuecat──► ledger (credit_ledger)
app ──createTask──► /api/kie ──gate: take the price──► KIE ──job fails──► price given back
```

- **The ledger** (`credit_ledger`, migration 005): one row per change; a balance is the
  sum of an account's rows, never stored. Kinds: `purchase`, `grant`/`adjust` (an admin),
  `spend`, `refund`, `clawback` (a refunded purchase). Every row has an idempotency
  `ref`, so a repeated webhook, sync or sweep changes nothing.
- **The price** of a request is the model's row in `model_prices` (admin panel → Prices):
  `credits` per video, per image, or per second of `input.duration`. A row with
  `credits = 0` is a free model.
- **The gate** (`api/_lib/billing.js`, called by `api/kie.js` after moderation) takes the price
  *before* KIE is asked, under a per-account lock, so concurrent requests cannot spend the
  same credits twice. It is given back at once if KIE refuses or never answers, when the job
  fails (KIE's own filter included — those cost the user nothing), when the worker times a
  job out, and by the worker's sweep for a spend that never got an answer.
- **Packs** (`credit_packs`): which store product is worth how many credits. The packs on sale are
  `credits_5000` ($20), `credits_10000` ($35) and `credits_20000` ($70) (migration 010; the dollar
  prices are set in Google Play, never here); `credits_500` and `credits_1500` are the Test Store's
  leftovers. A product that is not listed, or is disabled, is never credited. To add a pack: create
  the product in Play Console and RevenueCat with an id like `credits_<n>`, then
  `insert into credit_packs (product_id, credits, label) values ('credits_<n>', <n>, '<n> credits');`
  — the app picks it up with no new build.
- **The webhook** (`api/revenuecat-webhook.js`): authenticated by the `Authorization` header
  matching `REVENUECAT_WEBHOOK_AUTH` (unset = it refuses everything). `NON_RENEWING_PURCHASE`
  credits the pack once per *store transaction*; `CANCELLATION` takes a refunded purchase's
  credits back (the balance may go below zero, which blocks spending until it is made good).
  Everything else is recorded in `billing_events` and ignored. One delivery = one transaction.
- **The app** reads `GET /api/billing/me` → `{ balance, enforced, prices, packs }`. Not
  enough credits is `402 INSUFFICIENT_CREDITS` (`balance`, `price` in the body).
- **The admin** (account panel → Credits) sees the balance and history and can add or
  remove credits with a reason (audited); Settings shows whether charging is on.

### Switching it on

| Variable | Meaning |
|---|---|
| `BILLING_ENFORCED` | Exactly `true` charges and refuses. Anything else is **shadow mode**: nothing is taken, nobody is stopped, and the log says `[billing] shadow: … would be refused`. |
| `REVENUECAT_WEBHOOK_AUTH` | The `Authorization` value set on RevenueCat's webhook. Keep it in the server's secret store. |
| `REVENUECAT_ACCEPT_SANDBOX` | Default `true`: RevenueCat test purchases are credited. Set `false` when real sales start. |

Before enforcing: price **every** model in use (an unpriced model is refused once enforced —
the overview lists them); read the shadow log for a week; give the accounts that must keep
working (reviewers, staff) credits from the panel.

### Not done yet

- RevenueCat recommends confirming a webhook through its REST API (`GET /v1/subscribers/…`);
  today the shared secret is the proof. Add it with the first real sandbox purchase.
- One price per model: a model whose KIE cost depends on resolution has one number (use the
  admin price list to set what you charge; each job's real KIE cost is on the job).
- A result removed by our own moderation after it was paid for is not refunded.
- No subscriptions, no iOS products.

---

## Security model

**Who is calling, and as what.** The caller never says who they are.

- **The database is only reachable by the backend.** The app calls the API and
  never connects to Postgres, so there is no Row Level Security. Instead, **every
  query on user data carries the user id from the verified session** — never an
  id from the request. Keep it that way in every new endpoint.
- **Passwords** are Argon2id hashes (`api/_lib/passwords.js`), never logged. A
  password is 10–128 characters with a letter and a number, and the commonest
  passwords are refused; one longer than that is refused before it is hashed.
- **Sessions** are random access and refresh tokens, stored only as SHA-256
  hashes and checked against the database on every call, so signing out,
  password changes and account deletion take effect immediately. Refresh tokens
  rotate on every use; an old one replayed after a 30-second grace period ends
  the session (`api/_lib/sessions.js`). An app session's refresh token lasts 30
  days from its last use, an admin session's 12 hours (`ADMIN_REFRESH_TOKEN_TTL_SECONDS`).
- **The app and the admin panel are different places.** A session has a scope,
  `app` or `admin`, fixed at sign-in and kept through every refresh. An
  administrator's account signs in to the panel and is refused at the app's
  sign-in (`ADMIN_ACCOUNT`); every other account signs in to the app and is
  refused at the panel (`NOT_ADMIN`). An admin token never works on an app
  endpoint and an app token never on `/api/admin/*`; only the endpoints about the
  caller's own profile and password take either. The role is read from the
  database on every call, and changing it ends the sessions of the place the
  account can no longer use.
- **Sign-in never says which half was wrong.** Failures are identical and take
  the same time either way; forgot-password and resend always answer "sent".
  **Sign-up does say when the address is taken** (`409 EMAIL_TAKEN`, "An account
  with this email already exists. Please sign in instead.") and the app shows it
  on the form — answering "check your email" and mailing the owner instead left
  people waiting on a screen that explained nothing. An address that signed up
  but never confirmed gets its confirmation again, not an error. Sign-up is
  limited per caller (20 an hour), which is what stops it being a cheap way to
  list registered addresses. The confirmation email never repeats anything typed
  beside the recipient's address (a name), so it cannot be used to put words into
  a message that arrives from our address.

**Rate limits** (in memory, per API process — `lib/rateLimit.js`). Sign-in is
limited three ways, so that guessing one account's password is stopped without
letting an attacker lock the real owner out: by caller address, by address and
account together, and by account alone at a high ceiling. Sign-up, the emails the
API sends, refreshes, password checks (change password, delete account), the pages
the email links open, the two webhooks and the generation proxy have their own
limits. On top of those, every signed-in route shares one ceiling per account: 150
calls in ten seconds and 600 in a minute (`USER_REQUESTS_PER_10S`,
`USER_REQUESTS_PER_MINUTE`), several times what the app does on its busiest screen,
so that a script holding an account cannot write rows as fast as the database
allows. An account may hold 100 influencers (`MAX_INFLUENCERS_PER_USER`), and each
text field of an influencer has its own length ceiling (`TEXT_LIMITS` in
`api/influencers/index.js`). Several API containers would each count separately; at that point move the
store to Postgres or Redis.

**What a request may carry** (`server/index.js`, `api/_lib/requestInput.js`). Body size
limits by kind of route — 16 KB for sign-in and the email pages, 256 KB for the
webhooks, 10 MB for the generation proxy (a file travels through it as base64), 1 MB
for everything else — are applied before any handler or guard runs, and a request that
carries a body to anything under `/api` except the sign-in family is answered 401
*before its body is read* unless it comes with a valid session (`requireSessionBeforeBody`
in `api/_lib/auth.js`) — otherwise the 10 MB allowance of the proxy would be open to
anyone on the internet. A NUL character
anywhere in a body or query string is a 400 (the database cannot store one), a body
nested absurdly deep is a 400, and a lone surrogate (half an emoji, which JSON allows
and a jsonb column refuses) is mended into U+FFFD. Every id is checked to be a UUID
before it reaches SQL, a number is a number, and a page size or time from a query
string is parsed, not passed on. Column names in generated SQL come from fixed lists,
never from a request. An error the caller caused is a 4xx with `{ error, code }`; the
tests send every field of every endpoint every awkward value and expect nothing else.

**Authorization of objects.**

- **Files** are in a private bucket and handed out as short-lived presigned URLs
  after an ownership check. Upload URLs are signed for the exact file size.
- **A KIE task id is a bearer secret** — KIE answers for every task of the studio's
  one key. The proxy records which account started each task (`task_owners`,
  `api/_lib/taskOwners.js`), and registering, syncing or asking KIE about a task of
  another account is refused (`TASK_NOT_YOURS`); a callback finds its job through
  that owner. A task from before the table existed, with nobody recorded, keeps
  working for the account that registered it.
- **Generated results** are fetched only from KIE's CDNs over https, with no name and
  password in the address and every redirect hop re-checked (`api/_lib/results.js`).
  Video frames are read by ffmpeg with the container forced and every protocol but
  `file` forbidden (`api/_lib/moderation/frames.js`).
- **Only the server writes a job's state and result link**, from KIE's own
  answer (`api/_lib/kieStatus.js`), and credits are only ever added by the server
  (a verified store webhook, or an administrator's audited grant).
- **Every generation request is checked before it is paid for**, and a suspended
  account is signed out everywhere and refused at sign-in (`api/_lib/suspension.js`).
- **Every change an administrator makes is audited**, with who made it; an action that
  could not be audited does not happen. `test/integration/security-admin.test.js`
  fails when an admin write route is added without an entry in the log.

**The two doors without a session** prove the sender instead: KIE's callback with
an HMAC over the task and the moment (a wrong, missing or stale one is refused, and a
signed one still gets its owner and its result links from our own records), and
RevenueCat's with a shared secret compared in constant time. What a purchase is worth
comes from the price table, never from the delivery.

**What goes out.** Everything under `/api` answers `Cache-Control: no-store` and
`X-Content-Type-Options: nosniff` unless the endpoint sets something stricter; the
panel's files carry a strict Content-Security-Policy (nothing inline, nothing from
outside), HSTS, frame and referrer protection, and the pages the emails link to are
locked down the same way. The panel builds its pages from text nodes only — nothing it
shows (a prompt, a name) is ever read as markup. No response carries a password hash, a
token or a key the server holds; `security-admin.test.js` scans every GET for them.

**Known limits.** There is no second factor for administrators — put `/admin` and
`/api/admin/*` behind an address allow-list in Caddy (see the Caddyfile) if the staff
have fixed addresses. KIE's callback signature covers the task and the moment, not the
body (that is KIE's scheme), so a copied signed callback could be replayed for 15
minutes; what it can do is limited to settling a job that is still running, with
results only from KIE's hosts. Rate limits are per process. A refund that arrives
before the purchase it refunds is ignored (RevenueCat retries make this rare).

---

## Email — SMTP

Two emails: **confirm your email** and **reset your password**. Both are sent
from this server over SMTP (`api/_lib/email.js`) and carry a one-time link to a
page this server renders (`api/auth/pages.js`):

| Link | Page |
|---|---|
| `/auth/confirm-email?token=…` | "Verify email" button → verified |
| `/auth/reset-password?token=…` | new-password form → changed, every device signed out |

Opening a link does not use it up — only pressing the button does, because mail
scanners open every link in an email as it arrives. Links are https pages, not
`aiinfluencer://` links, because mail clients strip custom schemes and a page
also works on a computer.

**Setup:** four values in `.env`, plus `PUBLIC_BASE_URL` (the links point there).

| | |
|---|---|
| `SMTP_HOST` | e.g. `smtp.gmail.com`, or your host's mail server |
| `SMTP_PORT` | `465` (TLS immediately) or `587` (STARTTLS). `SMTP_SECURE` follows from this and rarely needs setting. |
| `SMTP_USER` | the full mailbox address |
| `SMTP_PASS` | the mailbox password — for Gmail, an **app password** |
| `EMAIL_FROM` | optional; defaults to `SMTP_USER` |

**Gmail:** turn on 2-step verification, then create an app password at
<https://myaccount.google.com/apppasswords> and use that as `SMTP_PASS` — the
account password will not work. Leave `EMAIL_FROM` unset: Gmail requires the
From address to be the mailbox that signed in.

Two limits worth knowing before real users: a free Gmail account caps at roughly
**500 messages a day**, and mail from `@gmail.com` is more likely to be filtered
than mail from a domain you have authenticated (SPF/DKIM). For anything beyond
early testing, move `SMTP_*` to a mailbox on your own domain or a transactional
provider — it is four environment variables, not a code change.

No link is rewritten. A provider's click tracking would route one-time
verification and reset tokens through a third party's redirector, which leaks the
token and breaks the link when the tracker expires.

**Locally**, with `SMTP_*` unset, emails are written to the API's log instead of
sent — the link is right there to open. In production missing settings are an
error, not a silent skip.

---

## Deploying to an Ubuntu server (AWS EC2)

### 1. The server

- EC2 → Launch instance: **Ubuntu 24.04**, **t3.small** (2 GB) or larger, 30 GB
  disk, same region as the S3 bucket.
- Security group: **22** from your IP only; **80** and **443** from anywhere.
- Allocate an **Elastic IP** and attach it, then point `api.your-domain.com` at
  it. Caddy needs the domain to resolve before it can get a certificate.

### 2. Docker

```bash
sudo apt update && sudo apt install -y docker.io docker-compose-v2 git && sudo usermod -aG docker ubuntu
```

Log out and back in so the group change applies.

### 3. Only these folders

`backend/` is the server; `admin-panel/` is the staff page it serves at `/admin`.

```bash
git clone --filter=blob:none --sparse -b aws-postgres https://github.com/<owner>/ai-influencer.git && cd ai-influencer && git sparse-checkout set backend admin-panel && cd backend
```

### 4. Configure

```bash
cp .env.example .env && nano .env
```

- `POSTGRES_PASSWORD` — letters and digits only: `openssl rand -hex 32`
- `PUBLIC_BASE_URL`, SMTP, S3 and KIE values — see the comments in the file

Edit `Caddyfile` and replace `api.example.com` with your domain.

### 5. Start

```bash
docker compose up -d --build
```

### 6. Check

```bash
curl https://api.your-domain.com/health
docker compose ps
docker compose logs -f api worker
```

`/health` answers `{"ok":true}`. An API endpoint answering
`401 {"code":"NOT_AUTHENTICATED"}` without a token is the auth boundary working.

Then set `EXPO_PUBLIC_API_BASE=https://api.your-domain.com` for the app.

### Updating

```bash
git pull && docker compose up -d --build
```

New migrations in `db/migrations/` are applied when the API restarts. **Never
edit a migration that has already been applied** — add a new file.

---

## Backups

The `backup` container writes a `pg_dump` to `s3://$S3_BUCKET/backups/` every
`BACKUP_INTERVAL_SECONDS` (default a day). It never deletes old dumps: in the
S3 console add a **lifecycle rule** on the `backups/` prefix to expire them after
30 days or so.

Restore, from this folder on the server:

```bash
aws s3 cp s3://BUCKET/backups/db-<time>.dump ./restore.dump && docker compose exec -T postgres pg_restore --clean --if-exists -U app -d app < restore.dump
```

Test a restore at least once before you need one.

**Moving to AWS RDS later** is a configuration change: create the RDS instance,
restore a dump into it, set `DATABASE_URL` in `.env`, and remove the `postgres`
service from `docker-compose.yml`.

---

## Running locally

Needs Node 20+ and a PostgreSQL database.

```bash
npm install
DATABASE_URL=postgres://user:pass@localhost:5432/app npm start
```

In a second terminal, for the job collector:

```bash
DATABASE_URL=postgres://user:pass@localhost:5432/app npm run worker
```

The API applies migrations on start (`npm run migrate` does it on its own). From
the Android emulator it is reachable at `http://10.0.2.2:8080`.

`S3_ENDPOINT`, `KIE_BASE_URL`, `KIE_FILE_BASE_URL` and `OPENAI_BASE_URL` exist only
to point at S3-compatible storage or local stand-ins in tests; production leaves
them unset.

### Tests

```bash
npm install
npm test
```

Unit tests plus integration tests that run the real app against a real PostgreSQL
(PGlite, embedded — no database to install) with local stand-ins for S3, KIE and
OpenAI. Nothing reaches the internet and no credential is used. The frame tests
use your own ffmpeg and skip (saying so) if it is not installed. The full run takes
a few minutes (each integration file starts its own database).

- `test/unit/` — policy, inputs, classifier client, frames, small helpers.
- `test/integration/` — the proxy gate, results, credits, the admin API
  (`admin`, `admin-depth`), moderation and sessions under load and at their edges
  (`moderation-depth`), the proxy and suggestions (`proxy-depth`), migrations, and
  `fuzz` (every admin parameter and field against hostile values).
- The security suites: `security-routes` (who may call every route the app registers —
  read from the real app, so a new route is covered the day it is added), `session-scope`
  (app and panel are separate places), `security-auth` (tokens, passwords, enumeration,
  brute force, the one-time links, hostile sign-up input), `security-authz` (one account
  against another's data, task ownership), `security-input` (every field of every
  endpoint against hostile values, SSRF, uploads), `security-admin` (audit
  completeness, roles, no secret in any answer) and `security-webhooks`.
- The admin panel's own tests (every page, every action and what it sends, in a simulated
  browser) live with it: `cd ../admin-panel && npm install && npm test`. What needs both
  sides — that the panel's labels cover the server's moderation categories and its price
  form follows the server's rules — is `test/integration/admin-panel-contract.test.js`. The
  tests here that read the panel's files skip, saying so, if `admin-panel/` is not checked out.

To try a change by hand, run a server against a throwaway database and open
`/admin`; in development the panel files are read from disk on every request, so an
edit shows on reload.

---

## Endpoints

| Area | Endpoints |
|---|---|
| Accounts | `POST /api/auth/signup` `login` `refresh` `logout` `change-password` `forgot-password` `resend-confirmation`; `GET/POST /api/auth/me`; `POST /api/account/delete` |
| Email pages | `GET/POST /auth/confirm-email`, `GET/POST /auth/reset-password` |
| Influencers | `GET /api/influencers`; `POST /api/influencers/create` `update` `delete` |
| Gallery | `GET /api/generations/by-asset` `by-influencer`; `POST /api/generations/add` `delete` |
| Queue | `GET /api/jobs` `by-task` `active-count` `changes` `sync`; `POST /api/jobs/register` `remove` `clear-settled` |

`GET /api/jobs?active=1` returns only the running jobs (the app's half-minute sync asks for exactly those). `GET /api/jobs/changes` is what every open app polls: quick (5 s) while a job is running or just changed, 30 s when idle, and not at all while the app is in the background — the pacing is the app's (`mobile/core/data/pollPacer.js`); the server's part is keeping each answer to two queries.
| Settings | `GET/POST /api/studio-settings`; `GET /api/creation-params` |
| Files | `POST /api/storage/upload-url` `confirm` `download-url` `ingest` `delete` |
| Generation | `/api/kie/*` (proxy), `POST /api/prompt-assist` |
| Reporting | `POST /api/reports` |
| Admin | `/admin` (the page and its files); `GET /api/admin/stats` `usage?days=` `audit?action=&admin=` `config` `users?q=&status=&sort=&dir=` `users/detail?userId=` `jobs` `moderation?status=&source=&action=&userId=` `moderation/item?eventId=` `moderation/media?eventId=` `prices` `billing/summary?days=` `billing/activity?kind=&q=&userId=` `billing/store-events?outcome=&problems=` `billing/ledger?userId=`; `POST /api/admin/users/suspend` `unsuspend` `set-role` `delete`, `moderation/resolve`, `prices/upsert` `delete`, `billing/grant` |
| Callbacks | `POST /webhooks/kie` (signed by KIE, no session), `POST /webhooks/revenuecat` (shared secret, no session) |

---

## What lives on this server

The **database**, the **AWS keys** and the **mailbox and KIE credentials**. Anything
that gets onto this box can read every user's data. Keep it patched
(`unattended-upgrades`), SSH on keys only, and install nothing that does not need
to be there.
