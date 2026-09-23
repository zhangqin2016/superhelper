#!/usr/bin/env node
/**
 * A diagnostic must be retrievable, and it must cost a bounded amount of disk.
 *
 * Lily had one of each failure. The main-process log went only to the console,
 * so in a packaged app a user who hit a bug and closed Lily had nothing to
 * send. The watchdog did write a file — with no rotation, no cap, and no reader
 * anywhere in the repository: 47 MB and 176,711 lines across 86 days on a real
 * install, half a megabyte a day, forever, for nothing.
 *
 * Both now go through one sink whose worst case is chosen up front.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createRotatingFileSink, generationPath } = require("../src/main/diagnostics/rotating-file-sink.js");
const mainLog = require("../src/main/diagnostics/main-log-file.js");

let checks = 0;
const check = (label) => { checks += 1; console.log(`ok - ${label}`); };
const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), "lily-log-bounds-"));
const totalBytes = (sink) => sink.paths().reduce((sum, file) => sum + (fs.existsSync(file) ? fs.statSync(file).size : 0), 0);

// ------------------------------------------------------------ the bound
{
  const dir = tmpdir();
  const file = path.join(dir, "app.log");
  const sink = createRotatingFileSink({ filePath: file, maxBytes: 2048, maxFiles: 2 });
  // Far more than the bound: this is exactly the shape that produced 47 MB.
  for (let i = 0; i < 5_000; i += 1) sink.write(`line ${i} ${"x".repeat(80)}`);
  const onDisk = totalBytes(sink);
  assert.ok(onDisk <= sink.maxTotalBytes(), `bounded: ${onDisk} <= ${sink.maxTotalBytes()}`);
  assert.ok(onDisk > 0, "and it did write something");
  assert.equal(sink.paths().length, 3, "one live file plus two generations, and never more");
  assert.equal(fs.existsSync(generationPath(file, 3)), false, "nothing accumulates past the last generation");
  fs.rmSync(dir, { recursive: true, force: true });
  check("writing forever stays under the size the caller chose");
}

{
  const dir = tmpdir();
  const sink = createRotatingFileSink({ filePath: path.join(dir, "a.log"), maxBytes: 512, maxFiles: 0 });
  for (let i = 0; i < 500; i += 1) sink.write("x".repeat(100));
  assert.ok(totalBytes(sink) <= sink.maxTotalBytes(), "keeping no generations is still bounded, not unbounded");
  assert.equal(sink.paths().length, 1);
  fs.rmSync(dir, { recursive: true, force: true });
  check("asking for no history keeps one bounded file rather than an endless one");
}

{
  const dir = tmpdir();
  const file = path.join(dir, "keep.log");
  const sink = createRotatingFileSink({ filePath: file, maxBytes: 200, maxFiles: 2 });
  sink.write("FIRST-GENERATION-MARKER");
  for (let i = 0; i < 40; i += 1) sink.write(`filler ${i} ${"y".repeat(40)}`);
  const rotated = sink.paths().slice(1).filter((p) => fs.existsSync(p));
  assert.ok(rotated.length > 0, "older output is kept in rotated generations, not discarded on the spot");
  assert.ok(fs.readFileSync(file, "utf8").includes("filler"), "the live file holds the newest output");
  fs.rmSync(dir, { recursive: true, force: true });
  check("rotation keeps recent history instead of truncating to nothing");
}

// -------------------------------------------------------- never a liability
{
  const dir = tmpdir();
  const sink = createRotatingFileSink({ filePath: path.join(dir, "x.log"), maxBytes: 1024 });
  sink.write("before");
  fs.rmSync(dir, { recursive: true, force: true });
  assert.doesNotThrow(() => sink.write("after the directory vanished"), "logging never throws into whatever path was logging");
  const broken = createRotatingFileSink({
    filePath: path.join(tmpdir(), "y.log"),
    fsImpl: { mkdirSync() { throw new Error("EACCES"); }, existsSync: () => false, statSync: () => ({ size: 0 }), appendFileSync() {}, renameSync() {}, rmSync() {} },
  });
  assert.equal(broken.write("anything"), false, "an unwritable location reports failure rather than raising");
  assert.doesNotThrow(() => createRotatingFileSink({}).write("no path at all"));
  check("a full disk, a removed directory or a bad path can never break the caller");
}

// ------------------------------------------------- the main log, end to end
{
  const dir = tmpdir();
  const file = path.join(dir, "main.log");
  const seen = [];
  const fakeConsole = {
    log: (...a) => seen.push(["log", a]),
    info: (...a) => seen.push(["info", a]),
    warn: (...a) => seen.push(["warn", a]),
    error: (...a) => seen.push(["error", a]),
    debug: (...a) => seen.push(["debug", a]),
  };
  const started = mainLog.startMainLogFile({ filePath: file, maxBytes: 4096, maxFiles: 1, consoleImpl: fakeConsole });
  assert.equal(started.ok, true);

  // The majority of main-process output goes through console, not the logger;
  // a sink wired only into the logger would miss it and look like it worked.
  fakeConsole.warn("[runner-pool] model route audit: route=%s", "gateway");
  fakeConsole.error("boom");
  mainLog.stopMainLogFile();

  const text = fs.readFileSync(file, "utf8");
  assert.match(text, /model route audit: route=gateway/, "console output reaches the file, formatted");
  assert.match(text, /ERROR/, "the level is recorded");
  assert.match(text, /^\d{4}-\d{2}-\d{2} /m, "every line carries the DATE, not just a time of day");
  assert.equal(seen.filter(([level]) => level === "warn").length, 1, "the terminal still sees exactly what it saw before");
  assert.equal(typeof fakeConsole.warn, "function");
  fs.rmSync(dir, { recursive: true, force: true });
  check("main-process output is persisted with a date, and the console is untouched");
}

{
  const dir = tmpdir();
  const file = path.join(dir, "main.log");
  const noop = () => {};
  const fake = { log: noop, info: noop, warn: noop, error: noop, debug: noop };
  mainLog.startMainLogFile({ filePath: file, maxBytes: 2048, maxFiles: 2, consoleImpl: fake });
  for (let i = 0; i < 3_000; i += 1) fake.warn(`noisy repeated line ${i} ${"z".repeat(60)}`);
  const paths = mainLog.mainLogPaths();
  const used = paths.reduce((sum, p) => sum + (fs.existsSync(p) ? fs.statSync(p).size : 0), 0);
  mainLog.stopMainLogFile();
  assert.ok(used <= 2048 * 3, `the main log is bounded too: ${used}`);
  fs.rmSync(dir, { recursive: true, force: true });
  check("the main log obeys the same bound, however noisy the process gets");
}

{
  // A value that explodes when inspected must not take the log line with it.
  const dir = tmpdir();
  const file = path.join(dir, "main.log");
  const noop = () => {};
  const fake = { log: noop, info: noop, warn: noop, error: noop, debug: noop };
  mainLog.startMainLogFile({ filePath: file, consoleImpl: fake, formatImpl: () => { throw new Error("inspect exploded"); } });
  assert.doesNotThrow(() => fake.warn({ get boom() { throw new Error("nope"); } }));
  mainLog.stopMainLogFile();
  assert.ok(fs.existsSync(file), "the line still landed, degraded rather than lost");
  fs.rmSync(dir, { recursive: true, force: true });
  check("an unprintable value degrades the line instead of breaking logging");
}

// ------------------------------------------- the watchdog shares the bound
{
  const source = fs.readFileSync(new URL("../src/main/app-watchdog.js", import.meta.url), "utf8");
  assert.match(source, /createRotatingFileSink/, "the watchdog writes through the shared sink");
  assert.doesNotMatch(source, /appendFileSync\(\s*path\.join\(dir, "watchdog\.jsonl"\)/, "and no longer appends to an uncapped file");
  check("the watchdog file is bounded by the same rule as the log");
}

console.log(`diagnostic-log-bounds: ok (${checks} checks)`);
