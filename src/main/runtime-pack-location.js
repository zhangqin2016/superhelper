"use strict";

const fs = require("node:fs");
const path = require("node:path");

function config() {
  return require("./config");
}

function locationPayload() {
  const cfg = config();
  const root = cfg.runtimePackBaseDir();
  const legacyRoot = cfg.legacyRuntimePackBaseDir();
  return {
    ok: true,
    root,
    packsRoot: cfg.runtimePackPacksRoot(),
    statePath: cfg.runtimePackStatePath(),
    legacyRoot,
    legacyPacksRoot: cfg.legacyRuntimePackPacksRoot(),
    legacyStatePath: cfg.legacyRuntimePackStatePath(),
    fallbackRoots: cfg.runtimePackFallbackBaseDirs(),
    pointerPath: cfg.runtimePackRootConfigPath(),
    messageDbPath: cfg.messageDbPath(),
    isDefault: path.resolve(root) === path.resolve(legacyRoot),
    envLocked: Boolean(process.env.LILY_RUNTIME_PACK_ROOT),
  };
}

function getRuntimePackLocation() {
  return locationPayload();
}

function assertWritableDirectory(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const probe = path.join(dir, `.lily-runtime-pack-root-${process.pid}-${Date.now()}.tmp`);
  fs.writeFileSync(probe, "ok", "utf8");
  fs.rmSync(probe, { force: true });
}

function setRuntimePackLocation(root) {
  if (process.env.LILY_RUNTIME_PACK_ROOT) {
    return { ...locationPayload(), ok: false, error: "RUNTIME_PACK_ROOT_ENV_LOCKED" };
  }
  const value = String(root || "").trim();
  if (!value) return { ok: false, error: "INVALID_RUNTIME_PACK_ROOT" };
  const resolved = path.resolve(value);
  try {
    assertWritableDirectory(resolved);
    const cfg = config();
    const current = locationPayload();
    const fallbackRoots = [
      current.root,
      ...current.fallbackRoots,
    ]
      .map((item) => path.resolve(item))
      .filter((item) => item !== resolved)
      .filter((item) => item !== path.resolve(current.legacyRoot))
      .filter((item, index, list) => list.indexOf(item) === index);
    fs.mkdirSync(path.dirname(cfg.runtimePackRootConfigPath()), { recursive: true });
    fs.writeFileSync(
      cfg.runtimePackRootConfigPath(),
      `${JSON.stringify({ root: resolved, fallbackRoots, updatedAt: new Date().toISOString() }, null, 2)}\n`,
      "utf8",
    );
    return locationPayload();
  } catch (err) {
    return { ok: false, error: err?.message || "RUNTIME_PACK_ROOT_NOT_WRITABLE" };
  }
}

function resetRuntimePackLocation() {
  if (process.env.LILY_RUNTIME_PACK_ROOT) {
    return { ...locationPayload(), ok: false, error: "RUNTIME_PACK_ROOT_ENV_LOCKED" };
  }
  try {
    const cfg = config();
    const current = locationPayload();
    const fallbackRoots = [
      current.root,
      ...current.fallbackRoots,
    ]
      .map((item) => path.resolve(item))
      .filter((item) => item !== path.resolve(current.legacyRoot))
      .filter((item, index, list) => list.indexOf(item) === index);
    if (fallbackRoots.length) {
      fs.mkdirSync(path.dirname(cfg.runtimePackRootConfigPath()), { recursive: true });
      fs.writeFileSync(
        cfg.runtimePackRootConfigPath(),
        `${JSON.stringify({ fallbackRoots, updatedAt: new Date().toISOString() }, null, 2)}\n`,
        "utf8",
      );
    } else {
      fs.rmSync(cfg.runtimePackRootConfigPath(), { force: true });
    }
    return locationPayload();
  } catch (err) {
    return { ok: false, error: err?.message || "RUNTIME_PACK_ROOT_RESET_FAILED" };
  }
}

module.exports = {
  getRuntimePackLocation,
  resetRuntimePackLocation,
  setRuntimePackLocation,
};
