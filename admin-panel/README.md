# Admin panel

The staff page of AI Influencer Studio: accounts, generations, the moderation queue, credits
(what people buy and spend, and what the store reported), model pricing, and the audit log. Plain HTML, CSS and JavaScript — **no build step, no framework** —
in its own folder, with its own tests.

It is served by the backend at `https://<your-domain>/admin` and talks to the backend's
`/api/admin/*` endpoints (`backend/api/admin/`). Same origin, so there is no CORS and the page
keeps nothing in the browser: the sign-in lives in memory only.

```
admin-panel/
  index.html  app.css  main.js     the page, its styles, the shell (routing, sign-in gate)
  fonts/                           the typeface (Inter) and its licence
  lib/                             api client, DOM helpers, components, formatting, icons, router
  views/                           one file per screen: overview, users, jobs (Generations), moderation, credits, prices (Pricing), settings, audit, login
  test/                            the panel's tests (node:test + happy-dom)
```

## Who can use it

Only signed-in accounts with the `admin` role. Set `ADMIN_EMAILS` on the server to make the
first one (backend/README.md, "Admin panel"). Everything the panel does is written to the audit log.

## Running it

There is nothing to build. Start the backend (`cd backend && npm start`) and open
`http://localhost:8080/admin`. In development an edit shows on reload; in production the
backend reads each file once, so after an update run `docker compose restart api`.

The backend looks for this folder at `ADMIN_UI_DIR`, or by default at `admin-panel/` next to
`backend/`. In Docker, `backend/docker-compose.yml` mounts it read-only at `/admin-panel`. A server
without the folder starts normally, logs a warning, and answers `/admin` with
`404 ADMIN_UI_MISSING`.

## Deploying a change to the panel only

The panel does not need the API image rebuilt:

```bash
git pull && cd backend && docker compose restart api
```

If the change also needs a new `/api/admin/*` endpoint, deploy the backend first
(`docker compose up -d --build`), then the panel.

**A new file in the panel (a new page, a font) always needs the rebuild.** The list of files the
server hands out (`PANEL_FILES` in `backend/api/admin/ui.js`) lives in the API image, so with only a
restart the new page would answer 404 and the panel, which imports it, would not start. When
`ui.js` or an endpoint changed in the same pull: `git pull && cd backend && docker compose up -d --build`.

On a sparse checkout, include both folders: `git sparse-checkout set backend admin-panel`.

## Rules the panel keeps (and tests enforce)

- Nothing from the server is ever inserted as HTML — text goes in as text (`textContent`), never `innerHTML`.
- Scripts and styles come from this origin only (a strict Content-Security-Policy; no inline script or style).
- Only `lib/api.js` talks to the network; nothing is kept in `localStorage`/`sessionStorage`/cookies.
- The server hands out a fixed list of files (`PANEL_FILES` in `backend/api/admin/ui.js`). **A new
  file in this folder must be added to that list**; a backend test fails if the folder and the list disagree.
- Light theme only; the product's name is `Influenza`. One typeface, served from `fonts/`
  (the page's policy allows fonts from this origin only).
- Every figure and column that is not obvious carries its meaning (a small "i" with the words as
  its tooltip and accessible name), and every code the server sends has words (`lib/format.js`).

## Tests

```bash
cd admin-panel
npm install
npm test
```

The tests run each screen in a simulated browser (happy-dom) against a scripted API. The two
checks that need the server as well (the label tables cover the server's moderation categories; the
price form follows the server's rules) live in `backend/test/integration/admin-panel-contract.test.js`.
