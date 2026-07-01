#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { EventEmitter } from "node:events";

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
    async extractDocuments(files, options = {}) {
      docCalls.push(files);
      options.onProgress?.({
        phase: "file-indexed",
        label: files[0]?.name || "mentioned.pdf",
        processed: 1,
        total: 1,
        indexPolicy: "paragraph-index",
      });
      return {
        ok: true,
        text: "[文档内容: \"张钦_命理全维度分析.pdf\"]\n这是一份命理全维度分析。",
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

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lily-doc-mention-send-"));
const docName = "张钦_命理全维度分析.pdf";
const docPathOnDisk = path.join(tmpDir, docName);
fs.writeFileSync(docPathOnDisk, "%PDF-1.4\n", "utf8");

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
const session = { id: "s-doc-mention", projectId: "p-doc", messages };
const runner = new FakeRunner(session.id);
const ctx = {
  get mainWindow() {
    return fakeWindow;
  },
  eventBus: new RuntimeEventBus(() => fakeWindow),
  sessionManager: {
    findById: (id) => (id === session.id ? session : null),
    pushMessageTo: (_sessionId, role, content, files) => {
      messages.push({ role, content, files });
    },
    getLastUserMessage: () => null,
    setAgentResumeId: () => {},
    clearAgentResumeId: () => {},
  },
  projectManager: {
    find: () => ({ id: "p-doc", path: tmpDir }),
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

const userText = `${docName}讲的什么`;
const result = await ctx.turnOrchestrator.sendUserMessage(session.id, userText, [], {
  spawnEngine: false,
  skipPreflight: true,
  skipVision: true,
});

if (!result.ok) throw new Error(`send failed: ${JSON.stringify(result)}`);
if (docCalls.length !== 1) throw new Error("mentioned document should enter document preflight");
if (docCalls[0][0]?.path !== fs.realpathSync(docPathOnDisk)) {
  throw new Error(`wrong mentioned document path: ${JSON.stringify(docCalls[0])}`);
}
if (messages[0]?.content !== userText) {
  throw new Error("user bubble should keep the original typed filename request");
}
if ((messages[0]?.files || []).length !== 0) {
  throw new Error("auto-resolved document should not appear as a user-attached chip");
}
if (!runnerPayloads[0]?.text?.includes("这是一份命理全维度分析")) {
  throw new Error("runner should receive extracted text for mentioned document");
}
if ((runnerPayloads[0]?.files || []).length !== 0) {
  throw new Error("extracted mentioned document should be removed from runner payload");
}

ctx.eventBus.flush();
const events = sent.flatMap((entry) => entry.payload?.events || []);
const notices = events.map((event) => event.payload?.notice?.code).filter(Boolean);
if (!notices.includes("documentPreparing") || !notices.includes("documentReady")) {
  throw new Error(`mentioned document should emit document notices, got: ${notices.join(",")}`);
}

console.log("test-document-mention-send-flow: ok");
