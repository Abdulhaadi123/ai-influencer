# Backend

The API and the generation worker. **Self-contained** — nothing here imports
the mobile app or the web UI, and it has its own `package.json`, so deploying
it does not drag React, Vite or Expo onto your server.

```
backend/
  api/          the endpoints (one copy of the logic)
  lib/          rate limiting
  server/
    index.js    Express wrapper — runs the endpoints as a long-lived server
    worker.js   always-on job collector
  Dockerfile
  docker-compose.yml
  Caddyfile
  vercel.json   only for running the API on Vercel instead
```

The endpoints are written as `(req, res)` handlers, which Express and Vercel
both understand. That is deliberate: the logic has exactly one copy, so a fix
applies wherever it runs, and moving between hosts never means a rewrite.

---

## Deploying only this folder

The Docker build context is `backend/`, so the image never contains app or web
code regardless of how you get the files onto the box. Three ways, in order of
how much you care:

### 1. Clone the repo, build from this folder (simplest)

The repo is small — the app is source only, no `node_modules` committed. Just
clone it and ignore the rest.

```bash
git clone <your-repo> ai-influencer
cd ai-influencer/backend
cp .env.example .env && nano .env      # fill in the secrets
docker compose up -d --build
```

Updating is `git pull && docker compose up -d --build`.

### 2. Sparse checkout (only this folder on disk)

If you would rather the server never hold the app source at all:

```bash
git clone --filter=blob:none --sparse <your-repo> ai-influencer
cd ai-influencer
git sparse-checkout set backend
cd backend
```

Same repo, same history, but only `backend/` is materialised on the server.
This is what to use if the box is shared or you want a smaller blast radius.

### 3. A separate repository

Cleanest isolation, most maintenance. Only worth it if the backend gets its own
release cycle or a different set of people work on it. Until then, one repo with
a sparse checkout gives you the same practical result without a second thing to
keep in sync.

### Vercel instead of a server

Import the repo with **Root Directory** set to `backend`; `vercel.json` routes
`/api/kie/*` to the proxy. Set the same variables as `.env.example` in the
project settings. Vercel runs the endpoints but not `server/worker.js`, so
results are collected only while the app is open — see below.

---

## The two processes

`docker compose up -d` starts three containers:

| Container | What it does |
|---|---|
| `api` | Serves `/api/*`. Stateless — scale it horizontally if you ever need to. |
| `worker` | Polls the generator, collects finished results into S3. **Exactly one.** |
| `caddy` | TLS termination with automatic certificates. |

**Do not run two workers.** They would double the request rate against the
generator's per-account limit and race each other to collect the same result.
The `replicas: 1` in `docker-compose.yml` says so; keep it.

### Why the worker matters

Generation is asynchronous and results expire 24 hours after they finish.
Without the worker, the phone is the only thing watching — so closing the app
mid-generation means nothing collects the result, and leaving it a day means the
credits were spent for nothing.

The worker watches every user's jobs continuously, pulls finished results into
their storage, and files them into the gallery. The user opens the app and it is
simply there. This is the main reason to run a server rather than serverless
functions, which only exist while a request is in flight.

It also sweeps jobs the app saw finish but never saved (the user left the
screen), after a three-minute grace period. The app, the Queue tab and the
worker can all collect the same result safely: collection is idempotent
(`api/_lib/results.js`), which relies on the unique index in
`supabase/migrations/0002_collect_results_once.sql` — apply that migration.

---

## Setup

1. **TLS.** Edit `Caddyfile` and replace `api.example.com` with your domain, and
   point the domain's A record at the box first — Caddy needs to answer an ACME
   challenge on port 80 before it can issue a certificate.

2. **Secrets.** `cp .env.example .env` and fill it in. Every value there is a
   real secret; `.env` is gitignored and is mounted into the containers rather
   than baked into the image.

3. **Firewall.** Only 80 and 443 need to be open. The API listens on 8080
   inside the Docker network and should not be reachable from outside — Caddy
   is the only way in.

   ```bash
   ufw allow 22 && ufw allow 80 && ufw allow 443 && ufw enable
   ```

4. **Database.** Run every file in `supabase/migrations/` in order — `0001`,
   `0002`, `0003` — in the Supabase SQL editor. `0002` makes result collection
   safe to race; `0003` stops clients writing storage accounting directly and
   stops Realtime broadcasting deleted rows. A database that already ran `0001`
   still needs `0003`.

5. **Point the app at it.** In `mobile/.env`:

   ```
   EXPO_PUBLIC_API_BASE=https://api.your-domain.com
   ```

   That is the only change the app needs, ever. Moving hosts later is this one
   line.

---

## Email — SendGrid

Auth emails (password reset, email confirmation) are sent by **Supabase**, not
by this backend. Our code calls `supabase.auth.resetPasswordForEmail()` and
Supabase's servers compose and deliver the message.

So SendGrid is wired in **as Supabase's SMTP relay**, configured in the Supabase
dashboard — there is no SMTP client, no API key and no email template in this
repo. That is on purpose: an email path here would be a second place a reset
token could leak, and a second thing to secure, for no gain.

**Supabase → Project Settings → Authentication → SMTP Settings:**

| Field | Value |
|---|---|
| Host | `smtp.sendgrid.net` |
| Port | `587` |
| Username | `apikey` — the literal string, not your key |
| Password | a SendGrid API key restricted to Mail Send |
| Sender email | an address at a domain authenticated in SendGrid |

Then raise **Authentication → Rate Limits → Emails**, which stays at the
free-tier number until it is changed.

**The sender domain is the part that matters.** It must be a domain you own and
have authenticated in SendGrid with the CNAME records it issues, which is what
supplies SPF and DKIM. A `@gmail.com` sender address will be rejected outright
regardless of SendGrid being configured correctly — `gmail.com` publishes a
DMARC policy that forbids anyone else sending as it. Use the same domain the API
runs on.

Without domain authentication, reset emails go to spam and users conclude the
account is broken.

---

## Checking it works

```bash
curl https://api.your-domain.com/health           # {"ok":true}
docker compose logs -f worker                     # cycle logs
docker compose ps                                 # all three up
```

An endpoint that answers `401 {"error":"Sign in to continue."}` without a token
is working correctly — that is the auth boundary doing its job.

A `503` names what is missing, and the full error is in `docker compose logs api`:

| `code` | Meaning |
|---|---|
| `SERVER_NOT_CONFIGURED` | A required variable in `.env` is empty — usually Supabase or `S3_BUCKET` |
| `AUTH_UNAVAILABLE` | The server could not reach Supabase to check a session |
| `STORAGE_UNAVAILABLE` | AWS refused the credentials or the bucket |
| `UPSTREAM_UNAVAILABLE` | A dependency could not be reached at all |
| `ENGINE_KEY_REJECTED` (502) | KIE rejected `KIE_API_KEY` |

---

## A note on what lives on this box

This server holds your **AWS credentials** and your **Supabase service-role
key**. The service-role key bypasses every Row Level Security policy in the
database: anything that gets it can read and write every user's data.

That is the trade for running your own server. Keep the box patched
(`unattended-upgrades`), keep SSH on keys only, and do not install anything on
it that does not need to be there. If you are not going to do that, a managed
platform is genuinely the safer choice.
