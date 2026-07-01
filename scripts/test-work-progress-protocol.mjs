#!/usr/bin/env node

import { createRequire } from "node:module";
import { assert, assertEqual, finish } from "./lib/test-assert.mjs";

const require = createRequire(import.meta.url);
const {
  formatWorkProgressDetail,
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

finish("test-work-progress-protocol", 6);
