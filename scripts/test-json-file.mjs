#!/usr/bin/env node
// Every JSON file the app keeps is written atomically, through one module.
//
// Before 2026-09-19 sixty modules wrote `fs.writeFileSync(file, JSON.stringify(…))`
// directly and fourteen defined their own writeJson; none of the plain ones was
// atomic, so a crash mid-write left a truncated file that read back as `{}` —
// the session index was lost that way once. Thirteen more modules each
// hand-rolled a temp+rename dance. json-file.js is now the one implementation,
// and this test scans src/main for a second one. [gate: json-file-atomic-write]
// Run: node scripts/test-json-file.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const jsonFile = require("../src/main/json-file.js");

let checks = 0;
function check(name, fn) { fn(); checks += 1; console.log(`ok - ${name}`); }

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "json-file-"));
try {
  check("a write lands whole: the target is either the old content or the new, never a prefix", () => {
    const file = path.join(dir, "nested", "state.json");
    jsonFile.writeJson(file, { generation: 1, big: "x".repeat(200_000) });
    const before = fs.readFileSync(file, "utf8");
    // Fail the write half-way: the target must be untouched and no temp remains.
    const original = fs.writeFileSync;
    fs.writeFileSync = () => { throw new Error("disk full"); };
    try {
      assert.throws(() => jsonFile.writeJson(file, { generation: 2 }), /disk full/);
    } finally {
      fs.writeFileSync = original;
    }
    assert.equal(fs.readFileSync(file, "utf8"), before, "the previous content survives a failed write");
    assert.deepEqual(fs.readdirSync(path.dirname(file)), ["state.json"], "no temporary file is left behind");
    jsonFile.writeJson(file, { generation: 2 });
    assert.equal(jsonFile.readJson(file).generation, 2);
    assert.deepEqual(fs.readdirSync(path.dirname(file)), ["state.json"]);
  });

  check("the bytes are what each caller wrote before: indent, trailing newline, mode", () => {
    const pretty = path.join(dir, "pretty.json");
    jsonFile.writeJson(pretty, { a: 1 });
    assert.equal(fs.readFileSync(pretty, "utf8"), JSON.stringify({ a: 1 }, null, 2));
    const compact = path.join(dir, "compact.json");
    jsonFile.writeJson(compact, { a: 1 }, { indent: 0, newline: true });
    assert.equal(fs.readFileSync(compact, "utf8"), `${JSON.stringify({ a: 1 })}\n`);
    const secret = path.join(dir, "secret.json");
    jsonFile.writeJson(secret, { k: "v" }, { mode: 0o600 });
    if (process.platform !== "win32") assert.equal(fs.statSync(secret).mode & 0o777, 0o600, "a secret file is owner-only");
    assert.equal(jsonFile.serializeJson({ a: 1 }, { newline: true }), `${JSON.stringify({ a: 1 }, null, 2)}\n`);
  });

  check("reading never throws: missing, malformed and wrong-shaped files are the fallback", () => {
    assert.equal(jsonFile.readJson(path.join(dir, "missing.json")), null);
    assert.deepEqual(jsonFile.readJson(path.join(dir, "missing.json"), {}), {});
    const bad = path.join(dir, "bad.json");
    fs.writeFileSync(bad, "{ not json");
    assert.equal(jsonFile.readJson(bad, "fb"), "fb");
    const list = path.join(dir, "list.json");
    fs.writeFileSync(list, "[1,2]");
    assert.deepEqual(jsonFile.readJson(list), [1, 2]);
    assert.deepEqual(jsonFile.readJsonObject(list, { only: "objects" }), { only: "objects" });
  });

  check("a rename that hits a transient Windows lock is retried, a permanent failure is not", () => {
    const file = path.join(dir, "locked.json");
    const original = fs.renameSync;
    let attempts = 0;
    fs.renameSync = (from, to) => { attempts += 1; if (attempts < 3) throw Object.assign(new Error("busy"), { code: "EBUSY" }); return original(from, to); };
    try {
      jsonFile.writeJson(file, { ok: true });
      assert.equal(attempts, 3, "two transient failures, then success");
      fs.renameSync = () => { throw Object.assign(new Error("gone"), { code: "ENOENT" }); };
      assert.throws(() => jsonFile.writeJson(file, { ok: false }), /gone/);
    } finally {
      fs.renameSync = original;
    }
    assert.equal(jsonFile.readJson(file).ok, true, "the failed second write left the first intact");
    assert.deepEqual(fs.readdirSync(dir).filter((n) => n.startsWith(".locked")), [], "and cleaned its temp");
  });

  check("the lock-retry policy is the app's one policy, not a second schedule", () => {
    const retry = require("../src/main/fs-transient-retry.js");
    const src = fs.readFileSync(path.join(ROOT, "src/main/json-file.js"), "utf8");
    assert.match(src, /renameSyncWithRetryOrThrow\(temp, file, renameAttempts\)/, "json-file renames through fs-transient-retry");
    assert.ok(!/new Set\(\["EPERM"/.test(src), "and keeps no code list of its own");
    assert.ok(retry.TRANSIENT_FS_CODES.has("EPERM") && retry.TRANSIENT_FS_CODES.has("EBUSY") && retry.TRANSIENT_FS_CODES.has("ENOTEMPTY"));
    assert.equal(retry.transientBackoffMs(0), 300, "the first wait is long enough for a Windows AV scan, as the session index always used");
    // Exhausting the schedule throws, so a caller that must know is told.
    const original = fs.renameSync;
    fs.renameSync = () => { throw Object.assign(new Error("held"), { code: "EPERM" }); };
    try {
      assert.throws(() => retry.renameSyncWithRetryOrThrow("/nope/a", "/nope/b", 2), /held/);
    } finally {
      fs.renameSync = original;
    }
  });

  check("no module writes a JSON file on its own — json-file.js is the only implementation", () => {
    // Two documented exceptions: a create-only marker (flag "wx", a different
    // contract) and a store that takes an injected fs for Playwright state.
    const allowed = new Set(["src/main/json-file.js", "src/main/store/database-recovery-files.js", "src/main/connector-bridge.js"]);
    const offenders = [];
    const walk = (d) => {
      for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
        const full = path.join(d, entry.name);
        if (entry.isDirectory()) { walk(full); continue; }
        if (!entry.name.endsWith(".js")) continue;
        const rel = path.relative(ROOT, full);
        if (allowed.has(rel)) continue;
        const code = fs.readFileSync(full, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
        // A writeFileSync whose argument list contains JSON.stringify, across lines.
        for (const m of code.matchAll(/writeFileSync\s*\(/g)) {
          let depth = 0; let i = m.index + m[0].length - 1; let end = i;
          for (; end < code.length; end += 1) { if (code[end] === "(") depth += 1; else if (code[end] === ")") { depth -= 1; if (depth === 0) break; } }
          if (/JSON\.stringify/.test(code.slice(i, end))) offenders.push(`${rel}:${code.slice(0, m.index).split("\n").length}`);
        }
        if (/\.renameSync\([^)]*\.tmp/.test(code)) offenders.push(`${rel}: hand-rolled temp+rename`);
      }
    };
    walk(path.join(ROOT, "src/main"));
    assert.deepEqual(offenders, [], `write JSON through json-file.js:\n${offenders.join("\n")}`);
  });

  console.log(`\n${checks} checks passed (json file)`);
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
