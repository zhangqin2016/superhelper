#!/usr/bin/env node
// Mobile Command, whole chain in one process: the REAL relay (Fastify + ws),
// the REAL desktop composition root (control channel, phone directory, phone
// controllers, session mirror) and a REAL phone WebSocket. Only the desktop
// internals (sessions, orchestrator) are a fake port, and auth is stubbed.
//
//   phone ──ws──▶ relay ──control channel──▶ desktop ──▶ port.admit
//   port runtime events ──▶ mirror ──▶ relay ──▶ phone
//   server pairing events (pending / active / ended) ──▶ desktop state push
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.env.DATABASE_URL ||= "postgres://test:test@localhost:5432/test";
process.env.SESSION_SECRET ||= "test-session-secret-abcdefghijklmnop";

const Fastify = require(path.join(ROOT, "server/node_modules/fastify"));
const WebSocket = require(path.join(ROOT, "server/node_modules/ws"));
const { registerMobileRelay, relayControl } = await import(path.join(ROOT, "server/src/services/mobile-relay.js"));
const { createGrantToken } = await import(path.join(ROOT, "server/src/services/mobile-grant-token.js"));
const { registerMobileCommand } = require(path.join(ROOT, "src/main/mobile/index.js"));
const { RuntimeEventBus } = require(path.join(ROOT, "src/main/runtime-event-bus.js"));

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(predicate, label, timeoutMs = 3000) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timeout: ${label}`);
    await wait(15);
  }
}

// --- server: the real relay; the desktop's state comes from a fake table ------
const row = (id, status, extra = {}) => ({ id, status, user_id: "u1", desktop_device_id: "dtop", mobile_device_id: `phone_${id}`, mobile_label: "iPhone · Safari", created_at: "2026-09-24T09:00:00Z", approved_at: status === "active" ? "2026-09-24T09:01:00Z" : null, approval_expires_at: "2099-01-01T00:00:00Z", ...extra });
const table = new Map([["g1", row("g1", "active")]]);
const app = Fastify({ logger: false });
registerMobileRelay(app, {
  verifyAccessToken: (t) => (t === "acc_tok" ? { ok: true, userId: "u1", deviceId: "dtop" } : { ok: false, code: "BAD" }),
  lookupActiveGrant: async (id) => (table.get(id)?.status === "active" ? table.get(id) : null),
  loadDesktopState: async () => ({
    grants: [...table.values()].filter((g) => g.status === "active"),
    pending: [...table.values()].filter((g) => g.status === "pending_approval"),
  }),
});
await app.listen({ port: 0, host: "127.0.0.1" });
const base = `http://127.0.0.1:${app.server.address().port}`;

// --- desktop: the real composition root over a fake port -----------------------
const bus = new RuntimeEventBus(() => null);
const admits = [];
const producedFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "lily-e2e-file-")), "纪要.pdf");
const producedBytes = crypto.randomBytes(400_000); // three chunks: exercises the relay's real 256 KB frame limit
fs.writeFileSync(producedFile, producedBytes);
const pendingPrompts = [];
const promptAnswers = [];
const port = {
  activeProjectId: () => "p1",
  activeSessionId: () => "s1",
  findProject: (id) => (id === "p1" ? { id: "p1" } : null),
  findSession: (id) => (id === "s1" ? { id: "s1", projectId: "p1", title: "修复构建" } : null),
  listProjects: () => [{ id: "p1", name: "lily" }],
  listSessions: () => [{ id: "s1", title: "修复构建" }],
  turnState: () => ({ phase: pendingPrompts.length ? "awaiting_user" : "idle", runningTurnId: "", canInterrupt: false, queueLength: 0, userPrompts: pendingPrompts.slice() }),
  respondPrompt: (sid, method, requestId, decision) => {
    promptAnswers.push({ sid, method, requestId, decision });
    pendingPrompts.splice(pendingPrompts.findIndex((p) => p.requestId === requestId), 1);
    bus.emit(sid, { type: "permission.resolved", turnId: "turn_perm", payload: { requestId } });
    return { ok: true, sessionId: sid, requestId };
  },
  turnCommandId: (_sid, turnId) => (turnId === "turn_phone" ? "cmd_e2e_1" : ""),
  readConversation: async () => [
    { id: "u", role: "user", content: "端到端：整理会议纪要", turnId: "turn_phone" },
    { id: "a", role: "assistant", content: "纪要已整理", turnId: "turn_phone", record: { artifacts: [{ artifactId: "art_minutes", fileName: "纪要.pdf", kind: "file", bytes: 400000 }] } },
  ],
  resolveArtifact: (_sid, id) => (id === "art_minutes" ? { ok: true, artifactId: id, path: producedFile, artifact: { mimeType: "application/pdf" } } : { ok: false }),
  admit: async (env) => { admits.push(env); return { ok: true, commandId: env.commandId, correlationId: env.correlationId, state: "admitted", requestedMode: "queue", effectiveMode: "queue" }; },
  interrupt: async () => ({ ok: true }),
  materializeAttachments: async () => [],
  observeRuntime: (listener) => bus.addObserver(listener),
};
const handlers = new Map();
const pushed = [];
const runtime = registerMobileCommand({ mainWindow: { webContents: { send: (channel, s) => pushed.push([channel, s]) } } }, {
  electron: { ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) } },
  serviceClient: {
    getServiceSettings: () => ({ apiBaseUrl: base }),
    getDeviceId: () => "dtop",
    serviceFetch: async (pathname) => (pathname === "/api/mobile/capabilities"
      ? { ok: true, json: { ok: true, relay: { controlChannel: 2 }, capabilities: { voice: { enabled: false } } } }
      : { ok: true, json: { ok: true } }),
  },
  accountManager: { accessTokenForService: async () => ({ ok: true, accessToken: "acc_tok" }) },
  log: { info() {}, warn() {} },
  port,
  WebSocketCtor: WebSocket,
  makeQrImage: async () => "",
});
const state = () => runtime.state();
const warnings = [];
process.on("warning", (w) => warnings.push(w.name));

// 1. The control channel connects and the hello becomes the desktop's state.
await until(() => state().channel === "online" && state().phones.length === 1, "desktop online with its pairing");
assert.equal(state().phones[0].grantId, "g1");
assert.equal(state().phones[0].online, false);
for (const channel of ["mobile:get-state", "mobile:create-challenge", "mobile:create-direct-code", "mobile:approve", "mobile:deny", "mobile:revoke"]) {
  assert.ok(handlers.has(channel), `IPC ${channel} is registered`);
}

// 2. The phone connects: both sides learn about each other.
const phoneFrames = [];
const phone = new WebSocket(`${base.replace(/^http/, "ws")}/api/mobile/relay?role=mobile&grantId=g1&deviceId=phone_g1&token=${encodeURIComponent(createGrantToken({ grantId: "g1", mobileDeviceId: "phone_g1" }))}`);
phone.on("message", (d) => phoneFrames.push(JSON.parse(String(d))));
await until(() => phoneFrames.some((f) => f.type === "relay.presence" && f.desktopOnline === true), "phone sees the desktop");
await until(() => state().phones[0].online === true, "desktop sees the phone");
assert.ok(pushed.some(([channel, s]) => channel === "mobile:state" && s.phones[0]?.online), "the change was pushed to the renderer");

// 3. A command crosses to admission and the ack comes back.
phone.send(JSON.stringify({ type: "command", commandId: "cmd_e2e_1", correlationId: "corr_e2e_1", text: "端到端：整理会议纪要", mobileDeviceId: "phone_g1" }));
await until(() => phoneFrames.some((f) => f.type === "command.admitted"), "admitted ack");
assert.equal(admits[0].lilySessionId, "s1");
assert.equal(admits[0].desktopDeviceId, "dtop");
assert.equal(phoneFrames.find((f) => f.type === "command.admitted").correlationId, "corr_e2e_1");

// 4. The turn runs on the desktop; the phone watches it — named by its command.
bus.emit("s1", { type: "turn.started", turnId: "turn_phone", payload: { text: "端到端：整理会议纪要" } });
bus.emit("s1", { type: "assistant.delta", turnId: "turn_phone", payload: { text: "纪要" } });
bus.emit("s1", { type: "assistant.final", turnId: "turn_phone", payload: { assistant: "纪要已整理" } });
bus.emit("s1", { type: "turn.completed", turnId: "turn_phone", payload: { assistant: "纪要已整理" } });
await until(() => phoneFrames.some((f) => f.type === "session.context"), "conversation after the turn");
assert.equal(phoneFrames.find((f) => f.type === "turn.started").commandId, "cmd_e2e_1", "the phone matches the turn to what it sent, by identity");
assert.equal(phoneFrames.find((f) => f.type === "assistant.final").text, "纪要已整理");
assert.equal(phoneFrames.find((f) => f.type === "turn.ended").status, "completed");
assert.deepEqual(phoneFrames.find((f) => f.type === "session.context").recent.map((m) => m.text), ["端到端：整理会议纪要", "纪要已整理"]);

// 4b. The desktop waits on its user; the phone answers it, over the real relay.
const permission = { requestId: "perm_e2e", toolName: "bash", title: "npm test", input: { command: "npm test", env: { TOKEN: "sk-never" } } };
pendingPrompts.push(permission);
bus.emit("s1", { type: "turn.started", turnId: "turn_perm", payload: { text: "跑测试" } });
bus.emit("s1", { type: "permission.requested", turnId: "turn_perm", payload: permission });
await until(() => phoneFrames.some((f) => f.type === "prompts.updated" && f.prompts.length === 1), "the prompt reaches the phone");
const card = phoneFrames.find((f) => f.type === "prompts.updated" && f.prompts.length === 1).prompts[0];
assert.equal(card.operation, "npm test");
assert.ok(!JSON.stringify(card).includes("sk-never"), "the tool's raw input stays on the desktop");
phone.send(JSON.stringify({ type: "prompt.respond", requestId: card.requestId, action: "approve" }));
await until(() => phoneFrames.some((f) => f.type === "prompt.ack" && f.requestId === "perm_e2e"), "the answer is acknowledged");
assert.deepEqual(promptAnswers, [{ sid: "s1", method: "respondPermission", requestId: "perm_e2e", decision: { allow: true, remember: false } }], "decided through the orchestrator seam");
assert.equal(phoneFrames.find((f) => f.type === "prompt.ack").ok, true);
await until(() => phoneFrames.filter((f) => f.type === "prompts.updated").at(-1).prompts.length === 0, "and the card is gone everywhere");

// 4c. A file the turn produced, fetched through the real relay, byte for byte.
{
  const { createFileReceiver } = await import(pathToFileURL(path.join(ROOT, "web/lib/mobile/file-receive.mjs")).href);
  assert.deepEqual(phoneFrames.filter((f) => f.type === "session.context").at(-1).recent.at(-1).artifacts, [{ artifactId: "art_minutes", name: "纪要.pdf", kind: "file", bytes: 400000 }], "the phone sees the produced file");
  const receiver = createFileReceiver();
  let done = null;
  const fileFrames = [];
  phone.on("message", async (d) => { const f = JSON.parse(String(d)); if (f.type?.startsWith("file.")) { fileFrames.push(f); done = (await receiver.onFrame(f))?.done || done; } });
  phone.send(JSON.stringify({ type: "file.request", requestId: "req_e2e", artifactId: "art_minutes" }));
  await until(() => done, "the file arrives on the phone");
  assert.equal(Buffer.compare(Buffer.from(done.bytes), producedBytes), 0, "byte for byte, through the relay");
  assert.equal(fileFrames.filter((f) => f.type === "file.chunk").length, 3);
  phone.send(JSON.stringify({ type: "file.request", requestId: "req_bad", artifactId: "art_not_here" }));
  await until(() => fileFrames.some((f) => f.type === "file.error" && f.requestId === "req_bad"), "a file not in the conversation is refused");
}

// 5. Server pushes: a phone scans (pending), is approved (active) — no polling.
table.set("g2", row("g2", "pending_approval"));
relayControl.pairingRequested(table.get("g2"));
await until(() => state().pending.some((p) => p.grantId === "g2"), "pending pushed");
assert.equal(state().pending[0].mobileLabel, "iPhone · Safari");
table.set("g2", row("g2", "active"));
relayControl.grantActivated(table.get("g2"));
await until(() => state().phones.some((p) => p.grantId === "g2") && !state().pending.length, "activation pushed");

// 6. Revocation: the phone is closed at once and the desktop forgets it.
const phoneClosed = new Promise((r) => phone.on("close", (code) => r(code)));
table.get("g1").status = "revoked";
relayControl.grantEnded("g1", "user_action");
assert.equal(await phoneClosed, 4001);
await until(() => !state().phones.some((p) => p.grantId === "g1"), "desktop drops the ended pairing");

assert.ok(!warnings.includes("TimeoutOverflowWarning"), "a far-off expiry never overflows the timer into a push storm");
const pushesBefore = pushed.length;
await wait(100);
assert.ok(pushed.length - pushesBefore < 3, "no state push loop while nothing changes");

runtime.stop();
await app.close();
console.log("mobile-command-e2e: ok");
process.exit(0);
