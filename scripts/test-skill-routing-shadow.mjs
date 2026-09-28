#!/usr/bin/env node
// Skill routing runs in shadow (the OpenAI/Codex method): the hand-written
// router still ranks every turn, but the model picks from the catalog, and each
// guide the model actually reads scores every selector (hit + rank, by query
// script). Replayed on the field engine DB the router's pick was right 17% of
// the time and disagreed with the model's own choice 67/107 times (2026-09-29).
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const tempUserData = fs.mkdtempSync(path.join(os.tmpdir(), "lily-skill-shadow-"));
process.env.LILY_USER_DATA_DIR = tempUserData;
process.on("exit", () => fs.rmSync(tempUserData, { recursive: true, force: true }));
delete process.env.LILY_SKILL_ROUTING_SHADOW;

const broker = require("../src/main/capability-broker.js");
const shadow = require("../src/main/skill-routing-shadow.js");
const logFile = path.join(tempUserData, shadow.LOG_FILE);
const readLog = () => (fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);

const request = "帮我分析这个表格里的异常数据，给出结论";
const files = [{ name: "sales.xlsx", path: "/tmp/sales.xlsx" }];

// 1. The prompt carries no router picks; platform routes stay.
{
  const context = broker.compactCapabilityContext({ text: request, files, maxChars: 1800 });
  assert.doesNotMatch(context, /Skill capability graph|Best match for this request/, "the router's picks are not written into the prompt");
  assert.match(context, /Supporting platform routes/, "platform routes (dependency install, process jobs) are unchanged");
  process.env.LILY_SKILL_ROUTING_SHADOW = "0";
  const legacy = broker.compactCapabilityContext({ text: request, files, maxChars: 1800 });
  assert.match(legacy, /Skill capability graph/, "LILY_SKILL_ROUTING_SHADOW=0 restores the injected listing");
  delete process.env.LILY_SKILL_ROUTING_SHADOW;
}

// 2. Every turn is ranked by every selector; nothing of the request is logged.
const state = {};
const begun = shadow.beginTurn(state, { text: request, files });
assert.ok(begun && state.skillRoutingShadow === begun, "the turn remembers its rankings");
assert.deepEqual(Object.keys(begun.rankings), ["rules", "bm25"], "the hand-written router and a generic lexical selector both run");
assert.equal(begun.script, "cjk");
assert.ok(begun.rankings.bm25.slice(0, 3).includes("lily-excel-data-analysis"), `generic BM25 reads the skill's own description: ${begun.rankings.bm25.slice(0, 3)}`);

// 3. A guide the model reads scores every selector, once per skill per turn.
const guide = "/Users/u/Library/Application Support/lily-workbench/lily-config/skills/lily-excel-data-analysis/SKILL.md";
const events = shadow.recordInvocation(state, { name: "read", input: { filePath: guide } });
assert.equal(events.length, 2, "one event per selector");
for (const event of events) {
  assert.equal(event.skill, "lily-excel-data-analysis");
  assert.equal(event.inCatalog, true);
  const expected = state.skillRoutingShadow.rankings[event.method].indexOf("lily-excel-data-analysis") + 1;
  assert.equal(event.hit, expected > 0, `${event.method}: hit follows its own ranking`);
  assert.equal(event.rank, shadow.rankBucket(expected), `${event.method}: rank bucket`);
}
assert.equal(shadow.recordInvocation(state, { name: "read", input: { filePath: guide } }), null, "a second read of the same guide is not counted twice");
const outside = shadow.recordInvocation(state, { name: "bash", input: { command: "cat ~/lily-config/skills/lily-vision/SKILL.md" } });
assert.ok(outside.every((event) => event.inCatalog === false && event.rank === "miss"), "a skill the router does not know is recorded as outside its catalog");
assert.equal(shadow.skillIdFromTool({ name: "skill", input: { name: "brainstorming" } }), "brainstorming", "the native skill tool counts as an invocation");
assert.equal(shadow.skillIdFromTool({ name: "read", input: { filePath: "/repo/README.md" } }), "", "an ordinary read is not a skill invocation");

const log = readLog();
assert.equal(log.filter((e) => e.kind === "turn").length, 1, "one turn event (the read-rate denominator)");
assert.equal(log.filter((e) => e.kind === "invocation").length, 4, "two skills x two selectors");
assert.ok(log.every((e) => e.shadow === true), "events say they were taken in shadow mode");
assert.doesNotMatch(fs.readFileSync(logFile, "utf8"), /分析|表格|异常|sales/, "the log holds no user text or file names");

// 4. Fail open: nothing here may break a turn.
assert.equal(shadow.beginTurn(null), null);
assert.equal(shadow.recordInvocation(null, { name: "read" }), null);
assert.equal(shadow.recordInvocation({}, { name: "read", input: { filePath: guide } }), null, "no shadow state, nothing recorded");

// 5. Wired where the turn is built and where tools complete.
const orchestrator = fs.readFileSync(new URL("../src/main/turn-orchestrator.js", import.meta.url), "utf8");
const router = fs.readFileSync(new URL("../src/main/turn-runtime-event-router.js", import.meta.url), "utf8");
assert.match(orchestrator, /require\("\.\/skill-routing-shadow"\)\.beginTurn\(state,/, "each turn is ranked in shadow");
assert.match(router, /require\("\.\/skill-routing-shadow"\)\.recordInvocation\(state, tool\)/, "each completed tool is checked for a guide read");

console.log("skill-routing-shadow: ok");
