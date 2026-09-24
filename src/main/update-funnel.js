"use strict";

/**
 * Where an update got to on this device, reported once per target version and
 * stage — so a rollout can say "412 downloaded, 9 failed to download" instead
 * of inferring from who later runs the new version.
 *
 * Derived from the update manager's own state transitions (observe is called
 * from setState), so nothing in the update flow has to remember to report.
 * Fire-and-forget: a report that fails changes nothing about the update.
 */
const sent = new Set();

function stagesBetween(previous = {}, next = {}) {
  const stages = [];
  if (next.phase === "downloading" && previous.phase !== "downloading") stages.push({ stage: "download_started" });
  if (next.phase === "downloaded" && previous.phase !== "downloaded") stages.push({ stage: "downloaded" });
  const code = next.error?.code || "";
  if (/^(AUTO_FEED_FAILED|AUTO_UPDATE_FAILED)$/.test(code) && previous.error?.code !== code) stages.push({ stage: "download_failed", errorCode: code });
  if (next.phase === "installing" && previous.phase !== "installing") stages.push({ stage: "install_started" });
  return stages;
}

function observe(previous, next, deps = {}) {
  const target = String(next?.latestVersion || "");
  if (!target || target === String(next?.currentVersion || "")) return [];
  const reports = [];
  for (const item of stagesBetween(previous, next)) {
    const key = `${target}:${item.stage}`;
    if (sent.has(key)) continue;
    sent.add(key);
    reports.push({ toVersion: target, ...item });
  }
  if (!reports.length) return reports;
  let service = deps.service;
  try {
    service = service || require("./service-client");
  } catch {
    return reports;
  }
  for (const report of reports) {
    Promise.resolve()
      .then(() => service.serviceFetch("/api/updates/events", {
        method: "POST",
        body: JSON.stringify({ ...service.devicePayload(), ...report }),
      }))
      .catch(() => {});
  }
  return reports;
}

module.exports = { observe, stagesBetween, _resetForTests: () => sent.clear() };
