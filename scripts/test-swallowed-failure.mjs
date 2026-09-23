#!/usr/bin/env node
/**
 * A capability that stops working must say so, without becoming the next flood.
 *
 * Lily degrades open by design, and that is right: when something cannot run,
 * the turn proceeds without it rather than dying. What was wrong is doing it in
 * silence — a capability that quietly declined looks exactly like one that was
 * never needed, so the answer is simply worse and nothing says why. Measured
 * 2026-09-23: the objective-coverage audit failed on every turn of a session
 * behind a bare `catch`, and whether that was a timeout, a dead endpoint, a
 * refused request or malformed JSON was unknowable from outside.
 *
 * The opposite mistake is just as real. Most catches in this codebase handle a
 * predictable condition — absent file, maybe-JSON, feature switched off — and
 * narrating those would bury the failures that matter under thousands of lines
 * a day, which is exactly the problem the bounded log sink was built to end. So
 * this records the other kind, and is deduplicated and bounded by construction.
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const swallowed = require("../src/main/diagnostics/swallowed-failure.js");

let checks = 0;
const check = (label) => { checks += 1; console.log(`ok - ${label}`); };

// Capture what reaches the log without letting it reach the terminal.
function captureWarnings(run) {
  const lines = [];
  const original = console.warn;
  console.warn = (...args) => lines.push(args.map(String).join(" "));
  try { run(); } finally { console.warn = original; }
  return lines;
}

// ------------------------------------------------------------ it speaks
{
  swallowed.resetSwallowedFailuresForTests();
  const lines = captureWarnings(() => {
    swallowed.recordSwallowedFailure("objective coverage audit", new Error("fetch failed"), { turn: "turn_1" });
  });
  assert.equal(lines.length, 1, "a degraded capability is reported");
  assert.match(lines[0], /objective coverage audit/, "named in the user's terms, not by module path");
  assert.match(lines[0], /fetch failed/, "and the CAUSE, which is the whole point");
  assert.match(lines[0], /turn=turn_1/, "attributable to the turn it happened in");
  assert.match(lines[0], /continuing without it/, "and it says the turn carried on, because it did");
  check("a swallowed failure reports what stopped working, why, and where");
}

{
  swallowed.resetSwallowedFailuresForTests();
  const lines = captureWarnings(() => {
    swallowed.recordSwallowedFailure("x", Object.assign(new Error("boom"), { code: "ECONNRESET" }));
  });
  assert.match(lines[0], /ECONNRESET: boom/, "an error code is part of the cause");
  const plain = captureWarnings(() => swallowed.recordSwallowedFailure("y", "no connection"));
  assert.match(plain[0], /no connection/, "a string cause is taken as given");
  const none = captureWarnings(() => swallowed.recordSwallowedFailure("z", null));
  assert.match(none[0], /unknown/, "an absent cause says so rather than printing nothing");
  check("codes, strings and absent causes are all rendered honestly");
}

// ------------------------------------------------- it cannot become a flood
{
  swallowed.resetSwallowedFailuresForTests();
  const lines = captureWarnings(() => {
    for (let i = 0; i < 500; i += 1) {
      swallowed.recordSwallowedFailure("objective coverage audit", new Error("fetch failed"), { turn: `turn_${i}` });
    }
  });
  assert.equal(lines.length, swallowed.MAX_REPORTS_PER_CAUSE, "500 occurrences cost a handful of lines, not 500");
  assert.match(lines.at(-1), /not repeated/, "and the last one says the rest are being suppressed");
  const [record] = swallowed.degradedCapabilities();
  assert.equal(record.count, 500, "suppressing the LINES never loses the COUNT");
  check("a permanently broken capability costs a handful of lines, and still counts every occurrence");
}

{
  swallowed.resetSwallowedFailuresForTests();
  const lines = captureWarnings(() => {
    swallowed.recordSwallowedFailure("site", new Error("cause one"));
    swallowed.recordSwallowedFailure("site", new Error("cause two"));
    swallowed.recordSwallowedFailure("other", new Error("cause one"));
  });
  assert.equal(lines.length, 3, "a different cause, or a different site, is a different thing worth hearing about");
  check("deduplication groups by site and cause, not by site alone");
}

{
  // A caller that varies its message must not be able to grow this without end.
  swallowed.resetSwallowedFailuresForTests();
  captureWarnings(() => {
    for (let i = 0; i < swallowed.MAX_TRACKED_CAUSES + 200; i += 1) {
      swallowed.recordSwallowedFailure("noisy", new Error(`unique cause ${i}`));
    }
  });
  assert.ok(swallowed.degradedCapabilities({ limit: 100 }).length <= 100);
  const result = swallowed.recordSwallowedFailure("noisy", new Error("one more entirely new cause"));
  assert.equal(result.reported, false, "past the tracking bound, new causes are dropped rather than growing memory");
  check("an endlessly varying cause cannot grow memory without bound");
}

{
  // Reporting a degradation must never itself degrade anything.
  const original = console.warn;
  console.warn = () => { throw new Error("the log itself is broken"); };
  try {
    assert.doesNotThrow(() => swallowed.recordSwallowedFailure("site", new Error("x")));
  } finally { console.warn = original; }
  assert.doesNotThrow(() => swallowed.recordSwallowedFailure(null, undefined, null));
  check("recording a failure can never become a failure");
}

// ------------------------------------------------ it reaches the diagnostic
{
  swallowed.resetSwallowedFailuresForTests();
  const { degradedCapabilitiesCheck } = require("../src/main/support-diagnostics-recent-failures.js");
  assert.equal(degradedCapabilitiesCheck({ degraded: [] }).status, "ok", "nothing degraded is not a problem");
  captureWarnings(() => {
    swallowed.recordSwallowedFailure("objective coverage audit", new Error("fetch failed"));
    swallowed.recordSwallowedFailure("objective coverage audit", new Error("fetch failed"));
  });
  const result = degradedCapabilitiesCheck();
  assert.equal(result.status, "warning");
  assert.match(result.detail, /objective coverage audit/, "the support report names the capability");
  assert.match(result.detail, /fetch failed/, "and its cause");
  assert.match(result.detail, /×2/, "and how often");
  check("a support report can name what quietly stopped working");
}

// --------------------------------------- the site with field evidence is wired
{
  const source = (await import("node:fs")).readFileSync(
    new URL("../src/main/task-original-acceptance.js", import.meta.url), "utf8",
  );
  assert.match(source, /recordSwallowedFailure/, "the audit that failed every turn now reports its cause");
  assert.doesNotMatch(
    source,
    /\} catch \{ return unknown\("judge_unavailable_or_invalid"\); \}/,
    "and no longer discards it",
  );
  assert.match(source, /judge_unavailable_or_invalid/, "while still declining to claim coverage it could not establish");
  check("the audit that failed on every turn of a real session now says why");
}

console.log(`swallowed-failure: ok (${checks} checks)`);
