#!/usr/bin/env node
/**
 * The engine's silent retries must become visible — routed to exactly one
 * session, and never softening a real failure into "just retrying".
 *
 * Fixtures are the verbatim lines from the 2026-09-02 field log.
 */
import assert from "node:assert/strict";
import module from "node:module";
import { EventEmitter } from "node:events";

const require = module.createRequire(import.meta.url);
const {
  buildRetryNoticeDetail,
  parseServeDiagnostic,
  diagnosticBelongsToSession,
  parseServeDiagnostics,
  shortErrorText,
} = require("../src/main/runtime/opencode-serve-diagnostics.js");
const { createOpencodeTurnLiveness } = require("../src/main/opencode-turn-liveness.js");

const OVERLOADED = 'timestamp=2026-09-02T06:08:41.738Z level=ERROR run=a5337b27 message="stream error" providerID=lily-model-1be5c99ed63712f69f968508da1f60b4 modelID=deepseek-v4-pro session.id=ses_fa0f90c97ffet2HtHvQAoIH9Fm small=false agent=build mode=primary error.error="AI_APICallError: Server Overloaded"';

// --- the field line parses into a session-scoped retry ----------------------
{
  const info = parseServeDiagnostic(OVERLOADED);
  assert.equal(info.sessionID, "ses_fa0f90c97ffet2HtHvQAoIH9Fm");
  assert.equal(info.modelID, "deepseek-v4-pro");
  assert.equal(info.providerID, "lily-model-1be5c99ed63712f69f968508da1f60b4");
  assert.equal(info.message, "stream error");
  assert.equal(info.error, "AI_APICallError: Server Overloaded");
  assert.equal(info.agent, "build");
  assert.equal(shortErrorText(info.error), "Server Overloaded", "the SDK error class prefix is dropped");
}

// --- a multi-line chunk yields one diagnostic per line ----------------------
{
  const all = parseServeDiagnostics(`${OVERLOADED}\n${OVERLOADED.replace("06:08:41", "06:08:45")}\n`);
  assert.equal(all.length, 2);
}

// --- what must NOT become a "retrying" notice ------------------------------
// A genuine config error has to keep flowing to the normal terminal-failure
// classification; calling it a retry would hide a broken setup behind a
// reassuring progress line.
{
  const notRetryable = [
    OVERLOADED.replace('error.error="AI_APICallError: Server Overloaded"', 'error.error="AI_APICallError: invalid api key"'),
    OVERLOADED.replace('error.error="AI_APICallError: Server Overloaded"', 'error.error="NoSuchModelError: model not found"'),
    OVERLOADED.replace("level=ERROR", "level=INFO"),          // not an error line
    OVERLOADED.replace("session.id=ses_fa0f90c97ffet2HtHvQAoIH9Fm", ""), // no session → nobody to tell
    OVERLOADED.slice(0, 90),                                   // chunk split mid-line
    "plain text with no key values",
    "",
    null,
    undefined,
  ];
  for (const line of notRetryable) {
    assert.equal(parseServeDiagnostic(line), null, `must not classify as a retry: ${String(line).slice(0, 60)}`);
  }
}

// --- the transient family we DO narrate ------------------------------------
for (const err of [
  "AI_APICallError: Server Overloaded", "rate limit exceeded", "429 Too Many Requests",
  "503 Service Unavailable", "504 Gateway Timeout", "529 overloaded",
  "ETIMEDOUT", "ECONNRESET", "socket hang up", "fetch failed", "request timed out",
]) {
  const line = OVERLOADED.replace('error.error="AI_APICallError: Server Overloaded"', `error.error="${err}"`);
  assert(parseServeDiagnostic(line), `transient upstream error must be narrated: ${err}`);
}

// --- the notice text names WHO failed, WHAT it said, and the attempt --------
{
  const info = parseServeDiagnostic(OVERLOADED);
  const first = buildRetryNoticeDetail(info, 1);
  assert.match(first, /模型服务（deepseek-v4-pro）暂时不可用/, "names the model service, not Lily");
  assert.match(first, /Server Overloaded/);
  assert.match(first, /正在重试$/);
  assert.match(buildRetryNoticeDetail(info, 3), /正在重试 · 第 3 次/, "the attempt count is visible");
  // A diagnostic with no model still produces something honest.
  assert.match(buildRetryNoticeDetail({ error: "429" }, 1), /^模型服务暂时不可用/);
  assert.equal(buildRetryNoticeDetail({}, 1), "模型服务暂时不可用 · 正在重试");
}

// --- routing: a shared serve hosts many sessions ---------------------------
// Leaking one session's retry into another would be worse than staying quiet, so
// delivery requires an exact session-id match. `diagnosticBelongsToSession` is
// the single source of that decision — ServerManager calls the same function, so
// this asserts the real predicate rather than a copy of it.
{
  assert.equal(diagnosticBelongsToSession({ sessionID: "ses_a" }, "ses_a"), true);
  assert.equal(diagnosticBelongsToSession({ sessionID: "ses_a" }, "ses_b"), false);
  assert.equal(diagnosticBelongsToSession({ sessionID: "" }, "ses_a"), false);
  assert.equal(diagnosticBelongsToSession({}, "ses_a"), false);
  assert.equal(diagnosticBelongsToSession(null, "ses_a"), false);
  assert.equal(diagnosticBelongsToSession({ sessionID: "ses_a" }, ""), false, "an unbound session receives nothing");

  const shared = new EventEmitter();
  const delivered = [];
  const manager = { sessionID: "ses_mine", _terminated: false, emit: (n, i) => delivered.push([n, i]) };
  shared.on("diagnostic", (info) => {
    if (manager._terminated || !diagnosticBelongsToSession(info, manager.sessionID)) return;
    manager.emit("diagnostic", info);
  });
  shared.emit("diagnostic", { sessionID: "ses_other", error: "429" });
  shared.emit("diagnostic", { sessionID: "", error: "429" });
  shared.emit("diagnostic", { error: "429" });
  assert.equal(delivered.length, 0, "another session's retry must never be shown here");
  shared.emit("diagnostic", { sessionID: "ses_mine", error: "429", modelID: "m" });
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0][0], "diagnostic");
  manager._terminated = true;
  shared.emit("diagnostic", { sessionID: "ses_mine", error: "429" });
  assert.equal(delivered.length, 1, "a terminated session stops receiving diagnostics");
}

// --- liveness: counts attempts, shares the heartbeat slot, self-clears -----
{
  const drafts = [];
  let running = true;
  const liveness = createOpencodeTurnLiveness({
    sessionId: "s",
    activeTools: new Map([["t", { id: "t", name: "bash", title: "bash", startedAt: 0, lastActivityAt: 0 }]]),
    getState: () => ({ busy: running, turnSettled: !running }),
    getConfig: () => ({ activeToolLeaseMs: 0, progressNoticeMs: 45_000 }),
    ingest: (batch) => drafts.push(...batch),
    now: () => 5_000,
    setTimeout: () => null,
    clearTimeout: () => {},
  });
  const info = parseServeDiagnostic(OVERLOADED);
  assert.equal(liveness.noteEngineRetry(info), true);
  assert.equal(liveness.noteEngineRetry(info), true);
  const notice = drafts.at(-1).payload.notice;
  assert.equal(notice.code, "engineRetry");
  assert.match(notice.detail, /第 2 次/, "consecutive retries are counted");
  assert.equal(notice.replacesCode, "genericToolProgress", "shares the heartbeat slot so it self-clears");
  assert.equal(notice.level, "progress");

  // Real progress replaces the retry line rather than leaving it stale.
  drafts.length = 0;
  assert.equal(liveness.emitGenericToolProgressNotice(), true);
  assert.equal(drafts.at(-1).payload.notice.code, "toolProgress");

  // The counter is per turn.
  liveness.resetProgressNotice();
  liveness.noteEngineRetry(info);
  assert.match(drafts.at(-1).payload.notice.detail, /正在重试$/, "a new turn starts counting from one");

  // Never narrate outside a live turn.
  running = false;
  drafts.length = 0;
  assert.equal(liveness.noteEngineRetry(info), false);
  assert.equal(drafts.length, 0);
  assert.doesNotThrow(() => liveness.noteEngineRetry(undefined));
}

console.log("serve-diagnostics: ok");
