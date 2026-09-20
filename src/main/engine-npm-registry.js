"use strict";

/**
 * The npm registry the engine's own installs go to.
 *
 * OpenCode installs on demand — node-based language servers (pyright,
 * tsserver) via its embedded arborist, and plugin SDK packages via bun at the
 * first session of a fresh profile — and both honour `npm_config_registry`.
 * registry.npmjs.org is slow or blocked for our users, so the default is a
 * China-reachable mirror. Measured 2026-09-20 on a fresh profile: the first
 * session create hung on registry.npmjs.org for 8–30+ s (2 of 5 runs past the
 * 30 s request timeout) and completed in seconds on the mirror.
 *
 * One seam: the app's runner and every harness that starts the engine with its
 * own env go through here, so no caller can forget the mirror again.
 *   - respects a registry the user already set (env or process env)
 *   - overridable via LILY_NPM_REGISTRY, disabled with LILY_NPM_REGISTRY=off
 */
const DEFAULT_ENGINE_NPM_REGISTRY = "https://registry.npmmirror.com";

function applyEngineNpmRegistry(env, processEnv = process.env) {
  const registry = processEnv.LILY_NPM_REGISTRY || DEFAULT_ENGINE_NPM_REGISTRY;
  if (
    registry !== "off" &&
    !env.npm_config_registry &&
    !processEnv.npm_config_registry &&
    !processEnv.NPM_CONFIG_REGISTRY
  ) {
    env.npm_config_registry = registry;
  }
  return env;
}

module.exports = { DEFAULT_ENGINE_NPM_REGISTRY, applyEngineNpmRegistry };
