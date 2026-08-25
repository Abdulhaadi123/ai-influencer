/**
 * ─────────────────────────────────────────────────────────────────────────────
 * Generation service — the single entry point for all AI generation.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * UI and feature code import from HERE only (never from a provider directly).
 *
 * This layer is the React-Native boundary too: everything below is plain
 * `fetch`-based JavaScript (no DOM), so it runs unchanged in a React Native app.
 * The active provider authenticates with a SERVER-SIDE key via the /api backend —
 * never a per-user OAuth popup, which does not exist in React Native.
 *
 * There is a single provider today — KIE — which hosts all of the app's models
 * (image, video, and motion). To add another provider later, create a file under
 * ./providers with the same exports and switch the re-export below; the UI and
 * feature code never change.
 */

export * from './providers/kie'
