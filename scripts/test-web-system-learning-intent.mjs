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
assert.equal(
  looksLikeWebSystemLearningIntent("把我们刚才整理的合同审查流程生成一个工作区技能"),
  false,
  "generic workspace skill creation must use the general learned-skill contract, not web-system learning",
);
assert.equal(
  looksLikeWebSystemLearningIntent("创建一个写周报的技能"),
  false,
  "creating an arbitrary skill is not a web-system learning intent",
);
assert.equal(
  looksLikeWebSystemLearningIntent("帮我学习这个网站并生成工作区技能"),
  true,
  "web/system wording plus learning should still route to web-system learning",
);
assert.equal(
  looksLikeWebSystemLearningIntent("把 https://oa.example.com 生成一个工作区技能"),
  true,
  "URL plus skill creation should route to web-system learning",
);

const prompt = buildWebSystemLearningPrompt("学习 https://oa.example.com 这个 OA 系统");
assert.match(prompt, /lily-web-system-learning/);
assert.match(prompt, /不要让用户把密码、Cookie、Token、OAuth Code、CSRF 值或任何凭据头粘贴到聊天里/);
assert.match(prompt, /不要问用户“如何获取 token”/);
assert.match(prompt, /sessionPath/);
assert.match(prompt, /普通用户执行时禁止临场生成脚本、选择器或操作计划/);
assert.match(prompt, /https:\/\/oa\.example\.com/);
assert.match(prompt, /扫描必须以前台 Bash\/tool 命令执行并等待完成/);
assert.match(prompt, /只有真实工具还在运行时才可以说“扫描正在运行\/等待完成”/);
assert.match(prompt, /SPECIAL_BROWSER_CONTEXT_REQUIRED/);
assert.match(prompt, /最多一次捕获\+一次扫描/);
assert.match(prompt, /禁止尝试 stealth、反检测、改 webdriver、改 UA、换原生 Chrome/);

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

  const ensured = await ensureWebSystemLearningSkillForSession(fakeCtx, fakeSession.id);
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

// On-demand install fallback: the skill is a heavy opt-in marketplace skill
// (defaultEligible:false), so it may not be installed yet. When learning intent
// fires and it is missing, it must be installed from the registry on the spot,
// kept globally disabled (not enabled by default), then enabled for this session
// only — never dead-end with SKILL_NOT_AVAILABLE while it is installable.
const onDemandSession = {
  id: "session_2",
  projectId: "project_2",
  enabledSkillIds: null,
};
const onDemandCtx = {
  sessionManager: {
    findById: (id) => (id === onDemandSession.id ? onDemandSession : null),
    setEnabledSkillIds: (id, ids) => {
      onDemandSession.enabledSkillIds = ids;
      return true;
    },
  },
  projectManager: { find: (id) => ({ id, path: "/tmp/ws2" }) },
  runnerPool: { get: () => null, terminateSession: () => {} },
};
const origList2 = skillManager.listSkillsForSessionPublic;
const origNormalize2 = skillManager.normalizeSessionSkillSelection;
const origWrite2 = skillManager.writeSessionAgentGuide;
const origInstall = skillManager.installFromRegistry;
const origSetEnabled = skillManager.setSkillEnabled;
const calls = { install: 0, setEnabledFalse: 0 };
let installed = false;
try {
  skillManager.listSkillsForSessionPublic = () => ({
    effectiveIds: [],
    // skill appears only after the on-demand install runs
    skills: installed ? [{ id: WEB_SYSTEM_LEARNING_SKILL_ID, sessionEnabled: false }] : [],
  });
  skillManager.normalizeSessionSkillSelection = (ids) => ids;
  skillManager.writeSessionAgentGuide = () => {};
  skillManager.installFromRegistry = async (id) => {
    assert.equal(id, WEB_SYSTEM_LEARNING_SKILL_ID);
    calls.install += 1;
    installed = true;
    return { ok: true, id, version: "1.0.9" };
  };
  skillManager.setSkillEnabled = (id, enabled) => {
    assert.equal(id, WEB_SYSTEM_LEARNING_SKILL_ID);
    assert.equal(enabled, false, "on-demand install must keep the skill globally disabled");
    calls.setEnabledFalse += 1;
    return { ok: true };
  };

  const ensured = await ensureWebSystemLearningSkillForSession(onDemandCtx, onDemandSession.id);
  assert.equal(ensured.ok, true, "missing-but-installable skill should not dead-end");
  assert.equal(calls.install, 1, "skill installed on demand exactly once");
  assert.equal(calls.setEnabledFalse, 1, "skill kept globally disabled after install");
  assert.equal(
    onDemandSession.enabledSkillIds.includes(WEB_SYSTEM_LEARNING_SKILL_ID),
    true,
    "skill enabled for this session",
  );

  // When the registry has nothing to install, the honest error stays.
  installed = false;
  skillManager.installFromRegistry = async () => ({ ok: false, error: "NOT_FOUND" });
  const failed = await ensureWebSystemLearningSkillForSession(onDemandCtx, onDemandSession.id);
  assert.equal(failed.ok, false);
  assert.equal(failed.error, "SKILL_NOT_AVAILABLE");
} finally {
  skillManager.listSkillsForSessionPublic = origList2;
  skillManager.normalizeSessionSkillSelection = origNormalize2;
  skillManager.writeSessionAgentGuide = origWrite2;
  skillManager.installFromRegistry = origInstall;
  skillManager.setSkillEnabled = origSetEnabled;
}

console.log("web-system-learning-intent: ok");
