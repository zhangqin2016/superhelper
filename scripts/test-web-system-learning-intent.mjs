#!/usr/bin/env node
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  WEB_SYSTEM_LEARNING_SKILL_ID,
  looksLikeWebSystemLearningIntent,
  buildWebSystemLearningPrompt,
  ensureWebSystemLearningSkillForSession,
} = require("../src/main/web-system-learning-intent.js");

assert.equal(
  looksLikeWebSystemLearningIntent("帮我学习这个 OA 系统，以后可以自动查审批"),
  true,
);
assert.equal(
  looksLikeWebSystemLearningIntent("学习 https://oa.example.com 这个系统怎么报销"),
  true,
);
assert.equal(
  looksLikeWebSystemLearningIntent("学习英语"),
  false,
);
assert.equal(
  looksLikeWebSystemLearningIntent("帮我分析这个网页截图", [{ path: "/tmp/a.png" }]),
  false,
);

const prompt = buildWebSystemLearningPrompt("学习 https://oa.example.com 这个 OA 系统");
assert.match(prompt, /lily-web-system-learning/);
assert.match(prompt, /不要让用户把密码、Cookie、Token 粘贴到聊天里/);
assert.match(prompt, /https:\/\/oa\.example\.com/);
assert.match(prompt, /扫描必须以前台 Bash\/tool 命令执行并等待完成/);
assert.match(prompt, /只有真实工具还在运行时才可以说“扫描正在运行\/等待完成”/);

const writes = [];
const fakeSession = {
  id: "session_1",
  projectId: "project_1",
  enabledSkillIds: null,
};
const fakeCtx = {
  sessionManager: {
    findById(id) {
      return id === fakeSession.id ? fakeSession : null;
    },
    setEnabledSkillIds(id, ids) {
      assert.equal(id, fakeSession.id);
      fakeSession.enabledSkillIds = ids;
      return true;
    },
  },
  projectManager: {
    find(id) {
      assert.equal(id, fakeSession.projectId);
      return { id, path: "/tmp/workspace" };
    },
  },
  runnerPool: {
    get(id) {
      assert.equal(id, fakeSession.id);
      return {
        isAlive: () => true,
        isBusy: () => true,
        reloadSkills: () => {
          throw new Error("busy runner must not reload immediately");
        },
      };
    },
    terminateSession() {
      throw new Error("busy runner must not be terminated when enabling the learning skill");
    },
  },
};

const skillManager = require("../src/main/skill-manager.js");
const originalList = skillManager.listSkillsForSessionPublic;
const originalNormalize = skillManager.normalizeSessionSkillSelection;
const originalWrite = skillManager.writeSessionAgentGuide;
try {
  skillManager.listSkillsForSessionPublic = () => ({
    effectiveIds: ["lily-office-intent"],
    skills: [
      { id: "lily-office-intent", sessionEnabled: true },
      { id: WEB_SYSTEM_LEARNING_SKILL_ID, sessionEnabled: false },
    ],
  });
  skillManager.normalizeSessionSkillSelection = (ids) => ids;
  skillManager.writeSessionAgentGuide = (sessionId, session, workspacePath) => {
    writes.push({ sessionId, session, workspacePath });
  };

  const ensured = ensureWebSystemLearningSkillForSession(fakeCtx, fakeSession.id);
  assert.deepEqual(ensured, {
    ok: true,
    changed: true,
    needsReloadBeforeNextTurn: true,
  });
  assert.equal(fakeSession.enabledSkillIds.includes(WEB_SYSTEM_LEARNING_SKILL_ID), true);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].workspacePath, "/tmp/workspace");
} finally {
  skillManager.listSkillsForSessionPublic = originalList;
  skillManager.normalizeSessionSkillSelection = originalNormalize;
  skillManager.writeSessionAgentGuide = originalWrite;
}

console.log("web-system-learning-intent: ok");
