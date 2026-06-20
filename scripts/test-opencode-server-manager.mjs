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
  parseListeningAddress,
  createSseFrameParser,
  buildInstanceMessageBody,
} = require("../src/main/runtime/opencode-server-manager.js");

function assert(cond, msg) { if (!cond) throw new Error(msg); }

// --- port discovery from stdout --------------------------------------------
{
  const a = parseListeningAddress("server listening on 127.0.0.1:4096");
  assert(a && a.host === "127.0.0.1" && a.port === 4096, "parse plain host:port");
  const b = parseListeningAddress("INFO opencode server listening on http://127.0.0.1:51234");
  assert(b && b.port === 51234, "parse with scheme + surrounding text");
  assert(parseListeningAddress("starting up...") === null, "non-listening line -> null");
  assert(parseListeningAddress("listening on host:999999") === null, "out-of-range port -> null");
}

// --- SSE frame parsing ------------------------------------------------------
{
  const p = createSseFrameParser();
  const got = p.feed('data: {"type":"a"}\n\ndata: {"type":"b"}\n\n');
  assert(got.length === 2 && got[0].type === "a" && got[1].type === "b", "two frames in one chunk");

  const p2 = createSseFrameParser();
  assert(p2.feed('data: {"type":"spl').length === 0, "partial frame yields nothing yet");
  const done = p2.feed('it"}\n\n');
  assert(done.length === 1 && done[0].type === "split".slice(0, 3) + "it", "split frame completes once");

  const p3 = createSseFrameParser();
  assert(p3.feed("data: not-json\n\n").length === 0, "unparseable frame dropped silently");
}

// --- instance message body (the execute-the-turn endpoint shape) ------------
{
  const b = buildInstanceMessageBody({
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
  assert(buildInstanceMessageBody({ text: "x" }).agent === "build", "agent defaults to build");

  // pre-resolved {uri,mime} files become file parts before the text part.
  const wf = buildInstanceMessageBody({ text: "see this", files: [{ uri: "file:///a.png", mime: "image/png", name: "a" }] });
  const filePart = wf.parts.find((p) => p.type === "file");
  assert(filePart && filePart.url === "file:///a.png" && filePart.mime === "image/png", "{uri,mime} -> file part");

  // Lily composer files ({path,name,isImage}) get read into a base64 data: URL.
  const os = require("node:os"); const fsx = require("node:fs"); const pathx = require("node:path");
  const tmp = pathx.join(os.tmpdir(), `oc-filepart-${Date.now()}.png`);
  fsx.writeFileSync(tmp, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const wp = buildInstanceMessageBody({ text: "look", files: [{ path: tmp, name: "shot.png", isImage: true }] });
  const fp = wp.parts.find((p) => p.type === "file");
  assert(fp && fp.mime === "image/png" && fp.filename === "shot.png", "{path} -> file part with mime/filename");
  assert(fp.url.startsWith("data:image/png;base64,"), "local file read into a base64 data URL");
  fsx.unlinkSync(tmp);
  // a missing file is dropped, not crashed.
  const wm = buildInstanceMessageBody({ text: "x", files: [{ path: "/no/such/file.png" }] });
  assert(!wm.parts.some((p) => p.type === "file"), "missing file dropped");

  // model omitted entirely when incomplete (server would reject a half ref).
  assert(!("model" in buildInstanceMessageBody({ text: "x", model: { providerID: "lily" } })), "incomplete model omitted");
}

console.log("opencode-server-manager: ok");
