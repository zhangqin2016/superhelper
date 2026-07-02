#!/usr/bin/env node
/**
 * Image send pipeline: user commit → vision preflight → runner payload.
 */
import { createRequire } from "node:module";
import { EventEmitter } from "node:events";

const require = createRequire(import.meta.url);
const visionPath = require.resolve("../src/main/vision-translator.js");
const originalVision = require(visionPath);

const visionCalls = [];
require.cache[visionPath] = {
  id: visionPath,
  filename: visionPath,
  loaded: true,
  exports: {
    ...originalVision,
    async translateImages(files, options = {}) {
      visionCalls.push({ files, options });
      return {
        ok: true,
        text: "[图片识别结果]\n可见文字/OCR：hello world",
        mode: "general",
        keepOriginal: false,
      };
    },
  },
};

const { RuntimeEventBus } = require("../src/main/runtime-event-bus.js");
const { TranscriptStore } = require("../src/main/transcript-store.js");
const { TurnArchive } = require("../src/main/turn-archive.js");
const { TurnOrchestrator } = require("../src/main/turn-orchestrator.js");

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
    this.emit("status", "thinking");
    return true;
  }
  respondPermission() {
    return true;
  }
  respondUserQuestion() {
    return true;
  }
  respondHook() {
    return true;
  }
  interrupt() {
    this.busy = false;
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
    getActive: () => session,
    pushMessageTo: (_sessionId, role, content, files, extra) => {
      messages.push({ role, content, files, ...extra });
    },
    popLastAssistantMessage: () => false,
    getLastUserMessage: () => messages.find((m) => m.role === "user") || null,
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
    getSessionIds: () => ["s1"],
  },
};
ctx.transcriptStore = new TranscriptStore(ctx.sessionManager);
ctx.turnArchive = new TurnArchive(ctx.sessionManager);
ctx.turnOrchestrator = new TurnOrchestrator(ctx);
ctx.turnOrchestrator.bindRunner(runner);

const imageFiles = [{
  path: "/tmp/screen.png",
  name: "screen.png",
  isImage: true,
}];

const result = await ctx.turnOrchestrator.sendUserMessage(
  "s1",
  "请分析截图",
  imageFiles,
  { spawnEngine: false, skipPreflight: true },
);
if (!result.ok) throw new Error(`send failed: ${JSON.stringify(result)}`);
if (visionCalls.length !== 1) {
  throw new Error(`expected one vision call, got ${visionCalls.length}`);
}
if (visionCalls[0].options.userText !== "请分析截图") {
  throw new Error("vision preflight should receive user text");
}
if (messages.length !== 1 || messages[0].content !== "请分析截图") {
  throw new Error("user bubble should commit original text before vision enrichment");
}
if (runnerPayloads.length !== 1) {
  throw new Error(`expected one runner payload, got ${runnerPayloads.length}`);
}
const outboundText = runnerPayloads[0].text || "";
if (!outboundText.includes("[图片识别结果]")) {
  throw new Error("runner should receive vision-enriched text");
}
if (!outboundText.includes("请分析截图")) {
  throw new Error("runner should keep original user text");
}
if (!Array.isArray(runnerPayloads[0].files) || runnerPayloads[0].files.length !== 0) {
  throw new Error("runner should not receive original image files after successful vision translation");
}

ctx.eventBus.flush();
const events = sent.flatMap((entry) => entry.payload?.events || []);
const noticeCodes = events
  .filter((event) => event.type === "engine.notice" || event.type === "engine.warning")
  .map((event) => event.payload?.notice?.code)
  .filter(Boolean);
if (!noticeCodes.includes("visionPreparing")) {
  throw new Error(`missing visionPreparing notice, got ${noticeCodes.join(",")}`);
}
if (!noticeCodes.includes("visionReady")) {
  throw new Error(`missing visionReady notice, got ${noticeCodes.join(",")}`);
}
const turnStartedIdx = events.findIndex((event) => event.type === "turn.started");
const userCommittedIdx = events.findIndex((event) => event.type === "user.committed");
const visionPreparingIdx = events.findIndex(
  (event) => event.payload?.notice?.code === "visionPreparing",
);
if (userCommittedIdx < 0 || visionPreparingIdx < 0 || turnStartedIdx < 0) {
  throw new Error("missing ordering events");
}
if (!(userCommittedIdx < visionPreparingIdx && visionPreparingIdx < turnStartedIdx)) {
  throw new Error("expected user.committed → visionPreparing → turn.started ordering");
}

runnerPayloads.length = 0;
sent.length = 0;
messages.length = 0;
runner.busy = false;
ctx.turnOrchestrator.states.get("s1").phase = "idle";
ctx.turnOrchestrator.states.get("s1").turnId = null;
const untaggedImageFiles = [{
  path: "/tmp/untagged.png",
  name: "untagged.png",
}];
const untagged = await ctx.turnOrchestrator.sendUserMessage(
  "s1",
  "请分析这个图片",
  untaggedImageFiles,
  { spawnEngine: false, skipPreflight: true },
);
if (!untagged.ok) {
  throw new Error(`untagged image send failed: ${JSON.stringify(untagged)}`);
}
if (!runnerPayloads[0]?.text?.includes("[图片识别结果]")) {
  throw new Error("untagged image should still go through vision preflight");
}
if (!Array.isArray(runnerPayloads[0].files) || runnerPayloads[0].files.length !== 0) {
  throw new Error("untagged image should not be forwarded to the main model");
}

require.cache[visionPath].exports = {
  ...originalVision,
  async translateImages() {
    return { ok: false, reason: "NO_KEY" };
  },
};
runnerPayloads.length = 0;
sent.length = 0;
messages.length = 0;
runner.busy = false;
ctx.turnOrchestrator.states.get("s1").phase = "idle";
ctx.turnOrchestrator.states.get("s1").turnId = null;

const textOnlyFallback = await ctx.turnOrchestrator.sendUserMessage("s1", "看一下这个截图", imageFiles, {
  spawnEngine: false,
  skipPreflight: true,
});
if (!textOnlyFallback.ok) {
  throw new Error(`text+image without vision key should continue with text: ${JSON.stringify(textOnlyFallback)}`);
}
if (runnerPayloads.length !== 1 || !runnerPayloads[0].text?.includes("看一下这个截图")) {
  throw new Error(`runner should receive original user text when vision is unavailable: ${JSON.stringify(runnerPayloads)}`);
}
if (!runnerPayloads[0].text.includes("Image recognition fallback")) {
  throw new Error("runner should receive guarded fallback context when vision is unavailable");
}
if (!Array.isArray(runnerPayloads[0].files) || runnerPayloads[0].files.length !== 1) {
  throw new Error("runner should keep image files when vision is unavailable so native tooling can continue");
}
runnerPayloads.length = 0;
sent.length = 0;
messages.length = 0;
runner.busy = false;
ctx.turnOrchestrator.states.get("s1").phase = "idle";
ctx.turnOrchestrator.states.get("s1").turnId = null;

const blocked = await ctx.turnOrchestrator.sendUserMessage("s1", "", imageFiles, {
  spawnEngine: false,
  skipPreflight: true,
});
if (!blocked.ok || blocked.failed) {
  throw new Error(`image-only without vision key should continue with fallback context: ${JSON.stringify(blocked)}`);
}
if (runnerPayloads.length !== 1) {
  throw new Error("runner should receive payload when vision is unavailable");
}
if (!runnerPayloads[0].text?.includes("Image recognition fallback")) {
  throw new Error("image-only without vision key should include guarded fallback context");
}
if (!Array.isArray(runnerPayloads[0].files) || runnerPayloads[0].files.length !== 1) {
  throw new Error("image-only without vision key should keep original image file");
}
ctx.eventBus.flush();
if (!messages.some((message) => message.role === "user")) {
  throw new Error("image preflight fallback should still keep the user bubble");
}
const failedAssistant = messages.find((message) => message.role === "assistant");
if (failedAssistant?.failed) {
  throw new Error(`image preflight fallback should not create a failed assistant message: ${JSON.stringify(messages)}`);
}
const failedEvents = sent.flatMap((entry) => entry.payload?.events || []);
if (failedEvents.some((event) => event.type === "turn.failed")) {
  throw new Error("image preflight fallback should not emit turn.failed");
}

console.log("test-image-send-flow: ok");
