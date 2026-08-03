#!/usr/bin/env node

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import Module from "node:module";

const require = createRequire(import.meta.url);
const handlers = new Map();
const originalLoad = Module._load;
const calls = {
  sessionSwitch: 0,
  projectSwitch: 0,
  sent: [],
  interrupted: [],
  guideWrites: [],
  approved: [],
  dismissed: [],
  removedLearned: [],
  clearedLearned: [],
  appendedLearned: [],
  categoryPrefs: [],
};
const proposals = [
  { key: "checkopencodefirst", text: "以后先检查 OpenCode 原生能力", status: "proposed" },
];
let learned = [
  { key: "reportformat", text: "报告先给结论", createdAt: "2026-06-25", line: 1 },
];

Module._load = function patchedLoad(request, parent, isMain) {
  if (request === "electron") {
    return {
      ipcMain: {
        handle(channel, handler) {
          handlers.set(channel, handler);
        },
      },
    };
  }
  if (request.endsWith("./license-manager") || request === "./license-manager") {
    return {
      requireValidLicense: () => ({ ok: true }),
      requireValidLicenseFresh: async () => ({ ok: true }),
    };
  }
  if (request.endsWith("./scheduled-task-intent") || request === "./scheduled-task-intent") {
    return { looksLikeScheduledTaskIntent: () => false };
  }
  if (request.endsWith("./web-system-learning-intent") || request === "./web-system-learning-intent") {
    return {
      buildWebSystemLearningPrompt: (text) => text,
      ensureWebSystemLearningSkillForSession: async () => ({ ok: true }),
      looksLikeWebSystemLearningIntent: () => false,
    };
  }
  if (request.endsWith("/authoring-availability") || request === "./authoring-availability") {
    return { ensureCharacterAuthoringAvailable: async () => ({ ok: true, refreshed: false }) };
  }
  if (request.endsWith("./auto-memory-proposals") || request === "./auto-memory-proposals") {
    return {
      approveMemoryProposal: (_projectId, key, details) => {
        calls.approved.push({ key, details });
        const proposal = proposals.find((item) => item.key === key);
        if (!proposal) return null;
        proposal.status = "approved";
        return proposal;
      },
      dismissMemoryProposal: (_projectId, key, details) => {
        calls.dismissed.push({ key, details });
        const proposal = proposals.find((item) => item.key === key);
        if (!proposal) return null;
        proposal.status = "dismissed";
        return proposal;
      },
      listMemoryProposals: (_projectId, options = {}) =>
        options.includeDismissed ? proposals : proposals.filter((item) => item.status !== "dismissed"),
    };
  }
  if (request.endsWith("./learned-context") || request === "./learned-context") {
    return {
      appendLearnedConvention: (projectId, text) => {
        calls.appendedLearned.push({ projectId, text });
        return "- remembered\n";
      },
      clearLearnedConventions: (projectId) => {
        calls.clearedLearned.push(projectId);
        learned = [];
        return true;
      },
      listLearnedConventions: () => learned,
      removeLearnedConvention: (_projectId, key) => {
        calls.removedLearned.push(key);
        const before = learned.length;
        learned = learned.filter((item) => item.key !== key);
        return learned.length === before ? null : { removed: before - learned.length, key };
      },
    };
  }
  if (request.endsWith("./skill-manager") || request === "./skill-manager") {
    return {
      writeSessionAgentGuide: (sessionId, session, workspacePath) => {
        calls.guideWrites.push({ sessionId, projectId: session?.projectId, workspacePath });
      },
    };
  }
  if (request.endsWith("./session-memory") || request === "./session-memory") {
    return {
      readSessionSummary: (sessionId) => ({ sessionId, turnCount: 12 }),
    };
  }
  if (request.endsWith("./memory-preferences") || request === "./memory-preferences") {
    return {
      MEMORY_CATEGORIES: ["learned_conventions", "project_memory"],
      readMemoryPreferences: () => ({ schemaVersion: 1, disabledKinds: ["project_memory"] }),
      setMemoryCategoryEnabled: (_projectId, kind, enabled) => {
        calls.categoryPrefs.push({ kind, enabled });
        return { schemaVersion: 1, disabledKinds: enabled ? [] : [kind] };
      },
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

try {
  const { registerAssistantHandlers } = require("../src/main/ipc-assistant.js");
  const sessions = new Map([
    ["active-session", { id: "active-session", projectId: "active-project" }],
    ["target-session", { id: "target-session", projectId: "target-project" }],
    ["no-project-session", { id: "no-project-session" }],
  ]);
  const ctx = {
    sessionManager: {
      activeSessionId: "active-session",
      findById: (id) => sessions.get(id) || null,
      getActive: () => sessions.get("active-session"),
      switchTo: () => {
        calls.sessionSwitch += 1;
      },
      pushMessageTo: () => {},
    },
    projectManager: {
      getActive: () => ({ id: "active-project" }),
      find: (id) => ({ id, path: `/projects/${id}` }),
      switchTo: () => {
        calls.projectSwitch += 1;
      },
    },
    turnOrchestrator: {
      sendUserMessage: async (sessionId, text, files, options) => {
        calls.sent.push({ sessionId, text, files, options });
        return { ok: true, turnId: "turn-send" };
      },
      interruptAndSend: async (sessionId, text, files, options) => {
        calls.interrupted.push({ sessionId, text, files, options });
        return { ok: true, turnId: "turn-interrupt" };
      },
    },
  };

  registerAssistantHandlers(ctx);
  assert.equal(typeof handlers.get("assistant:input"), "function", "assistant:input handler registered");
  assert.equal(
    typeof handlers.get("assistant:interrupt-and-send"),
    "function",
    "assistant:interrupt-and-send handler registered",
  );

  const sendResult = await handlers.get("assistant:input")(null, {
    sessionId: "target-session",
    text: "send in background",
    files: [{ path: "/tmp/a.txt" }],
    displayFiles: [{ name: "a.txt" }],
  });
  assert.deepEqual(sendResult, {
    ok: true,
    turnId: "turn-send",
    sessionId: "target-session",
    projectId: "target-project",
  });
  assert.equal(calls.sent.length, 1, "sendUserMessage called once");
  assert.equal(calls.sent[0].sessionId, "target-session");
  assert.equal(calls.sent[0].text, "send in background");
  assert.equal(calls.sent[0].options.displayFiles[0].name, "a.txt");

  const interruptResult = await handlers.get("assistant:interrupt-and-send")(null, {
    sessionId: "target-session",
    text: "priority background",
  });
  assert.deepEqual(interruptResult, {
    ok: true,
    turnId: "turn-interrupt",
    sessionId: "target-session",
    projectId: "target-project",
  });
  assert.equal(calls.interrupted.length, 1, "interruptAndSend called once");
  assert.equal(calls.interrupted[0].sessionId, "target-session");

  await handlers.get("assistant:input")(null, {
    sessionId: "target-session",
    text: "أريد دورا ممتازا",
    characterAuthoringKind: "character",
  });
  const authored = calls.sent.at(-1);
  assert.deepEqual(authored.options.requiredSuccessfulTools, ["lily_character_draft"]);
  assert.match(authored.options.engineText, /kind=character/);
  assert.match(authored.options.engineText, /Do not create a Markdown/);

  await handlers.get("assistant:steer")(null, {
    sessionId: "target-session",
    text: "Create a world setting",
    characterAuthoringKind: "worldBook",
  });
  const queuedAuthoring = calls.sent.at(-1);
  assert.equal(queuedAuthoring.options.mode, undefined, "authoring is an independent queued turn, not steer");
  assert.deepEqual(queuedAuthoring.options.requiredSuccessfulTools, ["lily_character_draft"]);
  assert.equal(calls.sessionSwitch, 0, "targeted send must not switch active session");
  assert.equal(calls.projectSwitch, 0, "targeted send must not switch active project");

  const memoryList = await handlers.get("assistant:memory:list")(null, {
    sessionId: "target-session",
  });
  assert.deepEqual(memoryList, {
    ok: true,
    sessionId: "target-session",
    projectId: "target-project",
    learned,
    proposals,
    preferences: { schemaVersion: 1, disabledKinds: ["project_memory"] },
    categories: ["learned_conventions", "project_memory"],
  });

  const rememberResult = await handlers.get("assistant:remember-convention")(null, {
    sessionId: "target-session",
    text: "记住这个项目的输出格式",
  });
  assert.equal(rememberResult.ok, true);
  assert.deepEqual(calls.appendedLearned.at(-1), {
    projectId: "target-project",
    text: "记住这个项目的输出格式",
  });

  const rememberNoProject = await handlers.get("assistant:remember-convention")(null, {
    sessionId: "no-project-session",
    text: "不能写到全局",
  });
  assert.deepEqual(rememberNoProject, { ok: false, error: "NO_PROJECT" });
  assert.equal(
    calls.appendedLearned.some((item) => item.text === "不能写到全局"),
    false,
    "remember-convention must fail before writing when session has no project",
  );

  const setCategory = await handlers.get("assistant:memory:set-category-enabled")(null, {
    sessionId: "target-session",
    kind: "project_memory",
    enabled: true,
  });
  assert.equal(setCategory.ok, true);
  assert.deepEqual(calls.categoryPrefs[0], { kind: "project_memory", enabled: true });
  assert.equal(calls.guideWrites.at(-1).sessionId, "target-session");

  const memoryExport = await handlers.get("assistant:memory:export")(null, {
    sessionId: "target-session",
  });
  assert.equal(memoryExport.ok, true);
  assert.equal(memoryExport.sessionId, "target-session");
  assert.equal(memoryExport.projectId, "target-project");
  assert.equal(memoryExport.memory.learned.length, 1);
  assert.equal(memoryExport.memory.proposals.length, 1);
  assert.equal(memoryExport.memory.sessionSummary.turnCount, 12);

  const removeLearned = await handlers.get("assistant:memory:remove-learned")(null, {
    sessionId: "target-session",
    key: "reportformat",
  });
  assert.equal(removeLearned.ok, true);
  assert.equal(calls.removedLearned[0], "reportformat");
  assert.deepEqual(calls.guideWrites.at(-1), {
    sessionId: "target-session",
    projectId: "target-project",
    workspacePath: "/projects/target-project",
  });

  learned = [{ key: "runtime", text: "先看 OpenCode", createdAt: "2026-06-25", line: 1 }];
  const clearLearned = await handlers.get("assistant:memory:clear-learned")(null, {
    sessionId: "target-session",
  });
  assert.equal(clearLearned.ok, true);
  assert.equal(calls.clearedLearned[0], "target-project");
  assert.equal(learned.length, 0);

  const listResult = await handlers.get("assistant:memory-proposals:list")(null, {
    sessionId: "target-session",
  });
  assert.deepEqual(listResult, {
    ok: true,
    sessionId: "target-session",
    projectId: "target-project",
    proposals,
  });

  const approveResult = await handlers.get("assistant:memory-proposals:approve")(null, {
    sessionId: "target-session",
    key: "checkopencodefirst",
  });
  assert.equal(approveResult.ok, true);
  assert.equal(approveResult.proposal.status, "approved");
  assert.equal(calls.approved.length, 1, "approveMemoryProposal called once");
  assert.equal(calls.approved[0].details.approvedBy, "user");
  assert.deepEqual(calls.guideWrites.at(-1), {
    sessionId: "target-session",
    projectId: "target-project",
    workspacePath: "/projects/target-project",
  });

  const dismissResult = await handlers.get("assistant:memory-proposals:dismiss")(null, {
    sessionId: "target-session",
    key: "checkopencodefirst",
  });
  assert.equal(dismissResult.ok, true);
  assert.equal(dismissResult.proposal.status, "dismissed");
  assert.equal(calls.dismissed.length, 1, "dismissMemoryProposal called once");
  assert.equal(calls.dismissed[0].details.dismissedBy, "user");

  console.log("assistant-ipc-routing: ok");
} finally {
  Module._load = originalLoad;
}
