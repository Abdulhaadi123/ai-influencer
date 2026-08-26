/**
 * ─────────────────────────────────────────────────────────────────────────────
 * Metro configuration.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The shared, platform-agnostic code lives at `./core`, INSIDE this project.
 *
 * It used to sit outside, at the repo root, which broke EAS Build: `eas build`
 * uploads the project directory, so `../core` simply did not exist in the build
 * container and every `@core/...` import failed to resolve during the Bundle
 * JavaScript phase. Keeping core inside the project makes the app
 * self-contained — Metro watches it automatically, and there is no second
 * node_modules tree to reconcile.
 *
 * Import it as `@core/...`, e.g. `import { useInfluencers } from '@core/store'`.
 */

const { getDefaultConfig } = require('expo/metro-config')
const path = require('path')

const projectRoot = __dirname
const coreRoot = path.resolve(projectRoot, 'core')

const config = getDefaultConfig(projectRoot)

/**
 * The `@core` alias is resolved here rather than through extraNodeModules:
 * an `@`-prefixed name is parsed by Metro as a scoped package, so
 * `@core/config/generation` would be read as scope `@core` + package `config`
 * and the alias would never match.
 */
const CORE_ALIAS = '@core/'

/**
 * On `expo start --web` Metro picks the plain `.js` platform files. For the KIE
 * transport that is wrong: `kieTransport.js` routes through a server-side
 * proxy that belongs to the old web deployment. This app talks to KIE directly
 * on every target it builds for, and KIE sends CORS headers, so the browser can
 * make the same direct calls the phone does.
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
  // `@core/x/y` -> <project>/core/x/y, resolved as a path so Metro still
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

  return context.resolveRequest(context, moduleName, platform)
}

module.exports = config
