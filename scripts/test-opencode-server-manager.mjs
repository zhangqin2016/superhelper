#!/usr/bin/env node
/**
 * OpenCode server-manager transport helpers (INSTANCE API). The networked paths
 * need a live `opencode serve` (covered by scripts/smoke-opencode.mjs), but the
 * parsing/body builders are pure and must be exact — a wrong port parse means we
 * never connect; a wrong SSE split drops/merges events; a wrong message body
 * (must be {agent, model, parts}, NOT {prompt}) means the turn never executes.
 */
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const {
  OpencodeServerManager,
} = require("../src/main/runtime/opencode-server-manager.js");
const {
  classifyOpencodeEventOwnership,
} = require("../src/main/runtime/opencode-event-ownership.js");
const {
  buildOpencodePromptBody,
} = require("../src/main/runtime/opencode-message-parts.js");

function assert(cond, msg) { if (!cond) throw new Error(msg); }

// --- pure ownership classifier ---------------------------------------------
{
  const ownedMessages = new Set(["msg_owned"]);
  assert(
    classifyOpencodeEventOwnership({
      directory: "/other",
      cwd: "/workspace",
      event: { type: "session.status", properties: { sessionID: "ses_a" } },
      sessionID: "ses_a",
      ownedMessages,
    }).reason === "different_directory",
    "events from another directory are dropped first",
  );
  assert(
    classifyOpencodeEventOwnership({
      directory: "/workspace",
      cwd: "/workspace",
      event: { type: "message.part.delta", properties: { messageID: "msg_owned" } },
      sessionID: "ses_a",
      ownedMessages,
    }).reason === "owned_message",
    "session-less deltas route only after message ownership is known",
  );
  const diag = classifyOpencodeEventOwnership({
    directory: "/workspace",
    cwd: "/workspace",
    event: { type: "session.error", properties: { error: { data: { message: "Failed to parse skill x/SKILL.md" } } } },
    sessionID: "ses_a",
    ownedMessages,
  });
  assert(diag.action === "drop" && diag.scope === "directory_diagnostic",
    "unowned session.error is a directory diagnostic, not a turn failure");
  const unownedIdle = classifyOpencodeEventOwnership({
    directory: "/workspace",
    cwd: "/workspace",
    event: { type: "session.idle", properties: {} },
    sessionID: "ses_a",
    ownedMessages,
  });
  assert(unownedIdle.action === "drop" && unownedIdle.reason === "missing_session_id",
    "unowned session.idle must not complete every busy session in the directory");
  const unownedTodo = classifyOpencodeEventOwnership({
    directory: "/workspace",
    cwd: "/workspace",
    event: { type: "todo.updated", properties: { todos: [{ content: "wrong session", status: "pending" }] } },
    sessionID: "ses_a",
    ownedMessages,
  });
  assert(unownedTodo.action === "drop" && unownedTodo.reason === "missing_session_id",
    "unowned turn-affecting events must not be broadcast as directory events");
  const directorySafe = classifyOpencodeEventOwnership({
    directory: "/workspace",
    cwd: "/workspace",
    event: { type: "catalog.updated", properties: {} },
    sessionID: "ses_a",
    ownedMessages,
  });
  assert(directorySafe.action === "deliver" && directorySafe.reason === "directory_event",
    "known directory-level events remain deliverable");
}

// --- instance message body (the execute-the-turn endpoint shape) ------------
{
  const b = buildOpencodePromptBody({
    text: "hi",
    agent: "build",
    model: { providerID: "lily", modelID: "deepseek-chat" },
  });
  assert(b.agent === "build", "agent included");
  assert(b.model.providerID === "lily" && b.model.modelID === "deepseek-chat", "model {providerID, modelID}");
  assert(Array.isArray(b.parts), "parts is an array");
  const textPart = b.parts.find((p) => p.type === "text");
  assert(textPart && textPart.text === "hi", "text part carries the message");
  assert(!("prompt" in b), "must NOT use the v2 {prompt} shape");

  // agent defaults to "build" when unset.
  assert(buildOpencodePromptBody({ text: "x" }).agent === "build", "agent defaults to build");

  // pre-resolved {uri,mime} files become file parts before the text part.
  const wf = buildOpencodePromptBody({ text: "see this", files: [{ uri: "file:///a.png", mime: "image/png", name: "a" }] });
  const filePart = wf.parts.find((p) => p.type === "file");
  assert(filePart && filePart.url === "file:///a.png" && filePart.mime === "image/png", "{uri,mime} -> file part");

  // Lily composer files ({path,name,isImage}) get read into a base64 data: URL.
  const os = require("node:os"); const fsx = require("node:fs"); const pathx = require("node:path");
  const tmp = pathx.join(os.tmpdir(), `oc-filepart-${Date.now()}.png`);
  fsx.writeFileSync(tmp, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const wp = buildOpencodePromptBody({ text: "look", files: [{ path: tmp, name: "shot.png", isImage: true }] });
  const fp = wp.parts.find((p) => p.type === "file");
  assert(fp && fp.mime === "image/png" && fp.filename === "shot.png", "{path} -> file part with mime/filename");
  assert(fp.url.startsWith("data:image/png;base64,"), "local file read into a base64 data URL");
  fsx.unlinkSync(tmp);
  // a missing file is dropped, not crashed.
  const wm = buildOpencodePromptBody({ text: "x", files: [{ path: "/no/such/file.png" }] });
  assert(!wm.parts.some((p) => p.type === "file"), "missing file dropped");

  // model omitted entirely when incomplete (server would reject a half ref).
  assert(!("model" in buildOpencodePromptBody({ text: "x", model: { providerID: "lily" } })), "incomplete model omitted");
}

// --- shared-stream demux: never broadcast unowned request events ------------
{
  const makeManager = (sessionID) => {
    let handler = null;
    const manager = new OpencodeServerManager({
      serverCommand: "/bin/true",
      cwd: "/workspace",
      dataDir: ":memory:",
    });
    manager.sessionID = sessionID;
    manager._shared = {
      onEvent(fn) {
        handler = fn;
        return () => {};
      },
    };
    const seen = [];
    manager.on("event", (event) => seen.push(event));
    manager.subscribe();
    return { manager, seen, emit: (event) => handler("/workspace", event) };
  };

  const a = makeManager("ses_a");
  const b = makeManager("ses_b");
  const question = {
    type: "question.asked",
    properties: { id: "q1", tool: { callID: "call_1" }, questions: [] },
  };
  a.emit(question);
  b.emit(question);
  assert(a.seen.length === 0 && b.seen.length === 0, "session-less question is not broadcast");

  const directoryError = {
    type: "session.error",
    properties: {
      error: {
        name: "UnknownError",
        data: { message: "Failed to parse skill /workspace/.claude/skills/bad/SKILL.md" },
      },
    },
  };
  a.emit(directoryError);
  b.emit(directoryError);
  assert(a.seen.length === 0 && b.seen.length === 0,
    "session-less directory diagnostics are not treated as per-session turn failures");
  assert(a.manager.diagnostics().routing.byReason.unowned_error_diagnostic === 1,
    "routing diagnostics count dropped directory-level errors");

  const unownedIdle = { type: "session.idle", properties: {} };
  a.emit(unownedIdle);
  b.emit(unownedIdle);
  assert(a.seen.length === 0 && b.seen.length === 0,
    "session-less idle events are not broadcast across same-directory sessions");
  assert(a.manager.diagnostics().routing.byReason.missing_session_id === 2,
    "routing diagnostics count dropped unowned session boundary events");

  const unownedTodo = {
    type: "todo.updated",
    properties: { todos: [{ content: "wrong session", status: "pending" }] },
  };
  a.emit(unownedTodo);
  b.emit(unownedTodo);
  assert(a.seen.length === 0 && b.seen.length === 0,
    "session-less turn updates are not broadcast across same-directory sessions");
  assert(a.manager.diagnostics().routing.byReason.missing_session_id === 3,
    "routing diagnostics count all dropped unowned turn events");

  const directorySafe = { type: "catalog.updated", properties: {} };
  a.emit(directorySafe);
  b.emit(directorySafe);
  assert(a.seen.at(-1) === directorySafe && b.seen.at(-1) === directorySafe,
    "known directory-level events still broadcast to same-directory sessions");

  const owner = {
    type: "message.part.updated",
    properties: {
      part: {
        sessionID: "ses_a",
        messageID: "msg_1",
        callID: "call_1",
        type: "tool",
        tool: "bash",
        state: { status: "running", input: { command: "pwd" } },
      },
    },
  };
  a.emit(owner);
  b.emit(owner);
  assert(a.seen.at(-1) === owner, "owner session receives only owned event");
  assert(!b.seen.includes(owner), "other session in the same directory never receives another session's event");

  const ownedQuestion = {
    type: "question.asked",
    properties: { id: "q2", sessionID: "ses_a", tool: { callID: "call_2" }, questions: [] },
  };
  a.emit(ownedQuestion);
  b.emit(ownedQuestion);
  assert(a.seen.at(-1) === ownedQuestion, "question with sessionID routes to its owner");
  assert(!b.seen.includes(ownedQuestion), "question with another sessionID is filtered");

  const ownedError = {
    type: "session.error",
    properties: {
      sessionID: "ses_a",
      error: { name: "UnknownError", data: { message: "real turn error" } },
    },
  };
  a.emit(ownedError);
  b.emit(ownedError);
  assert(a.seen.at(-1) === ownedError, "session.error with sessionID still routes to its owner");
  assert(!b.seen.includes(ownedError), "owned session.error is filtered from other sessions");
  assert(a.manager.diagnostics().routing.recent.some((entry) => entry.action === "deliver" && entry.reason === "owned_session"),
    "routing diagnostics keep recent delivery decisions");
}

// --- createSession: create rows only; model/agent belong to promptAsync -----
{
  const calls = [];
  const manager = new OpencodeServerManager({
    serverCommand: "/bin/true",
    cwd: "/workspace",
    dataDir: ":memory:",
    agent: "build",
    model: { providerID: "lily", modelID: "deepseek-chat" },
  });
  manager._sdkSession = {
    create: async (params) => {
      calls.push(params);
      return { id: "ses_new" };
    },
  };
  const id = await manager.createSession();
  assert(id === "ses_new", "createSession returns the new session id");
  assert(calls.length === 1, "session.create called once");
  assert(calls[0] === undefined || Object.keys(calls[0]).length === 0,
    "session.create must not receive prompt model/agent shape");
}

// --- idle confirmation mirrors official session.status polling --------------
{
  const manager = new OpencodeServerManager({
    serverCommand: "/bin/true",
    cwd: "/workspace",
    dataDir: ":memory:",
  });
  manager.sessionID = "ses_busy";
  manager._sdkSession = {
    status: async () => ({ ses_busy: { type: "busy" } }),
  };
  assert((await manager.isSessionIdle()) === false, "busy session.status prevents premature idle completion");
  manager._sdkSession = {
    status: async () => ({ ses_busy: { type: "idle" } }),
  };
  assert((await manager.isSessionIdle()) === true, "idle session.status permits completion");
  manager._sdkSession = {
    status: async () => ({}),
  };
  assert((await manager.isSessionIdle()) === true, "missing status row is treated as idle like official fallback");
}

// --- messages use the official session.messages endpoint --------------------
{
  const manager = new OpencodeServerManager({
    serverCommand: "/bin/true",
    cwd: "/workspace",
    dataDir: ":memory:",
  });
  const calls = [];
  manager.sessionID = "ses_msgs";
  manager._sdkSession = {
    messages: async (sid, opts) => {
      calls.push({ sid, opts });
      return { data: [{ info: { id: "msg_1" }, parts: [] }] };
    },
  };
  const page = await manager.messages({ limit: 10, before: "cursor" });
  assert(page.data[0].info.id === "msg_1", "messages result returned");
  assert(JSON.stringify(calls) === JSON.stringify([{ sid: "ses_msgs", opts: { limit: 10, before: "cursor" } }]),
    "messages passes session id and pagination options");
}

// --- concurrent sessions post independently through promptAsync -------------
{
  const calls = [];
  const makeManager = (sessionID) => {
    const manager = new OpencodeServerManager({
      serverCommand: "/bin/true",
      cwd: "/workspace",
      dataDir: ":memory:",
      agent: "build",
      model: { providerID: "lily", modelID: "deepseek-chat" },
    });
    manager.sessionID = sessionID;
    manager._sdkSession = {
      promptAsync: async (sid, body) => {
        calls.push({ sid, text: body.parts.find((part) => part.type === "text")?.text || "" });
      },
    };
    return manager;
  };
  const a = makeManager("ses_a");
  const b = makeManager("ses_b");
  await Promise.all([
    a.sendPrompt({ text: "from a" }),
    b.sendPrompt({ text: "from b" }),
  ]);
  assert(JSON.stringify(calls.map((call) => call.sid).sort()) === JSON.stringify(["ses_a", "ses_b"]),
    "concurrent promptAsync calls keep independent session ids");
  assert(calls.some((call) => call.sid === "ses_a" && call.text === "from a"), "session A text preserved");
  assert(calls.some((call) => call.sid === "ses_b" && call.text === "from b"), "session B text preserved");
}

console.log("opencode-server-manager: ok");
