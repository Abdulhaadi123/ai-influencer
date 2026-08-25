/**
 * ─────────────────────────────────────────────────────────────────────────────
 * Metro configuration — lets the mobile app consume the shared core.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The shared, platform-agnostic code lives OUTSIDE this project, at
 * `../core`, so that the web app and this app run the exact same logic.
 * Metro only watches its own project root by default, so it needs to be told
 * about that folder explicitly.
 *
 * Import it as `@core/...`, e.g. `import { useInfluencers } from '@core/store'`.
 */

const { getDefaultConfig } = require('expo/metro-config')
const path = require('path')

const projectRoot = __dirname
const repoRoot = path.resolve(projectRoot, '..')
const coreRoot = path.resolve(repoRoot, 'core')

const config = getDefaultConfig(projectRoot)

// 1. Watch the shared core so edits there trigger a rebuild.
config.watchFolders = [coreRoot]

// 2. Resolve packages from this app first, then fall back to the repo root.
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(repoRoot, 'node_modules'),
]

// 3. The `@core` alias is handled in resolveRequest below, NOT via
//    extraNodeModules: an `@`-prefixed name is parsed by Metro as a scoped
//    package, so `@core/config/generation` would be read as scope `@core` +
//    package `config`, and the alias would never match.

/**
 * 4. Force a single copy of React / React Native.
 *
 * This matters: the repo root has its own node_modules with React 18 (for the
 * Vite web app), while this app uses the React 19 that React Native requires.
 * Metro resolves from the importing file's directory upward, so a file under
 * ../core would find the ROOT's React 18 — loading two Reacts at once,
 * which breaks hooks with the "invalid hook call" error.
 *
 * Resolving these specific packages as if the request came from this project
 * pins them to the mobile app's copies, wherever the importer lives.
 */
const FORCE_FROM_APP = ['react', 'react-native']

const CORE_ALIAS = '@core/'

/**
 * On `expo start --web` Metro picks the plain `.js` platform files. For the KIE
 * transport that is wrong: `kieTransport.js` routes through a server-side
 * `/api/kie` proxy that belongs to the Vite app, and Expo's web dev server has
 * no such proxy — those requests would hit Expo itself and 404.
 *
 * This app talks to KIE directly on every target it builds for, and KIE sends
 * CORS headers, so the browser can make the same direct calls the phone does.
 * That keeps `expo start --web` usable as a way to try the app.
 *
 * Storage deliberately does NOT get the same treatment — the native store is
 * expo-sqlite, so the browser must keep using the localStorage variant.
 *
 * Matched on the RESOLVED path, not the specifier: core imports the transport
 * relatively, so an alias-only rule would never fire.
 */
const DIRECT_ON_WEB = path.join('platform', 'kieTransport')

function forceDirectTransportOnWeb(target, platform) {
  return platform === 'web' && target.endsWith(DIRECT_ON_WEB)
    ? `${target}.native.js`
    : target
}

config.resolver.resolveRequest = (context, moduleName, platform) => {
  // `@core/x/y` -> <repo>/core/x/y, resolved as a path so that Metro still
  // applies its own extension order and picks `.native.js` over `.js`.
  if (moduleName.startsWith(CORE_ALIAS)) {
    const target = path.join(coreRoot, moduleName.slice(CORE_ALIAS.length))
    return context.resolveRequest(context, forceDirectTransportOnWeb(target, platform), platform)
  }

  // Relative imports from inside core (e.g. kieAuth.js -> '../platform/kieTransport').
  if (platform === 'web' && moduleName.startsWith('.') && context.originModulePath) {
    const abs = path.resolve(path.dirname(context.originModulePath), moduleName)
    if (abs.startsWith(coreRoot) && abs.endsWith(DIRECT_ON_WEB)) {
      return context.resolveRequest(context, `${abs}.native.js`, platform)
    }
  }

  const forced = FORCE_FROM_APP.some(
    p => moduleName === p || moduleName.startsWith(`${p}/`)
  )
  if (forced) {
    return context.resolveRequest(
      { ...context, originModulePath: path.join(projectRoot, 'index.js') },
      moduleName,
      platform
    )
  }

  return context.resolveRequest(context, moduleName, platform)
}

module.exports = config
