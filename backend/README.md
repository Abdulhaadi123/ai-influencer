# Backend

The API, the generation worker and the database for AI Influencer Studio.
**Self-contained** — nothing here imports the app or the web UI, and it has its
own `package.json`, so deploying it does not bring React or Expo onto a server.

```
backend/
  api/              the endpoints
    auth/           accounts and the pages email links open
    _lib/           database, sessions, passwords, email, S3, errors
  db/
    migrations/     the schema — applied automatically when the API starts
    migrate.js
  lib/              rate limiting
  server/
    index.js        the API server (Express)
    worker.js       always-on job collector
  backup/           daily database dump to S3
  Dockerfile
  docker-compose.yml
  Caddyfile
```

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

---

## Security model

- **The database is only reachable by the backend.** The app calls the API and
  never connects to Postgres, so there is no Row Level Security. Instead, **every
  query on user data carries the user id from the verified session** — never an
  id from the request. Keep it that way in every new endpoint.
- **Passwords** are Argon2id hashes (`api/_lib/passwords.js`), never logged.
- **Sessions** are random access and refresh tokens, stored only as SHA-256
  hashes and checked against the database on every call, so signing out, "sign
  out everywhere", password changes and account deletion take effect
  immediately. Refresh tokens rotate on every use; an old one replayed after a
  30-second grace period ends the session (`api/_lib/sessions.js`).
- **No response reveals whether an email is registered.** Sign-in failures are
  identical, forgot-password and resend always answer "sent", and those take the
  same time either way.
- **Sign-in, sign-up and email sending are rate limited** by IP and by address
  (in memory, per API process).
- **Files** are in a private bucket and handed out as short-lived presigned URLs
  after an ownership check. Upload URLs are signed for the exact file size.
- **Generated results** are fetched only from KIE's CDNs, with every redirect
  hop re-checked (`api/_lib/results.js`).
- **Only the server writes a job's state and result link**, from KIE's own
  answer (`api/_lib/kieStatus.js`).

---

## Email — SendGrid

Two emails: **confirm your email** and **reset your password**. Both are sent
from this server through the SendGrid API (`api/_lib/email.js`) and carry a
one-time link to a page this server renders (`api/auth/pages.js`):

| Link | Page |
|---|---|
| `/auth/confirm-email?token=…` | "Confirm my email" button → confirmed |
| `/auth/reset-password?token=…` | new-password form → changed, every device signed out |

Opening a link does not use it up — only pressing the button does, because mail
scanners open every link in an email as it arrives. Links are https pages, not
`aiinfluencer://` links, because mail clients strip custom schemes and a page
also works on a computer.

**Setup in SendGrid:**

1. **Settings → Sender Authentication → Authenticate Your Domain.** Add the CNAME
   records it gives you at your DNS provider (on Cloudflare: **DNS only**, grey
   cloud). Without this, emails land in spam. A `@gmail.com` sender will not work.
2. **Settings → API Keys → Create API Key** → *Restricted Access* → **Mail Send:
   Full Access**, everything else off.
3. In `.env`: `SENDGRID_API_KEY`, `EMAIL_FROM=noreply@your-domain.com`, and
   `PUBLIC_BASE_URL=https://api.your-domain.com` (the links point there).

Click and open tracking are turned off per message: click tracking would route
one-time tokens through SendGrid's link redirector.

**Locally**, without a SendGrid key, emails are written to the API's log instead
of sent — the link is right there to open. In production a missing key is an
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

### 3. Only this folder

```bash
git clone --filter=blob:none --sparse -b aws-postgres https://github.com/<owner>/ai-influencer.git && cd ai-influencer && git sparse-checkout set backend && cd backend
```

### 4. Configure

```bash
cp .env.example .env && nano .env
```

- `POSTGRES_PASSWORD` — letters and digits only: `openssl rand -hex 32`
- `PUBLIC_BASE_URL`, SendGrid, S3 and KIE values — see the comments in the file

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

`S3_ENDPOINT` and `KIE_BASE_URL` exist only to point at S3-compatible storage or
local stand-ins in tests; production leaves them unset.

---

## Endpoints

| Area | Endpoints |
|---|---|
| Accounts | `POST /api/auth/signup` `login` `refresh` `logout` `logout-all` `change-password` `forgot-password` `resend-confirmation`; `GET/POST /api/auth/me`; `POST /api/account/delete` |
| Email pages | `GET/POST /auth/confirm-email`, `GET/POST /auth/reset-password` |
| Influencers | `GET /api/influencers`; `POST /api/influencers/create` `update` `delete` |
| Gallery | `GET /api/generations/by-asset`; `POST /api/generations/add` `delete` |
| Queue | `GET /api/jobs` `by-task` `active-count` `changes` `sync`; `POST /api/jobs/register` `remove` `clear-settled` |
| Settings | `GET/POST /api/studio-settings`; `GET /api/creation-params` |
| Files | `POST /api/storage/upload-url` `confirm` `download-url` `ingest` `delete` |
| Generation | `/api/kie/*` (proxy), `POST /api/prompt-assist` |

---

## What lives on this server

The **database**, the **AWS keys** and the **SendGrid and KIE keys**. Anything
that gets onto this box can read every user's data. Keep it patched
(`unattended-upgrades`), SSH on keys only, and install nothing that does not need
to be there.
