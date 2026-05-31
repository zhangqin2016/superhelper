#!/usr/bin/env node
/**
 * uv venv on macOS creates venv/bin/python as an absolute symlink. When the runtime
 * is copied into an .app bundle, codesign --strict fails with:
 *   invalid destination for symbolic link in bundle
 * Rewrite in-tree absolute symlinks to relative paths.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

function walkAll(root) {
  /** @type {string[]} */
  const out = [];
  /** @type {string[]} */
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      out.push(full);
      if (ent.isDirectory() && !ent.isSymbolicLink()) {
        stack.push(full);
      }
    }
  }
  return out;
}

/**
 * @param {string} entry
 * @param {string} target
 * @param {string} absRoot
 * @returns {string | null}
 */
function relativeSymlinkTarget(entry, target, absRoot) {
  const resolved = path.isAbsolute(target)
    ? path.resolve(target)
    : path.resolve(path.dirname(entry), target);

  if (resolved === absRoot || resolved.startsWith(`${absRoot}${path.sep}`)) {
    return path.relative(path.dirname(entry), resolved);
  }

  // uv venv records the absolute build-machine path; remap by runtime/ suffix.
  const marker = `${path.sep}runtime${path.sep}`;
  const idx = resolved.indexOf(marker);
  if (idx !== -1) {
    const suffix = resolved.slice(idx + marker.length);
    const candidate = path.join(absRoot, suffix);
    if (fs.existsSync(candidate)) {
      return path.relative(path.dirname(entry), candidate);
    }
  }

  return null;
}

/**
 * @param {string} runtimeRoot
 * @returns {{ fixed: number, paths: string[] }}
 */
export function relativizeRuntimeSymlinks(runtimeRoot) {
  const absRoot = path.resolve(runtimeRoot);
  if (!fs.existsSync(absRoot)) return { fixed: 0, paths: [] };

  let fixed = 0;
  /** @type {string[]} */
  const paths = [];

  for (const entry of walkAll(absRoot)) {
    let st;
    try {
      st = fs.lstatSync(entry);
    } catch {
      continue;
    }
    if (!st.isSymbolicLink()) continue;

    const target = fs.readlinkSync(entry);
    if (!path.isAbsolute(target)) continue;

    const rel = relativeSymlinkTarget(entry, target, absRoot);
    if (!rel || rel === target) continue;

    fs.unlinkSync(entry);
    fs.symlinkSync(rel, entry);
    fixed += 1;
    paths.push(entry);
  }

  return { fixed, paths };
}

/**
 * @param {string} runtimeRoot
 * @returns {{ link: string, target: string, resolved: string }[]}
 */
export function findExternalRuntimeSymlinks(runtimeRoot) {
  const absRoot = path.resolve(runtimeRoot);
  if (!fs.existsSync(absRoot)) return [];

  /** @type {{ link: string, target: string, resolved: string }[]} */
  const bad = [];

  for (const entry of walkAll(absRoot)) {
    let st;
    try {
      st = fs.lstatSync(entry);
    } catch {
      continue;
    }
    if (!st.isSymbolicLink()) continue;

    const target = fs.readlinkSync(entry);
    const resolved = path.isAbsolute(target)
      ? path.resolve(target)
      : path.resolve(path.dirname(entry), target);

    const inside =
      resolved === absRoot || resolved.startsWith(`${absRoot}${path.sep}`);
    if (inside && !path.isAbsolute(target)) continue;
    if (inside && path.isAbsolute(target)) {
      bad.push({ link: entry, target, resolved });
      continue;
    }
    if (!inside) {
      bad.push({ link: entry, target, resolved });
    }
  }

  return bad;
}

function platformCandidates() {
  if (process.platform === "darwin") {
    if (process.arch === "arm64") return ["darwin-arm64", "darwin-x64"];
    return ["darwin-x64", "darwin-arm64"];
  }
  if (process.platform === "win32") return ["win32-x64"];
  return ["linux-x64"];
}

function parsePlatforms(argv) {
  const platforms = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--platform" && argv[i + 1]) {
      platforms.push(argv[i + 1]);
      i += 1;
    }
  }
  return platforms.length ? platforms : platformCandidates();
}

function main() {
  const platforms = parsePlatforms(process.argv.slice(2));
  let totalFixed = 0;

  for (const platform of platforms) {
    const runtimeRoot = path.join(ROOT, "bundles", platform, "runtime");
    if (!fs.existsSync(runtimeRoot)) continue;

    const { fixed, paths } = relativizeRuntimeSymlinks(runtimeRoot);
    if (fixed > 0) {
      console.log(`[fix-runtime-symlinks] ${platform}: fixed ${fixed} symlink(s)`);
      for (const p of paths) {
        console.log(`  ${path.relative(ROOT, p)} -> ${fs.readlinkSync(p)}`);
      }
      totalFixed += fixed;
    }

    const bad = findExternalRuntimeSymlinks(runtimeRoot);
    if (bad.length) {
      console.error(`[fix-runtime-symlinks] ${platform}: still invalid symlink(s):`);
      for (const item of bad) {
        console.error(`  ${item.link} -> ${item.target}`);
      }
      process.exit(1);
    }
  }

  if (totalFixed === 0) {
    console.log("[fix-runtime-symlinks] ok (nothing to fix)");
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main();
