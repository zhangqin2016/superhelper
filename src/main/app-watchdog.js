"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { ipcMain } = require("electron");
const { getLogger } = require("./logger");
const { userDataPath } = require("./config");

const DEFAULT_RENDERER_STALE_MS = 10_000;
const DEFAULT_MAIN_LAG_MS = 2_000;
const DEFAULT_TICK_MS = 1_000;
const MAX_RECENT = 20;

// The running instance, so passive consumers (support diagnostics) can read
// the live snapshot instead of a perpetual null.
let activeWatchdog = null;

function getLastWatchdogSnapshot() {
  try {
    return activeWatchdog ? activeWatchdog.snapshot() : null;
  } catch {
    return null;
  }
}

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

// A machine that sleeps is not an app that froze. The wall clock keeps running
// through a sleep while the monotonic clock (mach_absolute_time on macOS,
// CLOCK_MONOTONIC on Linux) stands still, so their difference IS the sleep.
// Measured 2026-09-23: both "main event loop lag" warnings of the day — 136,715
// and 2,841,042 ms — matched the system power log's clamshell sleeps to the
// second, and a diagnosis that trusted them would have hunted a freeze that
// never happened. Lag and staleness are measured on the monotonic clock; the
// gap between the clocks is reported as what it is. powerMonitor's
// suspend/resume is the second signal, for a platform whose monotonic clock
// might count sleep.
function createWatchdog(options = {}) {
  const now = options.now || (() => Date.now());
  // An injected wall clock with no monotonic one is a test driving time by
  // hand: both clocks are then the same clock, and nothing reads as sleep.
  const monotonic = options.monotonic || (options.now ? options.now : () => performance.now());
  const log = options.log || getLogger("app-watchdog");
  const rendererStaleMs = Number(options.rendererStaleMs) || DEFAULT_RENDERER_STALE_MS;
  const mainLagMs = Number(options.mainLagMs) || DEFAULT_MAIN_LAG_MS;
  const state = {
    startedAt: now(),
    lastMainTickAt: now(),
    lastMainTickMono: monotonic(),
    lastRendererHeartbeatAt: 0,
    lastRendererHeartbeatMono: 0,
    suspendedAt: 0,
    lastSleepReportedAt: 0,
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
    } else if (kind === "system_sleep") {
      log.info("system slept %dms (%s); not counted as lag", record.sleptMs, record.source);
    } else {
      log.info("%s %j", kind, record);
    }
    return record;
  }

  function receiveRendererHeartbeat(payload = {}) {
    state.lastRendererHeartbeatAt = now();
    state.lastRendererHeartbeatMono = monotonic();
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
    const staleMs = monotonic() - state.lastRendererHeartbeatMono;
    if (staleMs < rendererStaleMs) return null;
    if (now() - state.lastRendererStaleLoggedAt < rendererStaleMs) return null;
    state.lastRendererStaleLoggedAt = now();
    return emit("renderer_heartbeat_stale", {
      staleMs: Math.round(staleMs),
      rendererSeq: state.rendererSeq,
      lastRendererLagMs: Math.round(state.rendererLagMs || 0),
    });
  }

  function reportSleep(sleptMs, source) {
    state.lastSleepReportedAt = now();
    return emit("system_sleep", { sleptMs: Math.round(sleptMs), source });
  }

  function checkMainLoop() {
    const current = now();
    const currentMono = monotonic();
    const wallGap = current - state.lastMainTickAt;
    const monoGap = currentMono - state.lastMainTickMono;
    state.lastMainTickAt = current;
    state.lastMainTickMono = currentMono;
    const sleptMs = wallGap - monoGap;
    if (sleptMs >= mainLagMs) reportSleep(sleptMs, "clock_gap");
    const lagMs = monoGap - (Number(options.tickMs) || DEFAULT_TICK_MS);
    if (lagMs < mainLagMs) return null;
    if (current - state.lastMainLagLoggedAt < mainLagMs) return null;
    state.lastMainLagLoggedAt = current;
    return emit("main_event_loop_lag", { lagMs: Math.round(lagMs) });
  }

  function systemSuspended() {
    state.suspendedAt = now();
  }

  // Whatever the clocks did, time spent suspended is not lag and not a stale
  // renderer: restart both baselines from the moment of waking.
  function systemResumed() {
    const current = now();
    const currentMono = monotonic();
    const suspendedAt = state.suspendedAt;
    state.suspendedAt = 0;
    state.lastMainTickAt = current;
    state.lastMainTickMono = currentMono;
    if (state.lastRendererHeartbeatAt) {
      state.lastRendererHeartbeatAt = current;
      state.lastRendererHeartbeatMono = currentMono;
    }
    // The clock gap may already have reported this sleep on the first tick.
    if (!suspendedAt || state.lastSleepReportedAt >= suspendedAt) return null;
    return reportSleep(current - suspendedAt, "power_monitor");
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
    systemSuspended,
    systemResumed,
    snapshot,
  };
}

// Measured on a real install before this was bounded: 47 MB and 176,711 lines
// across 86 days, growing about half a megabyte a day with nothing in the whole
// repository reading it back. MAX_RECENT above bounds the in-memory ring the
// diagnostics report actually samples; this bounds the file.
const WATCHDOG_MAX_BYTES = 2 * 1024 * 1024;
const WATCHDOG_MAX_FILES = 2;
let watchdogSink = null;

function appendJsonl(record) {
  if (!watchdogSink) {
    watchdogSink = require("./diagnostics/rotating-file-sink").createRotatingFileSink({
      filePath: path.join(userDataPath("diagnostics"), "watchdog.jsonl"),
      maxBytes: WATCHDOG_MAX_BYTES,
      maxFiles: WATCHDOG_MAX_FILES,
    });
  }
  watchdogSink.write(JSON.stringify(record));
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
  activeWatchdog = watchdog;

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

  try {
    const { powerMonitor } = require("electron");
    powerMonitor?.on?.("suspend", () => watchdog.systemSuspended());
    powerMonitor?.on?.("resume", () => watchdog.systemResumed());
  } catch (err) {
    // The clock gap still tells sleep from lag without it.
    log.warn("powerMonitor unavailable; sleep is detected from the clocks alone: %s", err?.message || err);
  }

  const timer = setInterval(() => {
    watchdog.checkMainLoop();
    watchdog.checkRendererHeartbeat();
  }, tickMs);
  timer.unref?.();

  log.info("watchdog started (tick=%dms rendererStale=%dms mainLag=%dms)", tickMs, rendererStaleMs, mainLagMs);
  return {
    watchdog,
    stop: () => {
      clearInterval(timer);
      if (activeWatchdog === watchdog) activeWatchdog = null;
    },
  };
}

module.exports = {
  createWatchdog,
  startAppWatchdog,
  getLastWatchdogSnapshot,
  DEFAULT_RENDERER_STALE_MS,
  DEFAULT_MAIN_LAG_MS,
  DEFAULT_TICK_MS,
};
