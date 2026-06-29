"use strict";

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { ipcMain } = require("electron");
const { getLogger } = require("./logger");
const { userDataPath } = require("./config");

const DEFAULT_RENDERER_STALE_MS = 10_000;
const DEFAULT_MAIN_LAG_MS = 2_000;
const DEFAULT_TICK_MS = 1_000;
const MAX_RECENT = 20;

function safeMemoryUsage() {
  try {
    const mem = process.memoryUsage();
    return {
      rss: mem.rss,
      heapUsed: mem.heapUsed,
      heapTotal: mem.heapTotal,
      external: mem.external,
    };
  } catch {
    return null;
  }
}

function createWatchdog(options = {}) {
  const now = options.now || (() => Date.now());
  const log = options.log || getLogger("app-watchdog");
  const rendererStaleMs = Number(options.rendererStaleMs) || DEFAULT_RENDERER_STALE_MS;
  const mainLagMs = Number(options.mainLagMs) || DEFAULT_MAIN_LAG_MS;
  const state = {
    startedAt: now(),
    lastMainTickAt: now(),
    lastRendererHeartbeatAt: 0,
    rendererSeq: 0,
    rendererLagMs: 0,
    lastRendererStaleLoggedAt: 0,
    lastMainLagLoggedAt: 0,
    recent: [],
  };

  function pushRecent(record) {
    state.recent.push(record);
    while (state.recent.length > MAX_RECENT) state.recent.shift();
  }

  function emit(kind, detail = {}) {
    const record = {
      kind,
      at: new Date(now()).toISOString(),
      platform: process.platform,
      arch: process.arch,
      pid: process.pid,
      uptimeSec: Math.round(process.uptime()),
      memory: safeMemoryUsage(),
      ...detail,
    };
    pushRecent(record);
    try {
      options.appendRecord?.(record);
    } catch (err) {
      log.warn("failed to write watchdog record: %s", err?.message || err);
    }
    if (kind === "main_event_loop_lag") {
      log.warn("main event loop lag %dms", record.lagMs);
    } else if (kind === "renderer_heartbeat_stale") {
      log.warn("renderer heartbeat stale %dms", record.staleMs);
    } else {
      log.info("%s %j", kind, record);
    }
    return record;
  }

  function receiveRendererHeartbeat(payload = {}) {
    state.lastRendererHeartbeatAt = now();
    state.rendererSeq = Number(payload.seq) || state.rendererSeq + 1;
    state.rendererLagMs = Number(payload.rendererLagMs) || 0;
    if (state.rendererLagMs >= rendererStaleMs) {
      emit("renderer_event_loop_lag", {
        rendererLagMs: Math.round(state.rendererLagMs),
        rendererSeq: state.rendererSeq,
        visibilityState: payload.visibilityState || "",
      });
    }
  }

  function checkRendererHeartbeat() {
    if (!state.lastRendererHeartbeatAt) return null;
    const staleMs = now() - state.lastRendererHeartbeatAt;
    if (staleMs < rendererStaleMs) return null;
    if (now() - state.lastRendererStaleLoggedAt < rendererStaleMs) return null;
    state.lastRendererStaleLoggedAt = now();
    return emit("renderer_heartbeat_stale", {
      staleMs: Math.round(staleMs),
      rendererSeq: state.rendererSeq,
      lastRendererLagMs: Math.round(state.rendererLagMs || 0),
    });
  }

  function checkMainLoop() {
    const current = now();
    const lagMs = current - state.lastMainTickAt - (Number(options.tickMs) || DEFAULT_TICK_MS);
    state.lastMainTickAt = current;
    if (lagMs < mainLagMs) return null;
    if (current - state.lastMainLagLoggedAt < mainLagMs) return null;
    state.lastMainLagLoggedAt = current;
    return emit("main_event_loop_lag", { lagMs: Math.round(lagMs) });
  }

  function snapshot(extra = {}) {
    return {
      ok: true,
      startedAt: new Date(state.startedAt).toISOString(),
      lastRendererHeartbeatAt: state.lastRendererHeartbeatAt
        ? new Date(state.lastRendererHeartbeatAt).toISOString()
        : null,
      rendererSeq: state.rendererSeq,
      rendererLagMs: Math.round(state.rendererLagMs || 0),
      memory: safeMemoryUsage(),
      recent: state.recent.slice(),
      ...extra,
    };
  }

  return {
    state,
    receiveRendererHeartbeat,
    checkRendererHeartbeat,
    checkMainLoop,
    snapshot,
  };
}

function appendJsonl(record) {
  const dir = userDataPath("diagnostics");
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(path.join(dir, "watchdog.jsonl"), `${JSON.stringify(record)}${os.EOL}`, "utf8");
}

function startAppWatchdog(ctx = {}, options = {}) {
  const log = getLogger("app-watchdog");
  const tickMs = Number(options.tickMs) || DEFAULT_TICK_MS;
  const rendererStaleMs = Number(options.rendererStaleMs) || DEFAULT_RENDERER_STALE_MS;
  const mainLagMs = Number(options.mainLagMs) || DEFAULT_MAIN_LAG_MS;
  const watchdog = createWatchdog({
    tickMs,
    rendererStaleMs,
    mainLagMs,
    appendRecord: options.appendRecord || appendJsonl,
    log,
  });

  ipcMain.on("app:renderer-heartbeat", (_event, payload) => {
    watchdog.receiveRendererHeartbeat(payload || {});
  });

  ipcMain.handle("app:watchdog-snapshot", () => {
    const session = ctx.sessionManager?.getActive?.();
    return watchdog.snapshot({
      activeSessionId: session?.id || null,
      activeProjectId: session?.projectId || null,
      engine: session?.id ? ctx.runnerPool?.diagnostics?.(session.id) || null : null,
    });
  });

  const timer = setInterval(() => {
    watchdog.checkMainLoop();
    watchdog.checkRendererHeartbeat();
  }, tickMs);
  timer.unref?.();

  log.info("watchdog started (tick=%dms rendererStale=%dms mainLag=%dms)", tickMs, rendererStaleMs, mainLagMs);
  return { watchdog, stop: () => clearInterval(timer) };
}

module.exports = {
  createWatchdog,
  startAppWatchdog,
  DEFAULT_RENDERER_STALE_MS,
  DEFAULT_MAIN_LAG_MS,
  DEFAULT_TICK_MS,
};
