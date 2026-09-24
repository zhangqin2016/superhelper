#!/usr/bin/env node
// Answering the desktop from the phone. A task that needs a permission, a plan
// approval, a hook decision or an answer stops until someone acts; remote
// control is only real if the phone can act. This holds:
//   - each pending prompt reaches the phone as WHAT is asked (kind, tool,
//     operation, accepted actions) — only operation fields of a permission,
//     never the tool's raw input — and the phone words it exactly as the
//     desktop's own cards do (every string held equal to the desktop locale);
//   - the phone's answer reaches the orchestrator seam the desktop's cards use,
//     with the same decision shapes, and only for a prompt still pending in the
//     session this phone drives;
//   - the mirror sends the whole pending list whenever it changes, and the
//     snapshot carries it for a phone that reconnects mid-wait;
//   - the phone model shows, answers and drops cards by the desktop's word.
// [gate: mobile-prompts]
// Run: node scripts/test-mobile-prompts.mjs
import assert from "node:assert/strict";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { phonePrompts, desktopResponse, KEEP_PLANNING_MESSAGE } = require(path.join(ROOT, "src/main/mobile/prompt-view.js"));
const { createPhoneController } = require(path.join(ROOT, "src/main/mobile/phone-controller.js"));
const { createSessionMirror } = require(path.join(ROOT, "src/main/mobile/session-mirror.js"));
const zh = require(path.join(ROOT, "src/renderer/i18n/locales/zh-CN.json"));
const { initialConversation, reduce } = await import(pathToFileURL(path.join(ROOT, "web/lib/mobile/conversation.mjs")).href);
const { toDesktop, TO_PHONE, FROM_PHONE } = await import(pathToFileURL(path.join(ROOT, "web/lib/mobile/protocol.mjs")).href);
const { promptCardView, PROMPT_COPY, TOOL_LABELS } = await import(pathToFileURL(path.join(ROOT, "web/lib/mobile/prompt-copy.mjs")).href);

let checks = 0;
const check = async (name, fn) => { await fn(); checks += 1; console.log(`ok - ${name}`); };

const permission = { requestId: "perm_1", toolName: "bash", title: "npm test", input: { command: "npm test", env: { API_KEY: "sk-secret" }, description: "x" } };
const external = { requestId: "perm_2", toolName: "external_directory", input: { path: "C:\\Users\\ROG\\Documents" } };
const plan = { requestId: "plan_1", toolName: "ExitPlanMode", planPreview: "1. 读日志\n2. 修复", input: {} };
const hook = { requestId: "hook_1", hookName: "pre-commit", input: {} };
const question = { requestId: "q_1", questions: [{ question: "用哪个数据库？", header: "db", multiSelect: false, options: [{ label: "Postgres", description: "推荐" }, { label: "SQLite" }] }] };

await check("the phone words each prompt exactly as the desktop's own cards do", () => {
  const camel = (name) => name.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
  for (const [tool, label] of Object.entries(TOOL_LABELS)) assert.equal(label, zh[`permission.kind.${camel(tool)}`], `tool ${tool}`);
  const same = { permissionTitle: "permission.approveActionTitle", planTitle: "plan.readyTitle", hookTitle: "turn.hook.confirmTitle", questionTitle: "turn.question.cardTitle", subagentQuestionTitle: "subagent.questionCardTitle", subagentPrefix: "subagent.promptPrefix", toolFallback: "turn.permission.toolFallback", questionFallback: "question.freeAnswerPrompt" };
  for (const [key, localeKey] of Object.entries(same)) assert.equal(PROMPT_COPY[key], zh[localeKey], key);
  assert.equal(KEEP_PLANNING_MESSAGE, zh["plan.keepPlanningMessage"], "the instruction sent to the model is the desktop's");

  const cards = phonePrompts([permission, external, plan, hook, question]);
  assert.deepEqual(cards.map((c) => c.kind), ["permission", "permission", "plan", "hook", "question"]);
  const [perm, ext, pl, hk, q] = cards.map(promptCardView);
  assert.equal(perm.title, zh["permission.approveActionTitle"]);
  assert.equal(perm.detail, `${zh["permission.kind.bash"]}（npm test）`, "the tool by the desktop's label");
  assert.equal(ext.detail, zh["permission.kind.externalDirectory"], "snake_case tools find their label");
  assert.deepEqual(perm.actions.map((a) => a.label), [zh["permission.approve"], zh["permission.approveRememberShort"], zh["permission.deny"]]);
  assert.deepEqual(pl.actions.map((a) => a.label), [zh["plan.approve"], zh["plan.keepPlanning"]]);
  assert.deepEqual(hk.actions.map((a) => a.label), [zh["hook.allowTool"], zh["hook.denyTool"]]);
  assert.equal(pl.title, zh["plan.readyTitle"]);
  assert.match(pl.detail, /读日志/);
  assert.equal(hk.title, zh["turn.hook.confirmTitle"]);
  assert.equal(q.title, zh["turn.question.cardTitle"]);
  assert.deepEqual(q.questions[0].options.map((o) => o.label), ["Postgres", "SQLite"]);
  assert.equal(promptCardView({ ...phonePrompts([permission])[0], subagent: true }).detail.startsWith(zh["subagent.promptPrefix"]), true);
});

await check("a permission card carries its operation, never the tool's raw input", () => {
  const [perm] = phonePrompts([permission]);
  assert.equal(perm.operation, "npm test");
  assert.deepEqual(Object.keys(perm).sort(), ["actions", "kind", "operation", "requestId", "tool", "toolTitle"], "exactly these fields travel");
  const wire = JSON.stringify(phonePrompts([permission, external]));
  assert.doesNotMatch(wire, /sk-secret|API_KEY/, "arbitrary input (credentials) never travels");
  assert.match(wire, /Documents/, "a path is an operation field");
  const long = phonePrompts([{ requestId: "p", toolName: "bash", input: { command: "x".repeat(5000) } }])[0];
  assert.ok(long.operation.length <= 601, "bounded");
  assert.deepEqual(phonePrompts([{ toolName: "bash" }, null]), [], "a prompt without a request id is not a card");
});

await check("an answer maps to the desktop's own decision shapes", () => {
  assert.deepEqual(desktopResponse(permission, { action: "approve" }), { method: "respondPermission", decision: { allow: true, remember: false } });
  assert.deepEqual(desktopResponse(permission, { action: "approve_remember" }), { method: "respondPermission", decision: { allow: true, remember: true } });
  assert.deepEqual(desktopResponse(permission, { action: "deny" }), { method: "respondPermission", decision: { allow: false, remember: false } });
  assert.deepEqual(desktopResponse(plan, { action: "approve" }), { method: "respondPermission", decision: { allow: true } });
  assert.deepEqual(desktopResponse(plan, { action: "keep_planning" }), { method: "respondPermission", decision: { allow: false, message: KEEP_PLANNING_MESSAGE } });
  assert.deepEqual(desktopResponse(hook, { action: "deny" }), { method: "respondHook", decision: { allow: false } });
  assert.deepEqual(desktopResponse(question, { answers: [["Postgres"]] }), { method: "respondUserQuestion", decision: { answers: [["Postgres"]] } });
  assert.equal(desktopResponse(permission, { action: "keep_planning" }).error, "PROMPT_ACTION_INVALID", "an action the card does not offer is refused");
  assert.equal(desktopResponse(question, { action: "approve" }).error, "PROMPT_ANSWER_INVALID");
});

function fakePort(prompts = []) {
  const port = {
    pending: { s1: prompts },
    responses: [],
    active: { projectId: "p1", sessionId: "s1" },
    activeProjectId: () => port.active.projectId,
    activeSessionId: () => port.active.sessionId,
    findProject: (id) => ({ p1: { id: "p1" } })[id] || null,
    findSession: (id) => ({ s1: { id: "s1", projectId: "p1", title: "修复构建" }, s2: { id: "s2", projectId: "p1" } })[id] || null,
    listProjects: () => [{ id: "p1", name: "lily" }],
    listSessions: () => [{ id: "s1" }, { id: "s2" }],
    turnState: (sid) => ({ phase: port.pending[sid]?.length ? "awaiting_user" : "idle", runningTurnId: "", canInterrupt: false, queueLength: 0, userPrompts: port.pending[sid] || [] }),
    respondPrompt: (sid, method, requestId, decision) => {
      port.responses.push({ sid, method, requestId, decision });
      port.pending[sid] = (port.pending[sid] || []).filter((p) => p.requestId !== requestId);
      return { ok: true, sessionId: sid, requestId };
    },
  };
  return port;
}

await check("the phone answers a pending prompt of the session it drives, through the orchestrator seam", async () => {
  const port = fakePort([permission]);
  const sent = [];
  const controller = createPhoneController({ grantId: "gA", getDesktopDeviceId: () => "d", port, snapshot: async () => null, send: (f) => sent.push(f) });
  await controller.handle(toDesktop.respondPrompt({ requestId: "perm_1", action: "approve" }));
  assert.deepEqual(port.responses, [{ sid: "s1", method: "respondPermission", requestId: "perm_1", decision: { allow: true, remember: false } }]);
  assert.deepEqual(sent.at(-1), { type: TO_PHONE.PROMPT_ACK, requestId: "perm_1", ok: true });

  // Already answered (on the desktop, or twice): nothing is decided, the phone is told.
  await controller.handle(toDesktop.respondPrompt({ requestId: "perm_1", action: "deny" }));
  assert.equal(port.responses.length, 1, "a stale card decides nothing");
  assert.deepEqual(sent.at(-1), { type: TO_PHONE.PROMPT_ACK, requestId: "perm_1", ok: false, code: "NOT_PENDING" });

  // A prompt of ANOTHER session is not reachable from this phone's target.
  port.pending.s2 = [{ ...permission, requestId: "perm_s2" }];
  await controller.handle(toDesktop.respondPrompt({ requestId: "perm_s2", action: "approve" }));
  assert.equal(port.responses.length, 1, "only the session this phone drives");
  assert.equal(sent.at(-1).code, "NOT_PENDING");

  // An action the card does not offer.
  port.pending.s1 = [question];
  await controller.handle({ type: FROM_PHONE.PROMPT_RESPOND, requestId: "q_1", action: "approve" });
  assert.equal(sent.at(-1).code, "PROMPT_ANSWER_INVALID");
  await controller.handle(toDesktop.respondPrompt({ requestId: "q_1", answers: [["SQLite"]] }));
  assert.equal(port.responses.at(-1).method, "respondUserQuestion");
  assert.deepEqual(port.responses.at(-1).decision, { answers: [["SQLite"]] });
});

await check("the mirror sends the whole pending list when it changes, and the snapshot carries it", async () => {
  const port = fakePort([permission]);
  let observer = null;
  port.observeRuntime = (fn) => { observer = fn; return () => {}; };
  port.readConversation = async () => [];
  const sent = [];
  const mirror = createSessionMirror({ port, controllers: () => [{ grantId: "gA", targetSessionId: () => "s1" }], send: (g, f) => sent.push(f) });
  mirror.start();
  observer("s1", [{ type: "permission.requested", turnId: "t1", payload: permission }]);
  const updated = sent.find((f) => f.type === TO_PHONE.PROMPTS_UPDATED);
  assert.ok(updated, "a new prompt reaches the phone");
  assert.deepEqual(updated.prompts.map((p) => p.requestId), ["perm_1"]);
  port.pending.s1 = [];
  observer("s1", [{ type: "permission.resolved", turnId: "t1", payload: { requestId: "perm_1" } }]);
  assert.deepEqual(sent.at(-1), { type: TO_PHONE.PROMPTS_UPDATED, sessionId: "s1", prompts: [] }, "answered anywhere: the card goes");
  observer("s1", [{ type: "assistant.delta", turnId: "t1", payload: { text: "x" } }]);
  assert.notEqual(sent.at(-1).type, TO_PHONE.PROMPTS_UPDATED, "other events do not resend prompts");
  port.pending.s1 = [question];
  const snap = await mirror.snapshot("s1");
  assert.deepEqual(snap.prompts.map((p) => p.requestId), ["q_1"], "a phone reconnecting mid-wait sees what is asked");
});

await check("the phone model shows, answers and drops cards by the desktop's word", () => {
  const frame = (f) => ({ type: "frame", frame: f });
  const cards = phonePrompts([permission, question]);
  let s = reduce(initialConversation(), frame({ type: "session.context", sessionId: "s1", phase: "awaiting_user", recent: [], prompts: cards }));
  assert.equal(s.prompts.length, 2, "from the snapshot");
  s = reduce(s, { type: "answering", requestId: "perm_1" });
  assert.equal(s.answering.perm_1, true);
  s = reduce(s, frame({ type: "prompt.ack", requestId: "perm_1", ok: true }));
  assert.deepEqual(s.prompts.map((p) => p.requestId), ["q_1"]);
  assert.equal(s.answering.perm_1, undefined);
  s = reduce(s, frame({ type: "prompt.ack", requestId: "q_1", ok: false, code: "NOT_PENDING" }));
  assert.equal(s.prompts.length, 0, "handled on the desktop: the card goes");
  assert.match(s.notice.text, /电脑上处理过了/);
  s = reduce(s, frame({ type: "prompts.updated", sessionId: "s1", prompts: cards }));
  assert.equal(s.prompts.length, 2);
  s = reduce(s, frame({ type: "prompts.updated", sessionId: "other", prompts: [] }));
  assert.equal(s.prompts.length, 2, "another session's list does not touch this one");
  s = reduce(s, frame({ type: "session.context", sessionId: "s1", phase: "idle", recent: [] }));
  assert.equal(s.prompts.length, 0, "a desktop that sends no prompts confirms none");
});

console.log(`\n${checks} checks passed (mobile prompts)`);
