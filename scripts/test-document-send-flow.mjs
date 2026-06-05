#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { EventEmitter } from "node:events";
import JSZip from "jszip";

const require = createRequire(import.meta.url);
const docPath = require.resolve("../src/main/document-translator.js");
const originalDoc = require(docPath);

const docCalls = [];
require.cache[docPath] = {
  id: docPath,
  filename: docPath,
  loaded: true,
  exports: {
    ...originalDoc,
    async extractDocuments(files) {
      docCalls.push(files);
      return {
        ok: true,
        text: "[文档内容: \"brief.docx\"]\n项目进度正常",
        extractedPaths: files.map((file) => file.path),
        keepOriginal: false,
      };
    },
  },
};

const { RuntimeEventBus } = require("../src/main/runtime-event-bus.js");
const { TranscriptStore } = require("../src/main/transcript-store.js");
const { TurnArchive } = require("../src/main/turn-archive.js");
const { TurnOrchestrator } = require("../src/main/turn-orchestrator.js");

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lily-doc-send-"));
const docxPath = path.join(tmpDir, "brief.docx");
const zip = new JSZip();
zip.file(
  "word/document.xml",
  "<w:document><w:body><w:p><w:r><w:t>placeholder</w:t></w:r></w:p></w:body></w:document>",
);
fs.writeFileSync(docxPath, await zip.generateAsync({ type: "nodebuffer" }));

const runnerPayloads = [];

class FakeRunner extends EventEmitter {
  constructor(sessionId) {
    super();
    this.sessionId = sessionId;
    this.busy = false;
  }
  isBusy() {
    return this.busy;
  }
  isAlive() {
    return true;
  }
  sendUserMessage(payload) {
    if (this.busy) return false;
    runnerPayloads.push(payload);
    this.busy = true;
    return true;
  }
}

const sent = [];
const fakeWindow = {
  isDestroyed: () => false,
  webContents: {
    send(channel, payload) {
      sent.push({ channel, payload });
    },
  },
};

const messages = [];
const session = { id: "s1", projectId: "p1", messages };
const runner = new FakeRunner("s1");
const ctx = {
  get mainWindow() {
    return fakeWindow;
  },
  eventBus: new RuntimeEventBus(() => fakeWindow),
  sessionManager: {
    findById: (id) => (id === "s1" ? session : null),
    pushMessageTo: (_sessionId, role, content, files) => {
      messages.push({ role, content, files });
    },
    getLastUserMessage: () => null,
    setAgentResumeId: () => {},
    clearAgentResumeId: () => {},
  },
  projectManager: {
    find: () => ({ id: "p1", path: process.cwd() }),
  },
  runnerPool: {
    get: () => runner,
    ensure: () => runner,
    terminateSession: () => {},
  },
};
ctx.transcriptStore = new TranscriptStore(ctx.sessionManager);
ctx.turnArchive = new TurnArchive(ctx.sessionManager);
ctx.turnOrchestrator = new TurnOrchestrator(ctx);

const docFiles = [{ path: docxPath, name: "brief.docx", isImage: false }];
const result = await ctx.turnOrchestrator.sendUserMessage("s1", "请总结附件", docFiles, {
  spawnEngine: false,
  skipPreflight: true,
  skipVision: true,
});
if (!result.ok) throw new Error(`send failed: ${JSON.stringify(result)}`);
if (docCalls.length !== 1) throw new Error("expected document preflight call");
if (messages[0]?.content !== "请总结附件") {
  throw new Error("user bubble should keep original text");
}
if (!runnerPayloads[0]?.text?.includes("项目进度正常")) {
  throw new Error("runner should receive extracted document text");
}
if ((runnerPayloads[0]?.files || []).length !== 0) {
  throw new Error("extracted documents should be removed from runner payload");
}

ctx.eventBus.flush();
const events = sent.flatMap((entry) => entry.payload?.events || []);
const noticeCodes = events
  .filter((event) => event.type === "engine.notice" || event.type === "engine.warning")
  .map((event) => event.payload?.notice?.code)
  .filter(Boolean);
if (!noticeCodes.includes("documentPreparing") || !noticeCodes.includes("documentReady")) {
  throw new Error(`missing document notices: ${noticeCodes.join(",")}`);
}

console.log("test-document-send-flow: ok");
