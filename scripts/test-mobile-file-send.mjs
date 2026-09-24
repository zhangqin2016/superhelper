#!/usr/bin/env node
// Getting what a task produced onto the phone — and nothing else.
//   - served only when the artifactId is on a produced-file card of the
//     conversation the phone drives AND the desktop's artifact registry
//     resolves that exact id; a path is never accepted (the registry resolves
//     any existing file by path);
//   - bounded (20 MB), chunked under the relay's 256 KB frame, verified by
//     sha256 on the phone; nothing stored on the server;
//   - the conversation the phone sees lists each turn's produced files;
//   - the controller answers every request (a file, or why not) and never
//     serves another session's file.
// [gate: mobile-file-send]
// Run: node scripts/test-mobile-file-send.mjs
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { FILE_LIMITS, conversationArtifactIds, planFileSend, fileFrames } = require(path.join(ROOT, "src/main/mobile/file-send.js"));
const { mobileConversationView } = require(path.join(ROOT, "src/main/mobile/conversation-view.js"));
const { createPhoneController } = require(path.join(ROOT, "src/main/mobile/phone-controller.js"));
const { createFileReceiver } = await import(pathToFileURL(path.join(ROOT, "web/lib/mobile/file-receive.mjs")).href);

let checks = 0;
const check = async (name, fn) => { await fn(); checks += 1; console.log(`ok - ${name}`); };

const conversation = [
  { id: "u1", role: "user", content: "做一份报告", turnId: "t1" },
  { id: "a1", role: "assistant", content: "报告已生成", turnId: "t1", record: { artifacts: [
    { artifactId: "art_report", kind: "document", fileName: "报告.docx", bytes: 2048, mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" },
    { artifactId: "art_chart", kind: "image", fileName: "chart.png", bytes: 900 },
    { id: "", kind: "file", fileName: "no-id.txt" },
  ] } },
];

await check("only files on this conversation's produced-file cards, resolved by exact id", () => {
  assert.deepEqual([...conversationArtifactIds(conversation)], ["art_report", "art_chart"]);
  const resolve = (id) => ({ ok: true, artifactId: id, path: `/ws/out/${id}.bin`, artifact: { mimeType: "application/pdf" } });
  const stat = () => ({ isFile: true, size: 1000 });
  assert.deepEqual(planFileSend({ artifactId: "art_report", conversation, resolve, stat }), { ok: true, path: "/ws/out/art_report.bin", name: "art_report.bin", mimeType: "application/pdf", bytes: 1000 });
  assert.equal(planFileSend({ artifactId: "art_other_session", conversation, resolve, stat }).code, "FILE_NOT_IN_CONVERSATION", "an id this conversation never produced");
  assert.equal(planFileSend({ artifactId: "", conversation, resolve, stat }).code, "FILE_REQUEST_INVALID");
  assert.equal(planFileSend({ artifactId: "art_report", conversation, resolve: () => ({ ok: true, artifactId: "", path: "/etc/passwd" }), stat }).code, "FILE_NOT_FOUND", "a path-only resolution is refused");
  assert.equal(planFileSend({ artifactId: "art_report", conversation, resolve: () => ({ ok: false }), stat }).code, "FILE_NOT_FOUND");
  assert.equal(planFileSend({ artifactId: "art_report", conversation, resolve, stat: () => ({ isFile: false, size: 1 }) }).code, "FILE_NOT_FOUND", "a directory is not a file");
  const big = planFileSend({ artifactId: "art_report", conversation, resolve, stat: () => ({ isFile: true, size: FILE_LIMITS.MAX_BYTES + 1 }) });
  assert.equal(big.code, "FILE_TOO_LARGE");
});

await check("chunks fit the relay frame and reassemble, verified, on the phone", async () => {
  const buffer = crypto.randomBytes(FILE_LIMITS.CHUNK_BYTES * 2 + 1234);
  const frames = fileFrames({ requestId: "r1", artifactId: "art_chart", name: "chart.png", mimeType: "image/png", buffer });
  assert.equal(frames[0].type, "file.start");
  assert.equal(frames[0].count, 3);
  for (const frame of frames) assert.ok(Buffer.byteLength(JSON.stringify({ type: "relay.frame", grantId: "g_xxxxxxxxxxxx", frame })) < 256 * 1024, "under the relay's 256 KB limit");
  const receiver = createFileReceiver();
  let last = null;
  // out of order, with a duplicate
  for (const frame of [frames[0], frames[3], frames[1], frames[1], frames[2]]) last = (await receiver.onFrame(frame)) || last;
  assert.ok(last.done, "complete");
  assert.equal(Buffer.compare(Buffer.from(last.done.bytes), buffer), 0, "byte for byte");
  assert.equal(last.done.name, "chart.png");
  // corrupted in transit
  const bad = fileFrames({ requestId: "r2", artifactId: "a", name: "x", mimeType: "text/plain", buffer: Buffer.from("hello world") });
  bad[1] = { ...bad[1], data: Buffer.from("hellO world").toString("base64") };
  const r2 = createFileReceiver();
  await r2.onFrame(bad[0]);
  assert.equal((await r2.onFrame(bad[1])).error, "FILE_CORRUPTED");
  assert.equal((await createFileReceiver().onFrame({ type: "file.error", requestId: "r3", code: "FILE_TOO_LARGE" })).error, "FILE_TOO_LARGE");
});

await check("the phone's conversation lists each turn's produced files", () => {
  const view = mobileConversationView(conversation);
  const answer = view.items.find((i) => i.role === "assistant");
  assert.deepEqual(answer.artifacts, [
    { artifactId: "art_report", name: "报告.docx", kind: "document", bytes: 2048 },
    { artifactId: "art_chart", name: "chart.png", kind: "image", bytes: 900 },
  ], "id, name, kind, size — never the desktop path");
  assert.ok(!JSON.stringify(view).includes("/ws/"), "no local path travels");
});

await check("the controller serves a produced file of the session it drives, and says why when it cannot", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lily-filesend-"));
  const file = path.join(dir, "chart.png");
  const content = crypto.randomBytes(5000);
  fs.writeFileSync(file, content);
  const sent = [];
  const port = {
    activeProjectId: () => "p1", activeSessionId: () => "s1",
    findProject: (id) => (id === "p1" ? { id } : null),
    findSession: (id) => (id === "s1" ? { id, projectId: "p1" } : null),
    listProjects: () => [], listSessions: () => [{ id: "s1" }],
    readConversation: async (sid) => (sid === "s1" ? conversation : []),
    resolveArtifact: (sid, id) => (sid === "s1" && id === "art_chart" ? { ok: true, artifactId: id, path: file, artifact: { mimeType: "image/png" } } : { ok: false }),
  };
  const controller = createPhoneController({ grantId: "g", getDesktopDeviceId: () => "d", port, snapshot: async () => null, send: (f) => sent.push(f) });
  await controller.handle({ type: "file.request", requestId: "req1", artifactId: "art_chart" });
  assert.equal(sent[0].type, "file.start");
  assert.equal(sent[0].name, "chart.png");
  const receiver = createFileReceiver();
  let done = null;
  for (const frame of sent) done = (await receiver.onFrame(frame))?.done || done;
  assert.equal(Buffer.compare(Buffer.from(done.bytes), content), 0);
  sent.length = 0;
  await controller.handle({ type: "file.request", requestId: "req2", artifactId: "art_elsewhere" });
  assert.deepEqual(sent, [{ type: "file.error", requestId: "req2", code: "FILE_NOT_IN_CONVERSATION" }]);
  sent.length = 0;
  await controller.handle({ type: "file.request", requestId: "req3", path: file });
  assert.equal(sent[0].code, "FILE_REQUEST_INVALID", "a path request is never served");
  fs.rmSync(dir, { recursive: true, force: true });
});

console.log(`\n${checks} checks passed (mobile file send)`);
