#!/usr/bin/env node

import { createRequire } from "node:module";
import { assert, assertEqual, finish } from "./lib/test-assert.mjs";

const require = createRequire(import.meta.url);
const {
  formatWorkProgressDetail,
  inferWorkProgressFromCommand,
  inferWorkProgressLine,
  latestWorkProgress,
  parseWorkProgressLine,
} = require("../src/main/work-progress-protocol.js");

const progress = parseWorkProgressLine('[lily-progress] {"label":"scan","current":2,"total":5,"queued":3,"path":"https://example.com/a/b?x=1"}');
assertEqual(progress.label, "scan", "progress parser reads JSON marker");
assertEqual(progress.current, 2, "progress parser preserves numeric fields");

const latest = latestWorkProgress([
  "noise",
  '[lily-progress] {"label":"old","current":1}',
  '[lily-progress] {"label":"new","current":4,"total":9,"domain":"web"}',
].join("\n"));
assertEqual(latest.label, "new", "latest parser uses the newest valid marker");
assertEqual(latest.domain, "web", "latest parser preserves domain");

assert(parseWorkProgressLine("[lily-progress] nope") === null, "invalid marker is ignored");
assert(formatWorkProgressDetail(latest).includes("4/9"), "formatter includes count progress");
assert(formatWorkProgressDetail({ label: "plain" }) === "plain", "formatter handles label-only progress");
assertEqual(
  formatWorkProgressDetail({ label: "Progress", percent: 0 }),
  "Progress",
  "formatter suppresses zero-only percent because it reads as stuck progress",
);

const curl = inferWorkProgressLine(" 12  234M   12 30.1M    0     0  1234k      0  0:03:14  0:00:25  0:02:49 1245k");
assertEqual(curl.percent, 12, "curl progress parser reads percent");
assert(formatWorkProgressDetail(curl).includes("12%"), "formatter includes inferred percent");
assert(formatWorkProgressDetail(curl).includes("30 MB / 234 MB"), "formatter includes byte progress");

const aria = inferWorkProgressLine("[#abc 120MiB/420MiB(28%) CN:4 DL:2.4MiB ETA:2m]");
assertEqual(aria.percent, 28, "aria2 progress parser reads percent");
assert(formatWorkProgressDetail(aria).includes("2.4 MB/s"), "formatter includes speed");

const wget = inferWorkProgressLine("  8192K .......... ..........  42% 1.23M 1m");
assertEqual(wget.percent, 42, "wget progress parser reads percent");

const command = inferWorkProgressFromCommand('curl -L -o /tmp/blender.dmg "https://example.com/blender.dmg"');
assertEqual(command.phase, "downloading", "curl command infers initial download phase");
assertEqual(command.path, "/tmp/blender.dmg", "curl command infers output path");

const remoteName = inferWorkProgressFromCommand('curl.exe -L -O "https://example.com/blender.dmg" 2>&1');
assertEqual(remoteName.phase, "downloading", "curl remote-name command still infers download");
assertEqual(remoteName.path, "", "fd redirect is not treated as the remote-name output path");

const stdoutRedirect = inferWorkProgressFromCommand('curl -L "https://example.com/blender.dmg" > "D:/tmp/blender.dmg"');
assertEqual(stdoutRedirect.path, "D:/tmp/blender.dmg", "stdout redirect can infer an output path");

const healthProbe = inferWorkProgressFromCommand("curl.exe -sS --connect-timeout 3 http://127.0.0.1:8188/system_stats 2>&1 | select -First 20");
assert(healthProbe === null, "curl health probes with fd redirection are not guessed as downloads");

const stderrOnly = inferWorkProgressFromCommand("curl -sS https://example.com/api/config 2>err.log");
assert(stderrOnly === null, "stderr redirects are not treated as download output paths");

const latestInferred = latestWorkProgress("noise\r 55  100M   55 55M    0     0  1M      0  0:01:00  0:00:33  0:00:27 1M");
assertEqual(latestInferred.percent, 55, "latest parser handles carriage-return progress");
assert(inferWorkProgressLine("1 2 3 4") === null, "plain numeric output is not guessed as progress");

finish("test-work-progress-protocol", 23);
