#!/usr/bin/env node
/**
 * Image send flow: user bubbles must commit before slow vision enrichment.
 */
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "lily-image-send-"));
const userData = path.join(tempRoot, "user-data");
const workspace = path.join(tempRoot, "workspace");
fs.mkdirSync(userData, { recursive: true });
fs.mkdirSync(workspace, { recursive: true });
process.resourcesPath = tempRoot;

const electronPath = require.resolve("electron");
require.cache[electronPath] = {
  id: electronPath,
  filename: electronPath,
  loaded: true,
  exports: {
    app: {
      isPackaged: false,
      getPath(name) {
        if (name === "userData") return userData;
        if (name === "home") return os.homedir();
        if (name === "documents") return tempRoot;
        return tempRoot;
      },
    },
  },
};

function mockModule(relativePath, exports) {
  const resolved = require.resolve(relativePath);
  require.cache[resolved] = {
    id: resolved,
    filename: resolved,
    loaded: true,
    exports,
  };
}

mockModule("../src/main/agent-command.js", {
  resolveAgentCommand: () => process.execPath,
});
mockModule("../src/main/agent-settings.js", {
  loadSettingsEnv: () => ({ LILY_API_KEY: "test-key" }),
  resolveSettingsEnvValue: () => "",
});
mockModule("../src/main/model-presets.js", {
  getUserApiEnv: () => ({}),
  getActivePresetEnv: () => ({}),
});
mockModule("../src/main/skill-manager.js", {
  writeSessionAgentGuide: () => path.join(userData, "guide"),
  getDisallowedTools: () => [],
});

const vision = require("../src/main/vision-translator.js");
let releaseVision;
let visionStarted = false;
vision.translateImages = async () => {
  visionStarted = true;
  await new Promise((resolve) => {
    releaseVision = resolve;
  });
  return {
    ok: true,
    text: "[图片识别结果]\n关键错误/异常：Session ID already in use",
    mode: "bug_screenshot",
    keepOriginal: true,
  };
};

const { dispatchUserLine } = require("../src/main/ipc-utils.js");

const session = { id: "sess_image_flow", projectId: "project_1" };
const pushed = [];
const sentEvents = [];
const enginePayloads = [];
const runner = {
  on: () => runner,
  isBusy: () => false,
  isAlive: () => true,
  sendUserMessage(payload) {
    enginePayloads.push(payload);
    return true;
  },
};

const ctx = {
  mainWindow: {
    isDestroyed: () => false,
    webContents: {
      send(channel, payload) {
        sentEvents.push({ channel, payload });
      },
    },
  },
  sessionManager: {
    findById: (id) => (id === session.id ? session : null),
    getActive: () => session,
    pushMessageTo(sessionId, role, content, files) {
      pushed.push({ sessionId, role, content, files });
    },
  },
  projectManager: {
    find: (id) => (id === session.projectId ? { id, path: workspace } : null),
    getActive: () => ({ id: session.projectId, path: workspace }),
  },
  runnerPool: {
    ensure: () => runner,
    get: () => runner,
    getSessionIds: () => [session.id],
  },
};

const imagePath = path.join(tempRoot, "bug.png");
fs.writeFileSync(imagePath, "fake image bytes");
const files = [{ name: "bug.png", path: imagePath, isImage: true, size: 16 }];

const pending = dispatchUserLine(ctx, session, "这个截图为什么不能发送？", files, {
  recordUser: true,
  spawnEngine: true,
  displayFiles: [{ name: "bug.png", isImage: true, thumbnail: "data:image/png;base64,x" }],
});

await new Promise((resolve) => setImmediate(resolve));

if (!visionStarted) throw new Error("vision enrichment should have started");
if (pushed[0]?.role !== "user") {
  throw new Error("user message should be persisted before vision resolves");
}
if (pushed[0]?.content !== "这个截图为什么不能发送？") {
  throw new Error(`display text should stay original, got ${pushed[0]?.content}`);
}
const committedBatch = sentEvents.find((e) => e.channel === "assistant:session-events")?.payload;
if (committedBatch?.events?.[0]?.type !== "user-committed") {
  throw new Error("user-committed event should be emitted before vision resolves");
}
const preparingNotice = sentEvents.find(
  (e) => e.channel === "assistant:engine-notice" && e.payload?.code === "visionPreparing",
);
if (!preparingNotice) {
  throw new Error("visionPreparing notice should be emitted while image analysis is pending");
}
if (enginePayloads.length !== 0) {
  throw new Error("engine send should wait for vision enrichment");
}

releaseVision();
const result = await pending;
if (!result?.ok) throw new Error(`dispatch should succeed, got ${JSON.stringify(result)}`);
if (enginePayloads.length !== 1) throw new Error("engine should receive one payload");
if (!enginePayloads[0].text.includes("关键错误/异常")) {
  throw new Error("engine text should include vision evidence");
}
const readyNotice = sentEvents.find(
  (e) => e.channel === "assistant:engine-notice" && e.payload?.code === "visionReady",
);
if (!readyNotice?.payload?.done) {
  throw new Error("visionReady notice should mark image analysis complete");
}
if (result.userCommitted.text !== "这个截图为什么不能发送？") {
  throw new Error("committed result should keep original display text");
}
if (!enginePayloads[0].files?.[0]?.isImage) {
  throw new Error("original image should remain in engine payload");
}

fs.rmSync(tempRoot, { recursive: true, force: true });
console.log("image-send-flow: ok");
