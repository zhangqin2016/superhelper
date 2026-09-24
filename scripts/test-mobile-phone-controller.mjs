#!/usr/bin/env node
// One paired phone: its own target, its commands entering only through the
// admission seam, "stop" hitting the session it drives, selections scoped to
// its workspace. Driven against a fake desktop port.
import assert from "node:assert/strict";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { createPhoneController, payloadHashFor } = require(path.join(ROOT, "src/main/mobile/phone-controller.js"));
const { LIMITS, PHONE_PROTOCOL } = require(path.join(ROOT, "src/main/mobile/protocol.js"));

function fakePort() {
  const projects = { p1: { id: "p1", name: "lily" }, p2: { id: "p2", name: "官网" } };
  const sessions = {
    s1: { id: "s1", projectId: "p1", title: "修复构建" },
    s2: { id: "s2", projectId: "p1", title: "周报" },
    s3: { id: "s3", projectId: "p2", title: "首页" },
  };
  const port = {
    active: { projectId: "p1", sessionId: "s1" },
    admits: [],
    interrupts: [],
    materialized: [],
    activeProjectId: () => port.active.projectId,
    activeSessionId: () => port.active.sessionId,
    findProject: (id) => projects[id] || null,
    findSession: (id) => sessions[id] || null,
    listProjects: () => Object.values(projects),
    listSessions: (pid) => Object.values(sessions).filter((s) => s.projectId === pid),
    admit: async (env) => { port.admits.push(env); return { ok: true, commandId: env.commandId, correlationId: env.correlationId, state: "admitted", requestedMode: env.mode, effectiveMode: "queue", downgradeReason: null }; },
    interrupt: async (sid) => { port.interrupts.push(sid); return { ok: true }; },
    materializeAttachments: async (list) => { port.materialized.push(list.length); return list.slice(0, 1).map((a) => ({ path: `/tmp/${a.name}` })); },
  };
  return port;
}

function makeController(port = fakePort()) {
  const sent = [];
  const snapshots = [];
  const controller = createPhoneController({
    grantId: "gA",
    getDesktopDeviceId: () => "dtop",
    port,
    snapshot: async (sid) => { snapshots.push(sid); return { type: "session.context", sessionId: sid }; },
    send: (frame) => sent.push(frame),
  });
  return { controller, port, sent, snapshots };
}

// --- a command enters through admission, stamped for idempotency ------------
{
  const { controller, port, sent } = makeController();
  await controller.handle({ type: "command", commandId: "c1", correlationId: "corr_1", text: "整理日志", mobileDeviceId: "mweb_a" });
  assert.equal(port.admits.length, 1);
  const env = port.admits[0];
  assert.equal(env.lilySessionId, "s1", "defaults to the desktop's active session");
  assert.equal(env.desktopDeviceId, "dtop");
  assert.equal(env.idempotencyKey, "c1");
  assert.equal(env.payloadHash, payloadHashFor("整理日志", []));
  assert.equal(env.mode, "queue");
  assert.deepEqual(sent.at(-1), {
    type: "command.admitted", commandId: "c1", correlationId: "corr_1", sessionId: "s1",
    attachmentStatus: "none", attachmentCount: 0, materializedFileCount: 0,
    state: "admitted", requestedMode: "queue", effectiveMode: "queue", downgradeReason: null,
  });
}

// --- attachments: written to disk; partial and dropped are reported ----------
{
  const { controller, port, sent } = makeController();
  await controller.handle({ type: "command", commandId: "c2", text: "", attachments: [{ name: "a.jpg" }, { name: "b.jpg" }] });
  assert.equal(port.admits[0].files.length, 1);
  assert.equal(sent.at(-1).attachmentStatus, "partial");
  port.materializeAttachments = async () => { throw new Error("disk"); };
  await controller.handle({ type: "command", commandId: "c3", text: "看图", attachments: [{ name: "a.jpg" }] });
  assert.equal(sent.at(-1).attachmentStatus, "dropped", "a disk failure leaves a text-only task, reported");
}

// --- validation never reaches admission ---------------------------------------
{
  const { controller, port, sent } = makeController();
  const cases = [
    [{ type: "command", commandId: "v1", text: "x", protocolVersion: PHONE_PROTOCOL + 1 }, "CLIENT_UPGRADE_REQUIRED"],
    [{ type: "command", commandId: "v2", text: "x".repeat(LIMITS.COMMAND_TEXT + 1) }, "COMMAND_TEXT_TOO_LARGE"],
    [{ type: "command", commandId: "v3", text: "x", attachments: Array.from({ length: LIMITS.ATTACHMENTS + 1 }, () => ({})) }, "ATTACHMENT_COUNT_EXCEEDED"],
    [{ type: "command", commandId: "", text: "x" }, "COMMAND_INVALID"],
    [{ type: "command", commandId: "v5", text: "" }, "COMMAND_INVALID"],
  ];
  for (const [frame, code] of cases) {
    await controller.handle(frame);
    assert.equal(sent.at(-1).type, "command.rejected");
    assert.equal(sent.at(-1).code, code);
  }
  assert.equal(port.admits.length, 0);
  port.admit = async () => ({ ok: false, code: "SESSION_NOT_OWNED" });
  await controller.handle({ type: "command", commandId: "v6", text: "x" });
  assert.equal(sent.at(-1).code, "SESSION_NOT_OWNED", "admission's refusal reaches the phone");
  port.admit = async () => { throw new Error("orchestrator down"); };
  await controller.handle({ type: "command", commandId: "v7", text: "x" });
  assert.equal(sent.at(-1).code, "COMMAND_ADMISSION_ERROR");
}

// --- per-phone target: the phone's pick, scoped to its workspace ---------------
{
  const { controller, port, sent, snapshots } = makeController();
  await controller.handle({ type: "session.select", sessionId: "s2" });
  assert.equal(controller.targetSessionId(), "s2");
  assert.deepEqual(snapshots, ["s2"], "selecting sends that session's conversation");
  await controller.handle({ type: "session.select", sessionId: "s3" });
  assert.deepEqual(sent.at(-1), { type: "session.select.ack", ok: false, sessionId: "s3", code: "SESSION_NOT_FOUND" }, "a session of another workspace is refused");
  assert.equal(controller.targetSessionId(), "s2");

  // "stop" stops the session THIS phone drives — not the desktop's foreground.
  await controller.handle({ type: "interrupt", correlationId: "corr_stop" });
  assert.deepEqual(port.interrupts, ["s2"]);
  assert.deepEqual(sent.at(-1), { type: "interrupt.ack", ok: true, correlationId: "corr_stop", turnId: null });

  // switching workspace: its sessions, then its default session's conversation
  const before = sent.length;
  await controller.handle({ type: "project.select", projectId: "p2" });
  assert.deepEqual(sent.slice(before).map((f) => f.type), ["sessions.list", "session.context"], "its sessions, then its default session's conversation");
  assert.equal(sent[before].projectId, "p2");
  assert.equal(controller.targetSessionId(), "s3", "a non-active workspace starts at its first session");
  assert.equal(snapshots.at(-1), "s3");
  await controller.handle({ type: "project.select", projectId: "nope" });
  assert.equal(sent.at(-1).code, "PROJECT_NOT_FOUND");

  // a command naming another workspace's session goes to this phone's target
  await controller.handle({ type: "command", commandId: "c9", text: "x", lilySessionId: "s1" });
  assert.equal(port.admits.at(-1).lilySessionId, "s3");
}

// --- two phones never share a pick --------------------------------------------
{
  const port = fakePort();
  const a = makeController(port).controller;
  const b = makeController(port).controller;
  await a.handle({ type: "session.select", sessionId: "s2" });
  assert.equal(a.targetSessionId(), "s2");
  assert.equal(b.targetSessionId(), "s1");
  // the desktop switches its foreground: an unpinned phone follows, a pinned one stays
  port.active.sessionId = "s2";
  assert.equal(b.targetSessionId(), "s2");
  await a.handle({ type: "session.select", sessionId: "s1" });
  assert.equal(a.targetSessionId(), "s1");
}

// --- lists ------------------------------------------------------------------------
{
  const { controller, sent } = makeController();
  await controller.handle({ type: "projects.request" });
  assert.deepEqual(sent.at(-1), { type: "projects.list", activeProjectId: "p1", selectedProjectId: "p1", projects: [{ id: "p1", name: "lily" }, { id: "p2", name: "官网" }] });
  await controller.handle({ type: "sessions.request" });
  assert.equal(sent.at(-1).sessions.length, 2);
  await controller.handle({ type: "unknown.frame" });
  await controller.handle(null);
}

console.log("mobile-phone-controller: ok");
