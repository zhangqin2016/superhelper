"use strict";

/**
 * Reap engine serves orphaned by an ungraceful exit, at startup.
 *
 * `before-quit` in src/main.js already calls resetSharedServer(), which reaps
 * the shared `opencode serve` and its whole tool tree. But before-quit only
 * runs on a GRACEFUL quit. Ctrl-C on the dev launcher, a crash, or a force
 * quit skips it, and the serve survives — reparented to init, holding files
 * under userData and a port, forever.
 *
 * Nothing ever looked for what a previous run left behind. Measured on a real
 * dev machine 2026-09-04: 7 orphaned serves, the oldest 40 days old, dragging
 * 24 stale Electron children along, 587 MB resident, with 19 processes holding
 * files under the userData directory at once. That last part is the same class
 * of problem as the Windows updater's "could not be closed".
 *
 * This KILLS processes, so matching is deliberately narrow. All three must hold:
 *
 *   1. the command starts with EXACTLY this install's bundled engine binary, so
 *      another checkout or a system-wide opencode is never touched;
 *   2. the parent is gone (ppid 1). A running instance's serve is parented to
 *      that instance, so a live engine can never match — this is what makes the
 *      whole thing safe rather than a heuristic;
 *   3. the pid is neither ours nor our parent's.
 *
 * FAIL OPEN: any failure returns 0 and logs. Kill switch:
 * LILY_REAP_ORPHAN_SERVES=0.
 */

const { execFileSync } = require("node:child_process");
const { getLogger } = require("../logger");
const { killPidTreeBestEffort } = require("../process-tree-kill");

const log = getLogger("orphan-reaper");

/** `ps` rows as {pid, ppid, command}. Injected in tests. */
function readProcessTable() {
  const out = execFileSync("ps", ["-axo", "pid=,ppid=,command="], {
    encoding: "utf8",
    timeout: 5_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  return String(out)
    .split("\n")
    .map((line) => {
      const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
      if (!match) return null;
      return { pid: Number(match[1]), ppid: Number(match[2]), command: match[3] };
    })
    .filter(Boolean);
}

/**
 * Which rows are orphaned serves of THIS install.
 *
 * @param {Array<{pid:number,ppid:number,command:string}>} rows
 * @param {{ binaryPath: string, selfPid?: number, parentPid?: number }} opts
 */
function selectOrphanServes(rows, { binaryPath, selfPid = process.pid, parentPid = process.ppid } = {}) {
  const binary = String(binaryPath || "").trim();
  // An empty or relative binary path would match far too much. Refuse rather
  // than guess: no binary means nothing to reap.
  if (!binary || !binary.startsWith("/")) return [];
  return (Array.isArray(rows) ? rows : []).filter((row) => {
    if (!row || !Number.isFinite(row.pid) || row.pid <= 1) return false;
    if (row.pid === selfPid || row.pid === parentPid) return false;
    // Orphaned only. A live instance's serve is parented to that instance.
    if (row.ppid !== 1) return false;
    const command = String(row.command || "");
    // The prefix must end at a word boundary. A bare startsWith also matches a
    // DIFFERENT binary that merely shares the prefix — ".../opencode-old serve"
    // would have been reaped as if it were ours.
    if (command !== binary && !command.startsWith(`${binary} `)) return false;
    // The engine binary also runs as a per-session client; only reap serves.
    return /(^|\s)serve(\s|$)/.test(command.slice(binary.length));
  });
}

/**
 * Reap them. Returns how many were signalled.
 *
 * @returns {number}
 */
function reapOrphanEngineServes(deps = {}) {
  if (process.env.LILY_REAP_ORPHAN_SERVES === "0") return 0;
  // No orphan concept to key on: on Windows a dead parent's pid is not
  // rewritten to 1, so condition (2) — the only thing making this safe — cannot
  // be evaluated. The installer's own pre-clear covers that platform.
  const platform = deps.platform || process.platform;
  if (platform === "win32") return 0;
  try {
    const findBinary = deps.findBundledOpencodeBinary
      || require("../bundle-locator").findBundledOpencodeBinary;
    const binaryPath = deps.binaryPath || findBinary();
    if (!binaryPath) return 0;
    const rows = (deps.readProcessTable || readProcessTable)();
    const orphans = selectOrphanServes(rows, {
      binaryPath,
      selfPid: deps.selfPid ?? process.pid,
      parentPid: deps.parentPid ?? process.ppid,
    });
    if (!orphans.length) return 0;
    const killPid = deps.killPidTreeBestEffort || killPidTreeBestEffort;
    for (const orphan of orphans) {
      try {
        killPid(orphan.pid);
      } catch {
        /* one stubborn pid must not stop the rest */
      }
    }
    log.info(
      "reaped %d orphaned engine serve(s) left by a previous ungraceful exit: %s",
      orphans.length,
      orphans.map((o) => o.pid).join(", "),
    );
    return orphans.length;
  } catch (err) {
    log.warn("orphan serve reap failed open: %s", err?.message || err);
    return 0;
  }
}

module.exports = { reapOrphanEngineServes, selectOrphanServes, readProcessTable };
