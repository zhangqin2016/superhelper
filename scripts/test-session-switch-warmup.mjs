#!/usr/bin/env node
// Switching to a session must not cost the session's whole setup again.
//
// The switch schedules a write-free runner warm-up on the main thread, and the
// warm-up rebuilds three derived things: the session's skill set, its AGENT.md
// and the MCP config. Measured on a real profile (45 skills) before 2026-09-19:
// resolving the skill set read 831 files per call — every bundled manifest was
// re-read for every installed skill — and the two files were rewritten
// (temp + rename) on every switch whether or not anything changed. On macOS
// that was ~50 ms per switch; on Windows, where each open is scanned and each
// rename can hit a transient lock (300 ms backoff), it was seconds.
//
// The rule is kept by construction: manifests are validated by their own
// identity (mtime + size), so no writer has to remember to invalidate; derived
// files are compared before they are replaced. [gate: session-switch-cost]
// Run: node scripts/test-session-switch-warmup.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import module from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const require = module.createRequire(import.meta.url);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lily-switch-warmup-"));

delete process.env.LILY_USER_DATA_DIR;
delete process.env.LILY_HOME;
delete process.env.LILY_SERVICE_API_BASE_URL;
delete process.env.SERVICE_API_BASE_URL;
Object.defineProperty(process, "resourcesPath", { value: ROOT, configurable: true, writable: true });
function stub(file, exports) {
  const filename = path.join(ROOT, file);
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
}
stub("node_modules/electron/index.js", {});
const electronPath = require.resolve("electron");
require.cache[electronPath] = {
  id: electronPath, filename: electronPath, loaded: true,
  exports: { app: { isPackaged: false, getPath: (name) => (name === "userData" ? tmp : os.tmpdir()), getVersion: () => "0.1.0" } },
};
stub("src/main/service-client.js", { getServiceSettings: () => ({ ok: true, apiBaseUrl: "", configurable: false }), reportSkillEvent: () => Promise.resolve({ ok: true, skipped: true }) });
stub("src/main/remote-config.js", { getRemoteEffectiveConfigSync: () => null });

const counts = { readFileSync: 0, writeFileSync: 0, renameSync: 0 };
const writes = [];
for (const name of Object.keys(counts)) {
  const original = fs[name];
  fs[name] = function counted(...args) {
    counts[name] += 1;
    if (name !== "readFileSync") writes.push(`${name}:${String(args[name === "renameSync" ? 1 : 0])}`);
    return original.apply(fs, args);
  };
}
const reset = () => { for (const k of Object.keys(counts)) counts[k] = 0; writes.length = 0; };

const SKILLS = ["alpha-skill", "beta-skill", "gamma-skill"];
const skillsRoot = path.join(tmp, "lily-config", "skills");
const manifestOf = (id, extra = {}) => ({ schemaVersion: 1, id, name: id, version: "1.0.0", description: `${id} does things`, ...extra });
for (const id of SKILLS) {
  const dir = path.join(skillsRoot, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "SKILL.md"), `# ${id}\n`);
  fs.writeFileSync(path.join(dir, "skill.manifest.json"), JSON.stringify(manifestOf(id)));
}
fs.writeFileSync(path.join(tmp, "skills-state.json"), JSON.stringify({
  schemaVersion: 1,
  skills: Object.fromEntries(SKILLS.map((id) => [id, { id, enabled: true, source: "remote", installedVersion: "1.0.0" }])),
}));

const skillManager = require(path.join(ROOT, "src/main/skill-manager.js"));
const skillsState = require(path.join(ROOT, "src/main/skills-state.js"));
const mcpConfig = require(path.join(ROOT, "src/main/mcp-config.js"));
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "lily-switch-ws-"));
const session = { id: "s1", projectId: "p1" };

let checks = 0;
function check(name, fn) { fn(); checks += 1; console.log(`ok - ${name}`); }

try {
  check("resolving a session's skills is stat-validated: the second resolution opens no file", () => {
    const first = skillManager.resolveSessionSkillIds(session).sort();
    for (const id of SKILLS) assert.ok(first.includes(id), `${id} resolved`);
    reset();
    const second = skillManager.resolveSessionSkillIds(session).sort();
    assert.deepEqual(second, first);
    assert.equal(counts.readFileSync, 0, `no manifest is re-read while unchanged (read ${counts.readFileSync})`);
    assert.equal(counts.writeFileSync, 0, "and nothing is written");
  });

  check("a manifest changed on disk is seen on the next read — no writer has to invalidate", () => {
    const file = path.join(skillsRoot, "beta-skill", "skill.manifest.json");
    fs.writeFileSync(file, JSON.stringify(manifestOf("beta-skill", { version: "2.0.0", description: "beta grew a longer description" })));
    assert.equal(skillsState.readInstalledManifest("beta-skill").version, "2.0.0");
    fs.rmSync(path.join(skillsRoot, "gamma-skill"), { recursive: true, force: true });
    assert.equal(skillsState.readInstalledManifest("gamma-skill"), null, "a removed skill is gone at once");
    assert.ok(!skillManager.getAllInstalledSkillIds().includes("gamma-skill"));
  });

  check("a manifest handed out is the caller's own: mutating it never poisons the next read", () => {
    const mine = skillsState.readInstalledManifest("alpha-skill");
    mine.name = "renamed in memory";
    mine.name_i18n = { en: "x" };
    assert.equal(skillsState.readInstalledManifest("alpha-skill").name, "alpha-skill");
    assert.equal(skillsState.readInstalledManifest("alpha-skill").name_i18n, undefined);
  });

  check("bundled defaults are reconciled from versions read once per process, still on every call", () => {
    const state = skillsState.loadSkillsState();
    const mandatory = skillsState.MANDATORY_PLATFORM_SKILL_IDS[0];
    if (state.skills[mandatory]) state.skills[mandatory].enabled = false;
    reset();
    assert.equal(skillsState.isSkillEnabled(mandatory), true, "a mandatory skill cannot be switched off");
    assert.equal(counts.readFileSync, 0, "and re-checking it reads no bundled manifest");
  });

  check("the session guide is written once and then only compared — a restart does not rewrite an identical file", () => {
    reset();
    const configDir = skillManager.writeSessionAgentGuide(session.id, session, workspace);
    const guidePath = path.join(configDir, "AGENT.md");
    assert.ok(fs.existsSync(guidePath));
    const stampBefore = fs.statSync(guidePath).mtimeMs;
    const content = fs.readFileSync(guidePath, "utf8");
    reset();
    skillManager.writeSessionAgentGuide(session.id, session, workspace);
    assert.equal(writes.filter((w) => w.endsWith("AGENT.md")).length, 0, "the in-process signature short-circuits");
    // A restart empties the signature cache; the file on disk does not change.
    for (const file of ["src/main/skill-manager.js"]) delete require.cache[path.join(ROOT, file)];
    const reloaded = require(path.join(ROOT, "src/main/skill-manager.js"));
    reset();
    reloaded.writeSessionAgentGuide(session.id, session, workspace);
    assert.equal(writes.filter((w) => w.endsWith("AGENT.md")).length, 0, `unchanged content is not rewritten: ${writes.join(", ")}`);
    assert.equal(fs.statSync(guidePath).mtimeMs, stampBefore, "so its timestamp is untouched");
    assert.equal(fs.readFileSync(guidePath, "utf8"), content);
    // And when the content does change, it is written.
    const other = { id: "s1", projectId: "p1", enabledSkillIds: ["alpha-skill"] };
    reloaded.writeSessionAgentGuide(session.id, other, workspace);
    assert.notEqual(fs.readFileSync(guidePath, "utf8"), content, "a different skill set changes the guide");
  });

  check("the MCP config is replaced only when its content moved", () => {
    const out = path.join(tmp, "runtime", "opencode-mcp.json");
    const context = { activeSkillIds: ["alpha-skill"], runtime: {} };
    assert.equal(mcpConfig.writeActiveMcpConfig("", out, ["alpha-skill"], context), out);
    const before = fs.statSync(out).mtimeMs;
    reset();
    assert.equal(mcpConfig.writeActiveMcpConfig("", out, ["alpha-skill"], context), out);
    assert.equal(counts.renameSync, 0, "same content → no temp+rename");
    assert.equal(fs.statSync(out).mtimeMs, before);
    mcpConfig.writeActiveMcpConfig("", out, ["alpha-skill"], { ...context, activeSkillIds: ["alpha-skill", "beta-skill"] });
    assert.equal(counts.renameSync, 1, "changed content → written atomically");
  });

  check("the switch warm-up is write-free by construction, and says when it was slow", () => {
    const src = fs.readFileSync(path.join(ROOT, "src/main/ipc-sessions.js"), "utf8");
    assert.match(src, /ensure\(ctx, sessionId, \{ spawn: false \}\)/, "the warm-up never spawns an engine");
    assert.match(src, /runner warm-up took \$\{ms\}ms on switch/, "a slow warm-up is logged with its duration");
    const mcp = fs.readFileSync(path.join(ROOT, "src/main/mcp-config.js"), "utf8");
    assert.match(mcp, /writeJson\(outPath, \{ mcpServers \}, \{ newline: true, onlyIfChanged: true \}\)/, "the MCP config compares before it replaces");
    const sm = fs.readFileSync(path.join(ROOT, "src/main/skill-manager.js"), "utf8");
    assert.match(sm, /if \(!jsonFile\.unchangedOnDisk\(guidePath, guide\)\) fs\.writeFileSync\(guidePath, guide, "utf8"\)/, "and so does the session guide");
    const state = fs.readFileSync(path.join(ROOT, "src/main/skills-state.js"), "utf8");
    const loop = state.slice(state.indexOf("function ensureSkillsStateDefaults"), state.indexOf("function isSkillEnabled"));
    assert.ok(!loop.includes("readBundledManifest("), "the per-call reconciliation reads no bundled manifest");
    assert.match(loop, /bundledVersionOf\(skillId\)/);
    // The stage profile every hot path uses is one module. A field report of a
    // slow switch arrives AFTER the slow switch, so waiting for someone to set a
    // flag first can never explain it: the stages are always measured and the
    // line prints itself when the path was slow.
    const profile = require(path.join(ROOT, "src/main/stage-profile.js"));
    delete process.env.LILY_PROFILE_RUNNER_ENSURE;
    const clock = (step) => { let at = 0; return () => { at += step; return at; }; };
    const quiet = [];
    const fast = profile.stageProfile("LILY_PROFILE_RUNNER_ENSURE", { info: (l) => quiet.push(l), warn: (l) => quiet.push(l) }, { now: clock(5) });
    fast.mark("a"); fast.mark("b");
    assert.equal(fast.report("never printed"), null, "a fast path says nothing");
    assert.deepEqual(quiet, []);
    const slowLines = [];
    const slow = profile.stageProfile("LILY_PROFILE_RUNNER_ENSURE", { info: (l) => slowLines.push(l), warn: (l) => slowLines.push(l) }, { now: clock(3000) });
    slow.mark("a"); slow.mark("b"); slow.report("p");
    assert.match(slowLines[0], /^p: total=\d+ms a=\d+ms b=\d+ms$/, "a slow path names every stage without being asked");
    // Not every host that loads main-process modules has a global `performance`
    // (a test fixture did not, and an always-on profiler that throws where it
    // used to be a no-op is worse than the slowness it measures).
    const savedPerformance = globalThis.performance;
    try {
      delete globalThis.performance;
      const bare = profile.stageProfile("LILY_PROFILE_RUNNER_ENSURE", { info: () => {}, warn: () => {} });
      bare.mark("a");
      bare.report("p");
    } finally {
      if (savedPerformance !== undefined) globalThis.performance = savedPerformance;
    }
    process.env.LILY_PROFILE_RUNNER_ENSURE = "1";
    const lines = [];
    const on = profile.stageProfile("LILY_PROFILE_RUNNER_ENSURE", { info: (line) => lines.push(line) }, { now: clock(5) });
    on.mark("a"); on.mark("b"); on.report("p");
    assert.match(lines[0], /^p: total=\d+ms a=\d+ms b=\d+ms$/, "the flag still forces the breakdown on a fast path");
    delete process.env.LILY_PROFILE_RUNNER_ENSURE;
    for (const file of ["src/main/ipc-utils.js", "src/main/session-runner-pool.js"]) {
      const text = fs.readFileSync(path.join(ROOT, file), "utf8");
      assert.match(text, /stageProfile\("LILY_PROFILE_RUNNER_ENSURE"/, `${file} reports its stages through the shared profiler`);
      assert.ok(!/performance\.now\(\)/.test(text), `${file} keeps no private stopwatch`);
    }
  });

  console.log(`\n${checks} checks passed (session switch warm-up)`);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.rmSync(workspace, { recursive: true, force: true });
}
