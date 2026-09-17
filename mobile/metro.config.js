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
 *
 * There used to be a second rule here that forced the `.native` KIE transport
 * on web, because the web variant routed through a proxy belonging to the old
 * deployment. Both platforms now share a single transport that goes through the
 * authenticated /api/kie proxy, so the override is gone along with the file it
 * pointed at.
 */
const CORE_ALIAS = '@core/'

config.resolver.resolveRequest = (context, moduleName, platform) => {
  // `@core/x/y` -> <project>/core/x/y, resolved as a path so Metro still
  // applies its own extension order and picks `.native.js` over `.js`.
  if (moduleName.startsWith(CORE_ALIAS)) {
    const target = path.join(coreRoot, moduleName.slice(CORE_ALIAS.length))
    return context.resolveRequest(context, target, platform)
  }

  return context.resolveRequest(context, moduleName, platform)
}

module.exports = config
