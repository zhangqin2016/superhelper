"use strict";

/**
 * The main process's log, on disk and bounded.
 *
 * It only ever went to the console, which in a packaged app goes nowhere: a
 * user who hit a bug, closed Lily and wrote in could not send the one artefact
 * that explains what happened, because it no longer existed. Support could ask
 * for a screenshot of a dialog and nothing else.
 *
 * Two things this has to get right that a naive file sink does not.
 *
 * It must capture `console` as well, not just the logger. Most main-process
 * logging bypasses `getLogger` entirely — roughly 115 call sites write through
 * `console.*` with a hand-written prefix — so a sink wired only into the logger
 * would miss the majority of the output and give false confidence.
 *
 * And it must carry the DATE. The console prefix is time-of-day only, which is
 * unambiguous while you watch it scroll and useless in a file that spans days:
 * "was that 05:21 this morning or last Tuesday" is exactly the question a log
 * exists to answer.
 *
 * Bounds come from the shared rotating sink, so this file and the watchdog's
 * cannot drift apart on how much disk a diagnostic is allowed to cost.
 */

const { createRotatingFileSink } = require("./rotating-file-sink");

const FILE_NAME = "main.log";
// A few days of ordinary use at the volume this process actually logs, small
// enough to attach to a support ticket. Four generations bound the total at 40 MB.
const MAX_BYTES = 8 * 1024 * 1024;
const MAX_FILES = 4;

const CONSOLE_METHODS = Object.freeze(["log", "info", "warn", "error", "debug"]);
const LEVEL_OF = Object.freeze({ log: "INFO", info: "INFO", warn: "WARN", error: "ERROR", debug: "DEBUG" });

let sink = null;
let restoreConsole = null;

/** ISO-like and sortable, with the date the console prefix omits. */
function stamp(now = new Date()) {
  return now.toISOString().replace("T", " ").slice(0, 23);
}

function formatArgs(args, formatImpl) {
  try {
    return formatImpl(...args);
  } catch {
    // A value whose inspection throws must not take the log line with it.
    return args.map((value) => {
      try { return String(value); } catch { return "[unprintable]"; }
    }).join(" ");
  }
}

/** Write one already-formatted line. No-op until start() has run. */
function writeLine(level, text) {
  if (!sink) return false;
  return sink.write(`${stamp()} ${String(level || "INFO").padEnd(5)} ${text}`);
}

/**
 * Begin persisting main-process output.
 *
 * @param {object} options
 * @param {string} [options.dir]   defaults to <userData>/logs
 * @param {object} [options.consoleImpl] injectable for tests
 * @param {Function} [options.formatImpl]
 * @returns {{ ok: boolean, filePath?: string, maxTotalBytes?: number, reason?: string }}
 */
function startMainLogFile(options = {}) {
  if (sink) return { ok: true, filePath: options.filePath || "", maxTotalBytes: sink.maxTotalBytes() };
  let filePath = options.filePath || "";
  if (!filePath) {
    try {
      filePath = require("node:path").join(require("../config").userDataPath("logs"), FILE_NAME);
    } catch (error) {
      // Before runtime paths are bound there is nowhere to write; the console
      // still works, which is exactly today's behaviour.
      return { ok: false, reason: error?.message || "USER_DATA_UNAVAILABLE" };
    }
  }
  sink = createRotatingFileSink({
    filePath,
    maxBytes: Number(options.maxBytes) || MAX_BYTES,
    maxFiles: Number.isInteger(options.maxFiles) ? options.maxFiles : MAX_FILES,
  });

  const target = options.consoleImpl || console;
  const formatImpl = options.formatImpl || require("node:util").format;
  const original = {};
  for (const method of CONSOLE_METHODS) {
    if (typeof target[method] !== "function") continue;
    original[method] = target[method].bind(target);
    target[method] = (...args) => {
      // The terminal keeps behaving exactly as before; the file is additive.
      original[method](...args);
      writeLine(LEVEL_OF[method], formatArgs(args, formatImpl));
    };
  }
  restoreConsole = () => {
    for (const [method, fn] of Object.entries(original)) target[method] = fn;
  };
  writeLine("INFO", `--- main log started (bound ${sink.maxTotalBytes()} bytes across ${MAX_FILES + 1} files) ---`);
  return { ok: true, filePath, maxTotalBytes: sink.maxTotalBytes() };
}

/** Restore the console and stop writing. Used by tests and on shutdown. */
function stopMainLogFile() {
  try { restoreConsole?.(); } catch { /* the console is already whatever it is */ }
  restoreConsole = null;
  sink?.close?.();
  sink = null;
}

/** Every path the main log may occupy — for a support bundle to collect. */
function mainLogPaths() {
  return sink?.paths?.() || [];
}

module.exports = {
  FILE_NAME,
  MAX_BYTES,
  MAX_FILES,
  mainLogPaths,
  startMainLogFile,
  stopMainLogFile,
  writeLine,
};
