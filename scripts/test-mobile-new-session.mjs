#!/usr/bin/env node
// A new conversation from the phone is the desktop's kind of conversation,
// made in one place (src/main/session-create.js) — the session.start hook
// fires, the default 智能体 binds — and it does NOT switch the desktop's
// active conversation under its user. The phone then drives it. A desktop
// that predates it never gets asked (the phone offers the button only to a
// desktop that sends prompts).
// Run: node scripts/test-mobile-new-session.mjs
import assert from "node:assert/strict";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const Module = require("node:module");
const hooks = [];
const realLoad = Module._load;
Module._load = function load(request, parent, ...rest) {
  if (request === "./public-hooks" && String(parent?.filename || "").endsWith("session-create.js")) return { observePublicHook: (_rt, name, payload) => hooks.push({ name, payload }) };
  if (request === "./agents/agent-distribution" && String(parent?.filename || "").endsWith("session-create.js")) return { applyDefaultAgentToNewSession: async () => ({ applied: false }) };
  return realLoad.call(this, request, parent, ...rest);
};
const { createSessionFor } = require(path.join(ROOT, "src/main/session-create.js"));
const { createPhoneController } = require(path.join(ROOT, "src/main/mobile/phone-controller.js"));
const { reduce, initialConversation } = await import(pathToFileURL(path.join(ROOT, "web/lib/mobile/conversation.mjs")).href);

// The session manager's create: activation is the caller's choice, default unchanged.
{
  const created = [];
  const manager = { activeSessionId: "s_desktop", create(pid, title, { activate = true } = {}) { const s = { id: `s_${created.length + 1}`, title: title || "新对话", projectId: pid }; created.push(s); if (activate) this.activeSessionId = s.id; return s; } };
  const ctx = { sessionManager: manager, projectManager: { getActive: () => ({ id: "p1" }) } };
  const fromPhone = await createSessionFor(ctx, "p1", "", { source: "mobile", activate: false });
  assert.equal(fromPhone.ok, true);
  assert.equal(manager.activeSessionId, "s_desktop", "the phone's new conversation leaves the desktop's active one alone");
  assert.deepEqual(hooks.at(-1), { name: "session.start", payload: { sessionId: fromPhone.session.id, projectId: "p1", source: "mobile" } }, "the hook fires, saying where it came from");
  const fromDesktop = await createSessionFor(ctx, "", "周报", { source: "desktop" });
  assert.equal(manager.activeSessionId, fromDesktop.session.id, "the desktop's own create still activates (unchanged)");
  assert.equal(fromDesktop.session.projectId, "p1", "defaults to the active workspace, as before");
  assert.deepEqual(await createSessionFor({ sessionManager: manager, projectManager: { getActive: () => null } }, "", ""), { ok: false, error: "NO_PROJECT" });
}

// The real SessionManager honours the option (source: the class needs a full profile to construct).
{
  const src = require("node:fs").readFileSync(path.join(ROOT, "src/main/session-manager.js"), "utf8");
  assert.match(src, /create\(projectId, title, \{ activate = true \} = \{\}\)/, "create takes the option, defaulting to today's behaviour");
  assert.match(src, /if \(activate\) this\.activeSessionId = session\.id;/);
}

// The phone asks; the controller creates in its workspace and drives the new one.
{
  const sent = [];
  const sessions = { s1: { id: "s1", projectId: "p1" } };
  const port = {
    activeProjectId: () => "p1", activeSessionId: () => "s1",
    findProject: (id) => (id === "p1" ? { id } : null),
    findSession: (id) => sessions[id] || null,
    listProjects: () => [{ id: "p1" }], listSessions: () => Object.values(sessions),
    createSession: async (pid) => { sessions.s_new = { id: "s_new", projectId: pid, title: "新对话" }; return { ok: true, session: sessions.s_new }; },
  };
  const controller = createPhoneController({ grantId: "g", getDesktopDeviceId: () => "d", port, snapshot: async (sid) => ({ type: "session.context", sessionId: sid }), send: (f) => sent.push(f) });
  await controller.handle({ type: "session.create" });
  assert.equal(controller.targetSessionId(), "s_new", "the phone now drives the new conversation");
  assert.deepEqual(sent.map((f) => f.type), ["sessions.list", "session.context"]);
  assert.equal(sent.at(-1).sessionId, "s_new");
  port.createSession = async () => ({ ok: false, error: "NO_PROJECT" });
  await controller.handle({ type: "session.create" });
  assert.deepEqual(sent.at(-1), { type: "session.select.ack", ok: false, sessionId: "", code: "NO_PROJECT" }, "a failure comes back, the phone is not left waiting");
}

// The phone only offers it to a desktop that understands it.
{
  const frame = (f) => ({ type: "frame", frame: f });
  const old = reduce(initialConversation(), frame({ type: "session.context", sessionId: "s1", phase: "idle", recent: [] }));
  assert.equal(old.desktopFeatures.prompts, false, "a desktop without prompts is an older one");
  const current = reduce(old, frame({ type: "session.context", sessionId: "s1", phase: "idle", recent: [], prompts: [] }));
  assert.equal(current.desktopFeatures.prompts, true);
}

console.log("mobile-new-session: ok");
