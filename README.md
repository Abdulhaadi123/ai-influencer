# AI Influencer Studio

A local-first web app for building, managing, and generating AI influencers.
React + Vite frontend, KIE.AI for image, video & motion generation. The API
key is configured once on the server — users don't connect any account of
their own. Your data lives in your browser.

Three things it does:

1. **Create an influencer** — describe them, or upload a reference image and
   choose which attributes to copy.
2. **Brand promotion** — product image + influencer + script → a promo video
   with voice.
3. **Motion copy** — give it a video, and your influencer performs that motion.

---

## Setup (no tech experience needed)

You only install one thing — **Antigravity**. Everything else lives inside
it. Just follow these steps in order.

1. **Download the project.** Go to the
   [GitHub page](https://github.com/DaanKieft/ai-influencer), click the green
   **Code** button → **Download ZIP**, then unzip it onto your Desktop.
2. **Install Antigravity.** Search "Antigravity" on Google (or go to
   [antigravity.dev](https://antigravity.dev)) and install it like any app.
3. **Open the project.** In Antigravity, click **File → Open Folder** and pick
   the unzipped folder.
4. **Add Claude.** Click the **Extensions** icon in the left sidebar, search
   **Claude Code**, click **Install**, and sign in with your Anthropic account.
5. **Start it.** Open **Terminal → New Terminal**, type `claude`, press Enter,
   then tell Claude: *"install everything and start the app."*
6. **Open it.** When Claude says it's running, it will show a web address
   (something like `http://localhost:5173` — the number may differ on your
   computer). Open that address in Chrome.
7. **Check the engine.** In the app: **Settings → KIE.AI Engine** should show
   *"Engine ready"*. If it says the key is missing, put your KIE API key in a
   file named `.env` in the project folder as `KIE_API_KEY=your-key-here`,
   then restart the app.

That's it. Stuck on anything? Just ask Claude in the terminal — that's what
it's there for. To change something, tell it: *"change the homepage
headline,"* *"add a new vibe option,"* etc.

---

## Updating

In the terminal, type `claude` and tell it: *"get the latest version."*

Your saved data (influencers, brand deals, inspiration boards) stays in your
browser and survives updates.

---

## Project structure

```
src/
  pages/           Routes: Influencers, Create, Settings
  components/      Reusable UI: Nav, ImageGrid, MasonryGrid, Lightbox,
                   WardrobeDrawer, MotionCopyStudio
  core/            Shared, platform-agnostic layer (ready for React Native)
    config/        generation.js — every model id lives here
    services/      generation/ — the only entry point for AI generation
    prompts/       Prompt builders
    platform/      Web impls of storage / apiUrl / media (RN swaps these)
    store.jsx      App state (React contexts)
  context/         React contexts (theme — web only)
backend/           API, worker, PostgreSQL schema, Docker deployment (see backend/README.md)
docs/              Prompt engineering reference docs
```

---

## Deployment

The mobile app is the product; it talks only to the backend in `backend/`,
which runs with Docker Compose on a server (PostgreSQL, API, worker, daily
backups, HTTPS). See `backend/README.md` for the step-by-step EC2 setup, and
`mobile/SHARING.md` for getting the app onto phones. The web UI in this folder
is kept for reference only.

---

Made by Dan Kieft.
