"use strict";

/**
 * Startup health self-check.
 *
 * Diagnostics used to be a manual weapon: perfect checks, but only if the
 * user found 设置 → 诊断修复. By then they'd already concluded "activated but
 * the app is broken". This runs the LOCAL half of support diagnostics once,
 * shortly after the window loads (no network probes — startup must stay
 * fast), and pushes a banner with a one-click path to the diagnostics page
 * when something is already broken. Fail-open: any internal error means "no
 * banner", never a broken startup.
 */

const { getLogger } = require("./logger");

const log = getLogger("startup-health");

const STARTUP_HEALTH_DELAY_MS = 4_000;

function issueFromCheck(check) {
  return {
    id: check.id,
    message: check.detail ? `${check.label}：${check.detail}` : check.label,
  };
}

async function collectStartupIssues({ getAgentBootstrap }) {
  const issues = [];
  const bootstrap = typeof getAgentBootstrap === "function" ? getAgentBootstrap() : null;
  if (bootstrap && bootstrap.ok === false) {
    issues.push({
      id: "engine.missing",
      message: "AI 引擎缺失，无法开始对话。",
    });
  }
  try {
    const diagnostic = await require("./support-diagnostics").runSupportDiagnosticsPublic({
      refreshService: false,
      probeModel: false, // local checks only — no network on the startup path
      includeEngine: true,
    });
    for (const check of diagnostic?.checks || []) {
      if (check.status === "error") issues.push(issueFromCheck(check));
    }
  } catch (err) {
    log.warn("startup diagnostics failed open: %s", err?.message || err);
  }
  return issues;
}

function scheduleStartupHealthCheck({ getWindow, getAgentBootstrap, delayMs = STARTUP_HEALTH_DELAY_MS } = {}) {
  const run = async () => {
    try {
      const issues = await collectStartupIssues({ getAgentBootstrap });
      if (!issues.length) return;
      const win = typeof getWindow === "function" ? getWindow() : null;
      if (!win || win.isDestroyed?.()) return;
      log.warn("startup health issues detected: %s", issues.map((issue) => issue.id).join(", "));
      win.webContents.send("app:startup-health", { ok: false, issues });
    } catch (err) {
      log.warn("startup health check failed open: %s", err?.message || err);
    }
  };
  const win = typeof getWindow === "function" ? getWindow() : null;
  if (win && !win.isDestroyed?.()) {
    win.webContents.once("did-finish-load", () => {
      setTimeout(run, delayMs).unref?.();
    });
  } else {
    setTimeout(run, delayMs).unref?.();
  }
}

module.exports = {
  collectStartupIssues,
  scheduleStartupHealthCheck,
};
