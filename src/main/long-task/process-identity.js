"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const { execFileSync } = require("node:child_process");

function inspectProcess(pid, options = {}) {
  const numeric = Number(pid);
  if (!Number.isInteger(numeric) || numeric <= 0) return "";
  if (typeof options.inspect === "function") return String(options.inspect(numeric) || "").trim();
  const platform = options.platform || process.platform;
  try {
    if (platform === "linux") {
      const stat = fs.readFileSync(`/proc/${numeric}/stat`, "utf8");
      const close = stat.lastIndexOf(")");
      const fields = stat.slice(close + 2).split(" ");
      const startTicks = fields[19] || "";
      const command = fs.readFileSync(`/proc/${numeric}/cmdline`, "utf8").replace(/\0/g, " ").trim();
      return `${numeric}|${startTicks}|${command}`;
    }
    const output = execFileSync("ps", ["-p", String(numeric), "-o", "pid=", "-o", "lstart=", "-o", "command="], {
      encoding: "utf8",
      timeout: 2_000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return String(output || "").replace(/\s+/g, " ").trim();
  } catch {
    return "";
  }
}

function fingerprint(observation) {
  return crypto.createHash("sha256").update(String(observation || ""), "utf8").digest("hex");
}

function captureProcessIdentity(pid, options = {}) {
  const observation = inspectProcess(pid, options);
  if (!observation) return null;
  return Object.freeze({
    pid: Number(pid),
    processGroupId: Number(options.processGroupId || pid),
    platform: options.platform || process.platform,
    command: String(options.command || "").slice(0, 1024),
    launchNonce: String(options.launchNonce || "").slice(0, 160),
    startedAt: Number((options.now || Date.now)()),
    fingerprint: fingerprint(observation),
  });
}

function createWeakProcessIdentity(pid, options = {}) {
  const launchNonce = String(options.launchNonce || "").slice(0, 160);
  if (!launchNonce || !Number.isInteger(Number(pid)) || Number(pid) <= 0) return null;
  return Object.freeze({
    pid: Number(pid),
    processGroupId: Number(options.processGroupId || pid),
    platform: options.platform || process.platform,
    command: String(options.command || "").slice(0, 1024),
    launchNonce,
    startedAt: Number((options.now || Date.now)()),
    fingerprint: `weak:${fingerprint(`${pid}:${launchNonce}`)}`,
    reconnectSafe: false,
  });
}

function matchesProcessIdentity(identity, options = {}) {
  if (!identity || !Number.isInteger(Number(identity.pid)) || !identity.fingerprint) return false;
  if (String(identity.fingerprint).startsWith("weak:")) {
    try { process.kill(Number(identity.pid), 0); return true; } catch { return false; }
  }
  const observation = inspectProcess(identity.pid, options);
  return Boolean(observation && fingerprint(observation) === identity.fingerprint);
}

module.exports = { captureProcessIdentity, createWeakProcessIdentity, inspectProcess, matchesProcessIdentity };
