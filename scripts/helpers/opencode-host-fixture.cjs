#!/usr/bin/env node
"use strict";

// Offline host-lifecycle reproduction. Reads only the listed product sources.
// Real: ensureSessionRunner, SessionRunnerPool.ensure, TurnOrchestrator.bindRunner,
// agent lifecycle, config/env builders, shared profile pool, SDK adapter, reducers.
// Fixtures: Electron/settings/filesystem, process/SDK transport, session storage,
// unrelated orchestrator services and watchdogs. No real process, network, or DB.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { EventEmitter } = require("node:events");
const root = path.resolve(__dirname, "../..");
const sourceRoot = path.join(root, "src/main");
const real = new Set([
  "ipc-utils", "turn-orchestrator", "session-runner-pool", "opencode-agent-session",
  "spawn-env", "agent-env", "opencode-config-freshness", "model-route-audit",
  "context-budget-manager", "opencode-subagent-runtime", "usage-reporter",
  "runtime/opencode-shared-server", "runtime/opencode-server-manager",
  "runtime/opencode-sdk-session", "runtime/opencode-config-builder",
  "runtime/opencode-model-config", "runtime/opencode-runtime-reducer",
  "runtime/opencode-event-ownership", "runtime/opencode-session-work",
]);
const noop = () => {};
const serviceStub = new Proxy({}, { get: () => () => ({}) });
const quiet = { log: noop, info: noop, warn: noop, error: noop, debug: noop };
const tick = () => new Promise(resolve => setImmediate(resolve));

function fixture({ sdkTimeoutMs = 30_000 } = {}) {
  const home = "/private/tmp/lily-runtime-review-fixture"; // Virtual; never created.
  const rows = new Map(), sessions = new Map(), modules = new Map();
  const projections = [], reports = [], summaryWaits = [], kills = [], usageCalls = [];
  const stats = { envBuilds: 0, poolEnsures: 0, sdkGets: 0, sdkCreates: 0 };
  let sequence = 0, holdSummary = false;
  const guideDir = id => path.join(home, "guides", id);
  const vfs = new Proxy({
    existsSync: p => p === root || p === process.execPath,
    mkdirSync: noop,
    writeFileSync: noop,
    unlinkSync: noop,
  }, { get: (target, key) => key in target ? target[key] : () => { throw new Error(`Blocked filesystem operation: ${String(key)}`); } });
  const mocks = {
    "config": { PROJECT_ROOT: root, userDataPath: p => path.join(home, p),
      opencodeDbPath: () => path.join(home, "same.db"), fileStagingDir: () => path.join(home, "staging"),
      userHome: () => home, agentBinDir: () => home, agentConfigDir: () => home, sessionGuideDir: guideDir },
    "agent-command": { resolveOpencodeCommand: () => process.execPath },
    "agent-runner": { sanitizeError: x => String(x || "") },
    "logger": { getLogger: () => quiet },
    "skill-manager": { writeSessionAgentGuide: guideDir, resolveSessionSkillIds: () => [], getDisallowedTools: () => [] },
    "session-engine-recovery": { migrateGlobalResumeArtifacts: noop, hasResumeArtifacts: () => true, resetSessionEngineCache: noop },
    "resume-binding": { buildResumeBinding: () => ({}), verifyResumeBinding: () => ({ ok: true }) },
    "permission-settings": { getActivePermissionMode: () => "ask", resolveSessionPermissionMode: () => "ask" },
    "turn-model-runtime": { runtimeModelPool: () => undefined },
    "model-presets": { getActivePresetEnv: () => ({}), getUserApiEnv: () => ({}) },
    "runtime-node": { ensureRuntimeNodeShim: () => { stats.envBuilds++; }, runtimeBinDir: () => home },
    "runtime-python": { getRuntimePathEntries: () => [], getRuntimeEnvExtras: () => ({}) },
    "spawn-env-allowlist": { pickInheritedEnv: () => ({}) },
    "search-settings": { getSearchSpawnEnv: () => ({}) },
    "media-provider-settings": { getMediaProviderSpawnEnv: () => ({}) },
    "connector-bridge": { getConnectorBridgeEnvSync: () => ({}) },
    "bundle-locator": { bundleRuntimeDir: () => null },
    "runtime-packs": { bundledPacksRootCandidates: () => [] },
    "locale-settings": { getLocale: () => "en" },
    "account-manager": { getCurrentOrganizationId: () => null },
    "opencode-runtime-identity": { buildOpencodeRuntimeIdentityConfig: () => null, revokeOpencodeRuntimeIdentity: noop },
    "opencode-turn-liveness": { createOpencodeTurnLiveness: () => serviceStub },
    "opencode-history-recovery": { createOpencodeHistoryRecovery: () => ({}) },
    "required-tool-completion-gate": { reset: noop },
    "session-memory": { markSessionCompacted: noop, markSessionCompactionFailed: noop },
    "local-date-key": { localDateKey: () => "2026-08-29" },
    "license-manager": { getLicenseStatus: () => ({}) },
    "usage-local-store": { mergeSessionRecord: noop },
    "service-client": { reportUsage: async record => { reports.push({ ...record }); return { ok: true }; } },
    "process-tree-kill": { killProcessTree(child) {
      if (!child) return;
      kills.push(child.pid);
      for (const wait of summaryWaits) if (wait.pid === child.pid) wait.reject(new Error("fixture: serve killed during summarize"));
    } },
  };
  function load(name) {
    if (Object.hasOwn(mocks, name)) return mocks[name];
    if (!real.has(name)) return serviceStub;
    if (modules.has(name)) return modules.get(name).exports;
    const filename = path.join(sourceRoot, name + ".js"), module = { exports: {} };
    modules.set(name, module);
    const requireFixture = id => {
      if (id === "node:fs") return vfs;
      if (["node:events", "node:path", "node:os", "node:crypto", "node:util"].includes(id)) return require(id);
      if (id === "node:child_process") return { spawn() {
        const child = new EventEmitter();
        Object.assign(child, { stdout: new EventEmitter(), stderr: new EventEmitter(), pid: ++sequence });
        return child;
      } };
      if (id === "electron") return { app: { isPackaged: true, getPath: () => home } };
      if (!id.startsWith(".")) throw new Error(`External dependency forbidden: ${id}`);
      const resolved = path.relative(sourceRoot, path.resolve(path.dirname(filename), id)).replace(/\.js$/, "");
      if (resolved.startsWith("..")) throw new Error(`Source outside main forbidden: ${id}`);
      return load(resolved);
    };
    vm.runInNewContext(fs.readFileSync(filename, "utf8"), {
      module, exports: module.exports, require: requireFixture, console: quiet, Buffer, URL, AbortController,
      process: { env: { LANG: "C.UTF-8", LILY_RUNTIME_IDENTITY_V1: "0" }, platform: process.platform },
      setTimeout: (fn, ms, ...args) => setTimeout(fn, ms === 30_000 ? sdkTimeoutMs : ms, ...args),
      clearTimeout, setImmediate, clearImmediate, queueMicrotask,
    }, { filename });
    return module.exports;
  }

  const sharedModule = load("runtime/opencode-shared-server");
  const startProcess = sharedModule.OpencodeSharedServer.prototype.ensureStarted;
  async function hardExit(shared) {
    shared._baseClient = null;
    shared._starting = null;
    const pending = startProcess.call(shared).catch(() => {});
    // Install and execute the real child-process exit callback, without loading
    // the SDK/network. The running-request fixture deliberately stays unsettled.
    shared._baseClient = { fixture: true };
    shared.process.emit("exit", 137);
    await pending;
  }
  // Transport boundary only. Keep real getSharedServer/retain/release/terminate,
  // manager.start/createSession/subscribe, and SDK parameter adaptation intact.
  sharedModule.OpencodeSharedServer.prototype.ensureStarted = async function () {
    if (this._baseClient) return this;
    this.process = { pid: ++sequence, killed: false, exitCode: null, signalCode: null };
    this.port = 4100 + sequence;
    const shared = this;
    this._baseClient = { fixture: true };
    this._createOpencodeClient = () => ({ session: {
      get: async ({ sessionID }) => { stats.sdkGets++; return { data: rows.get(sessionID) || null }; },
      create: async () => {
        stats.sdkCreates++;
        const row = { id: `ses_new_${++sequence}`, history: [] };
        rows.set(row.id, row); return { data: row };
      },
      abort: async () => ({ data: true }),
      summarize: async ({ sessionID, directory }) => {
        shared._enqueueEvent(directory, modelEvent(sessionID, "msg_usage", "summary-provider", "summary-model")); shared._flushEvents();
        if (holdSummary) return new Promise((resolve, reject) => summaryWaits.push({ pid: shared.process.pid, resolve, reject }));
        shared._enqueueEvent(directory, usageEvent(sessionID)); shared._flushEvents();
        return { data: true };
      },
    } });
    return this;
  };
  const { SessionRunnerPool } = load("session-runner-pool");
  const pool = new SessionRunnerPool();
  pool._opencodeBasePersona = () => "Lily fixture persona";
  pool._opencodeSubagentPersona = () => "Lily fixture subagent";
  pool._opencodeMcpServers = () => ({});
  pool._opencodePlugins = () => [];
  pool._opencodeGuideContent = () => "Fixture guide";
  const originalEnsure = pool.ensure;
  pool.ensure = function (...args) { stats.poolEnsures++; return originalEnsure.apply(this, args); };
  const manager = {
    findById: id => sessions.get(id), findAgentResumeOwner: () => null,
    clearAgentResumeId(id) { sessions.get(id).agentResumeId = null; },
    claimAgentResumeId(id, resume) { sessions.get(id).agentResumeId = resume; return { ok: true, evictedSessionIds: [] }; },
  };
  const ctx = { runnerPool: pool, sessionManager: manager, projectManager: { find: () => ({ id: "p", path: root }) } };
  const { TurnOrchestrator } = load("turn-orchestrator");
  const orchestrator = Object.create(TurnOrchestrator.prototype);
  Object.assign(orchestrator, { ctx, boundRunners: new WeakSet(), restorePendingTurns: noop,
    _dispatchNext: async () => {}, _emit: noop, ingest: (_id, drafts) => projections.push(...drafts) });
  ctx.turnOrchestrator = orchestrator; // Real bindRunner AND _claimAgentResumeId.
  const { ensureSessionRunner } = load("ipc-utils");
  function add(id) {
    const resume = `ses_${id}`;
    sessions.set(id, { id, projectId: "p", agentResumeId: resume });
    rows.set(resume, { id: resume, history: ["original-history-sentinel"] });
  }
  async function ensure(id, model, env = {}) {
    const selected = { providerID: "fixture", modelID: model, contextWindowTokens: 128000 };
    const result = ensureSessionRunner(ctx, id, { spawn: true, modelExecution: { model: selected, env: {
      LILY_MODEL: model, LILY_API_BASE_URL: "https://fixture.invalid/v1", LILY_API_KEY: "fixture-not-a-secret",
      LILY_OPENCODE_PROVIDER_ID: "fixture", LILY_CONTEXT_WINDOW_TOKENS: "128000", ...env,
    } } });
    assert.ok(result.runner, result.detail || result.error);
    await result.runner._ensureStarted(); // Await real async startup, not a replacement ensure.
    return result;
  }
  const usage = load("usage-reporter");
  const recordUsage = usage.recordModelUsage;
  usage.recordModelUsage = (sessionId, delta, model) => {
    usageCalls.push({ sessionId, delta: { ...delta }, model: { ...model } });
    return recordUsage(sessionId, delta, model);
  };
  return { add, ensure, pool, rows, sessions, stats, reports, usageCalls, projections, kills, summaryWaits,
    load, usage, hardExit, holdSummary: () => { holdSummary = true; },
    close: () => {
      pool.terminateAll(); sharedModule.resetSharedServer();
      for (const wait of summaryWaits) wait.reject(new Error("fixture closed"));
    } };
}

function usageEvent(sessionID) {
  return { type: "message.part.updated", properties: { part: {
    id: "part_usage", messageID: "msg_usage", sessionID, type: "step-finish", tokens: { input: 120, output: 8 },
  } } };
}

function modelEvent(sessionID, messageID = "msg_usage", providerID = "actual-provider", modelID = "actual-model") {
  return { type: "message.updated", properties: { info: { id: messageID, sessionID, role: "assistant", providerID, modelID } } };
}
function dispatch(server, event, directory = root) {
  const shared = server._shared || server;
  shared._enqueueEvent(directory, event);
  shared._flushEvents();
}
module.exports = { fixture, usageEvent, modelEvent, dispatch, tick, root };
