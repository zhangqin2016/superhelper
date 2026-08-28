#!/usr/bin/env node
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { fixture, usageEvent, modelEvent, dispatch, tick } = require("./helpers/opencode-host-fixture.cjs");
const unhandled = [];
const onUnhandled = error => unhandled.push(error);
process.on("unhandledRejection", onUnhandled);
let failures = 0;
async function check(name, run, options = {}) {
  const f = fixture(options);
  try { await run(f); console.log(`PASS ${name}`); }
  catch (error) { failures++; console.error(`FAIL ${name}: ${error.stack}`); }
  finally { f.close(); await tick(); }
}

await check("host model replacement preserves history without a discarded startup", async f => {
  f.add("history");
  const a = (await f.ensure("history", "A")).runner;
  const b = (await f.ensure("history", "B")).runner;
  await tick();
  assert.notEqual(a, b);
  assert.equal(b.agentResumeId, "ses_history");
  assert.equal(f.rows.get(b.agentResumeId).history[0], "original-history-sentinel");
  assert.equal(f.stats.sdkCreates, 0);
  assert.equal(f.stats.poolEnsures, 3);
  assert.equal(b.spawnOptions.model.modelID, "B");
  assert.equal(unhandled.length, 0, "invalidated runner must not start again");
});

await check("real packaged env shares A/B/A but isolates credentials and policy", async f => {
  const runners = [];
  for (const [id, model] of [["one", "A"], ["two", "B"], ["three", "A"]]) {
    f.add(id); runners.push((await f.ensure(id, model)).runner);
  }
  assert.equal(f.stats.envBuilds, 3);
  assert.notEqual(runners[0].spawnOptions.env.CLAUDE_CONFIG_DIR, runners[2].spawnOptions.env.CLAUDE_CONFIG_DIR);
  assert.equal(runners[0]._server._shared, runners[2]._server._shared);
  assert.equal(new Set(runners.map(r => r._server._shared)).size, 2);
  assert.equal(runners[0]._server._shared.env.CLAUDE_CONFIG_DIR, undefined, "not just ignored in the hash: omit the obsolete process variable");
  const { getSharedServer } = f.load("runtime/opencode-shared-server");
  const base = runners[0]._server._shared;
  for (const [key, value] of [["LILY_API_KEY", "rotated"], ["HTTPS_PROXY", "http://proxy.invalid"], ["NODE_TLS_REJECT_UNAUTHORIZED", "0"], ["LILY_PERMISSION_MODE", "deny"], ["CUSTOM_TOOL_TOKEN", "secret"]]) {
    const distinct = getSharedServer({ ...base, env: { ...base.env, [key]: value } });
    assert.notEqual(distinct, base, `${key} remains process-defining`);
  }
});

await check("summarize owns a lease after its view detaches and reports final usage", async f => {
  f.add("background");
  const a = (await f.ensure("background", "A")).runner;
  const old = a._server._shared;
  f.holdSummary();
  const pending = a.compactContext({ providerID: "summary-provider", modelID: "summary-model" });
  assert.equal(f.summaryWaits.length, 1);
  const b = (await f.ensure("background", "B")).runner;
  assert.equal(old._activeViews, 0);
  assert.equal(old._terminated, false, "live work survives view release");
  dispatch(old, usageEvent("ses_background"));
  f.summaryWaits[0].resolve({ data: true });
  assert.equal(await pending, true);
  await tick();
  assert.equal(old._terminated, true, "retired profile exits after the last work lease");
  assert.equal(b.agentResumeId, "ses_background");
  assert.equal(f.usageCalls.length, 1);
  assert.equal(f.usageCalls[0].sessionId, "background");
  assert.equal(f.usageCalls[0].model.modelID, "summary-model");
  assert.equal(f.reports.reduce((n, r) => n + r.inputTokens, 0), 120);
});

await check("idle compaction usage flushes once without a user turn", async f => {
  f.add("idle");
  const r = (await f.ensure("idle", "A")).runner;
  assert.equal(await r.compactContext({ providerID: "summary-provider", modelID: "summary-model" }), true);
  await tick();
  dispatch(r._server, usageEvent("ses_idle"));
  await tick();
  assert.equal(f.usageCalls.length, 1);
  assert.equal(f.usageCalls[0].model.providerID, "summary-provider");
  assert.equal(f.reports.reduce((n, row) => n + row.inputTokens, 0), 120);
  assert.equal(f.usage.getPendingTodayTotals().inputTokens, 0);
});

await check("child work is host-owned and accounted while the chat is idle", async f => {
  f.add("parent"); f.add("other");
  const parent = (await f.ensure("parent", "A")).runner;
  const other = (await f.ensure("other", "A")).runner;
  const old = parent._server._shared;
  dispatch(old, { type: "session.created", properties: { info: { id: "ses_child", parentID: "ses_parent" } } });
  dispatch(old, usageEvent("ses_child"));
  assert.equal(f.usageCalls.length, 0, "wait for actual model metadata");
  dispatch(old, modelEvent("ses_child", "msg_usage", "child-provider", "child-model"));
  await tick();
  assert.equal(f.usageCalls.length, 1);
  assert.equal(f.usageCalls[0].sessionId, "parent");
  assert.equal(f.usageCalls[0].model.providerID, "child-provider");
  assert.equal(other._server._childSessionIDs.has("ses_child"), false);
  await f.ensure("parent", "B");
  other.terminate();
  assert.equal(old._activeViews, 0);
  assert.equal(old._terminated, false, "child execution outlives both detached views");
  dispatch(old, { type: "session.idle", properties: { sessionID: "ses_child" } });
  assert.equal(old._terminated, true);
});

await check("usage ownership and dedup survive same-database resume", async f => {
  f.add("owner");
  const a = (await f.ensure("owner", "A")).runner;
  const first = a._server;
  dispatch(first, modelEvent("ses_foreign"));
  dispatch(first, usageEvent("ses_foreign"));
  dispatch(first, { ...usageEvent("ses_owner"), __lilySubagentSessionID: "ses_foreign" }, "/wrong-directory");
  dispatch(first, usageEvent(undefined));
  assert.equal(f.usageCalls.length, 0);
  dispatch(first, usageEvent("ses_owner"));
  assert.equal(f.usageCalls.length, 0, "no guessed model from active chat");
  dispatch(first, modelEvent("ses_owner"));
  await tick();
  const b = (await f.ensure("owner", "B")).runner;
  dispatch(b._server, modelEvent("ses_owner"));
  dispatch(b._server, usageEvent("ses_owner"));
  await tick();
  assert.equal(f.usageCalls.length, 1, "new view must not reset engine-event dedup");
  assert.equal(f.usageCalls[0].model.modelID, "actual-model");
  assert.equal(f.reports.reduce((n, row) => n + row.inputTokens, 0), 120);
  f.add("impostor"); f.sessions.get("impostor").agentResumeId = "ses_owner";
  const impostor = (await f.ensure("impostor", "B")).runner;
  const foreign = usageEvent("ses_owner"); foreign.properties.part.id = "part_second";
  dispatch(impostor._server, foreign);
  await tick();
  assert.ok(f.usageCalls.every(call => call.sessionId === "owner"), "engine ownership cannot be reattributed by a second view");
});

await check("foreground usage retains its send bucket and reducer cannot double count", async f => {
  f.add("active");
  const r = (await f.ensure("active", "A")).runner;
  r.busy = true; r._turnSettled = false;
  f.usage.recordUserSend("active", [], { providerID: "selected", modelID: "selected-model" });
  dispatch(r._server, modelEvent("ses_active"));
  dispatch(r._server, usageEvent("ses_active"));
  dispatch(r._server, usageEvent("ses_active"));
  dispatch(r._server, { type: "session.next.step.ended", properties: {
    sessionID: "ses_active", assistantMessageID: "v2_mirror", tokens: { input: 120, output: 8 },
  } });
  await tick();
  assert.equal(f.usageCalls.length, 1, "account canonical step-finish, not its experimental mirror or UI effect");
  assert.equal(f.reports.length, 0, "do not flush an active send's accounting bucket");
  assert.equal(f.usage.getPendingTodayTotals().inputTokens, 120);
  assert.ok(f.projections.some(d => d.type === "usage.updated"), "foreground UI usage is preserved");
  r.busy = false; r._turnSettled = true;
  const late = usageEvent("ses_active"); late.properties.part.id = "late_part";
  dispatch(r._server, late);
  await tick();
  assert.equal(f.reports.reduce((n, row) => n + row.inputTokens, 0), 240);
});

await check("HTTP timeout leaves the raw summarize lease owned until late settlement", async f => {
  f.add("timeout");
  const a = (await f.ensure("timeout", "A")).runner;
  const old = a._server._shared;
  f.holdSummary();
  assert.equal(await a.compactContext({}), false, "SDK timeout remains fail-open to the caller");
  await f.ensure("timeout", "B");
  assert.equal(old._terminated, false, "timeout is not engine completion");
  dispatch(old, usageEvent("ses_timeout"));
  f.summaryWaits[0].resolve({ data: true });
  await tick();
  assert.equal(old._terminated, true);
  assert.equal(f.usageCalls.length, 1);
}, { sdkTimeoutMs: 10 });

await check("explicit abort releases cancelled summarize work", async f => {
  f.add("cancel");
  const a = (await f.ensure("cancel", "A")).runner;
  const view = a._server, old = view._shared;
  f.holdSummary();
  const pending = a.compactContext({});
  assert.equal(await view.abort(), true);
  await f.ensure("cancel", "B");
  assert.equal(old._terminated, true, "confirmed cancellation ends the execution lease");
  await pending;
});

await check("parent task completion cannot reopen a finished child lease in the UI reducer", async f => {
  f.add("task");
  const r = (await f.ensure("task", "A")).runner;
  const old = r._server._shared;
  r.busy = true; r._turnSettled = false;
  const taskEvent = status => ({ type: "message.part.updated", properties: { part: {
    id: "part_task", messageID: "msg_task", sessionID: "ses_task", type: "tool", tool: "task", callID: "call_task",
    state: { status, input: {}, output: "done", metadata: { sessionId: "ses_task_child" } },
  } } });
  dispatch(old, taskEvent("running"));
  dispatch(old, modelEvent("ses_task_child"));
  dispatch(old, usageEvent("ses_task_child"));
  assert.ok(f.projections.some(d => d.type === "subagent.event"));
  dispatch(old, { type: "session.idle", properties: { sessionID: "ses_task_child" } });
  dispatch(old, taskEvent("completed"));
  r.busy = false; r._turnSettled = true;
  await f.ensure("task", "B");
  assert.equal(old._terminated, true, "registerFromDrafts is not a new child execution");
});

await check("different directory views of the same database keep event receipts", async f => {
  f.add("move");
  const a = (await f.ensure("move", "A")).runner;
  dispatch(a._server, modelEvent("ses_move"));
  dispatch(a._server, usageEvent("ses_move"));
  const { OpencodeServerManager } = f.load("runtime/opencode-server-manager");
  const moved = new OpencodeServerManager({
    serverCommand: a._server.serverCommand, dataDir: a._server.dataDir, cwd: "/relocated",
    ownerSessionId: "move", resumeSessionID: "ses_move", env: a._server.env, configContent: a._server.configContent,
  });
  try {
    await moved.start(); await moved.createSession(); moved.subscribe();
    dispatch(moved, modelEvent("ses_move"), "/relocated");
    dispatch(moved, usageEvent("ses_move"), "/relocated");
    assert.equal(f.usageCalls.length, 1, "database session identity does not include view directory");
  } finally { moved.terminate(); }
});

await check("hard exit ends retired child and request leases before late transport settlement", async f => {
  f.add("crash");
  const a = (await f.ensure("crash", "A")).runner;
  const view = a._server, old = view._shared;
  dispatch(old, { type: "session.created", properties: { info: { id: "ses_crash_child", parentID: "ses_crash" } } });
  dispatch(old, modelEvent("ses_crash_child"));
  dispatch(old, usageEvent("ses_crash_child"));
  f.holdSummary();
  let result;
  const pending = a.compactContext({}).then(value => { result = value; });
  const second = a.compactContext({});
  await f.ensure("crash", "B");
  assert.equal(old._activeWork, 3);
  await f.hardExit(old);
  await tick();
  assert.equal(result, false, "process death rejects outstanding requests without waiting for HTTP timeout");
  assert.equal(old._activeWork, 0);
  assert.equal(view._work.hasWork(), false);
  assert.equal(view._unsub, null);
  assert.equal(view._shared, null);
  assert.equal(old.listenerCount("exit"), 0);
  assert.equal(old._eventHandlers.size, 0);
  const count = f.usageCalls.length;
  f.summaryWaits[0].resolve({ data: true });
  f.summaryWaits[1].reject(new Error("late connection reset"));
  await pending; await tick();
  assert.equal(await second, false);
  dispatch(old, usageEvent("ses_crash"));
  assert.equal(result, false, "late resolution cannot mark failed compaction successful");
  assert.equal(f.usageCalls.length, count);
  assert.equal(old._activeWork, 0);
  assert.equal(unhandled.length, 0);
});

await check("hard exit cleans a child-only retired view without an idle event", async f => {
  f.add("child_crash");
  const a = (await f.ensure("child_crash", "A")).runner;
  const view = a._server, old = view._shared;
  view.allowChildSession("ses_orphan_child");
  await f.ensure("child_crash", "B");
  await f.hardExit(old);
  assert.equal(old._activeWork, 0);
  assert.equal(view._unsub, null);
  assert.equal(old.listenerCount("exit"), 0);
});

await check("usage receipts retain only normalized token state and never reset on completion", async f => {
  f.add("receipts");
  const r = (await f.ensure("receipts", "A")).runner;
  const event = usageEvent("ses_receipts");
  event.properties.part.tokens.unrelated = { payload: "not-token-data" };
  dispatch(r._server, event);
  event.properties.part.tokens.input = 900;
  dispatch(r._server, modelEvent("ses_receipts"));
  assert.equal(f.usageCalls[0].delta.input_tokens, 120, "retain only a snapshot of numeric usage, not the raw event object");
  const completed = modelEvent("ses_receipts");
  completed.properties.info.time = { created: 1, completed: 2 };
  dispatch(r._server, completed);
  for (let n = 0; n < 100; n++) dispatch(r._server, {
    type: "message.updated", properties: { info: { id: `msg_user_${n}`, sessionID: "ses_receipts", role: "user" } },
  });
  const diagnostics = r._server.diagnostics().work;
  assert.equal(diagnostics.usageMessages, 1, "user/non-token messages do not populate the receipt ledger");
  assert.equal(diagnostics.usageParts, 1);
  assert.equal(diagnostics.pendingTokenParts, 0, "accounted parts discard pending payloads");
  const next = (await f.ensure("receipts", "B")).runner;
  dispatch(next._server, usageEvent("ses_receipts"));
  dispatch(next._server, completed);
  assert.equal(f.usageCalls.length, 1, "compaction of retained state must not re-enable replay counts");
});

await check("retiring a serve cancels the SDK event iterator, including its retries", async f => {
  const { OpencodeSharedServer } = f.load("runtime/opencode-shared-server");
  const shared = new OpencodeSharedServer({ serverCommand: "fixture", cwd: "/fixture", dataDir: ":memory:" });
  let signal;
  shared._baseClient = { global: { event: async options => {
    signal = options?.signal;
    return { stream: { async *[Symbol.asyncIterator]() {
      if (signal) await new Promise(resolve => signal.addEventListener("abort", resolve, { once: true }));
    } } };
  } } };
  const pending = shared._subscribeEvents();
  await tick();
  shared.terminate();
  assert.equal(signal?.aborted, true, "SDK reconnect loop must end with the process");
  await pending;
});

process.off("unhandledRejection", onUnhandled);
if (failures) process.exitCode = 1;
