#!/usr/bin/env node
// Agent guidance (hot path): the bounded AGENT.md section carries mission,
// working method, knowledge packs and tool preferences in the app locale; the
// session guide extension contract is fail-open and signature-stable.
// Run: node scripts/test-agent-guidance.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { buildAgentGuidanceSection, MAX_SECTION_CHARS } = require("../src/main/agents/agent-guidance.js");
const { normalizeAgentDefinition } = require("../src/main/agents/agent-definition.js");
const { createAgentGuideExtension, invalidateSessionAgentPolicy } = require("../src/main/agents/session-agent-policy.js");
const { MessageStore } = require("../src/main/store/message-store.js");

let checks = 0;
function check(name, fn) {
  fn();
  checks += 1;
  console.log(`ok - ${name}`);
}

const definition = normalizeAgentDefinition({
  name: "中国企业法律顾问",
  description: "面向企业的法律问题分析",
  knowledge: { packs: ["legal-cn-enterprise"], guidance: "先确认管辖地；结论前先检索。" },
  tools: { mcpAllow: ["lily_legal_search"], connectors: ["mail"] },
  skills: { required: ["lily-document-query"] },
  autonomy: { permissionModeId: "ask" },
});

check("section carries every advisory dimension in zh-CN", () => {
  const section = buildAgentGuidanceSection(definition, "zh-CN");
  assert.match(section, /^\n## 当前智能体：中国企业法律顾问/);
  assert.match(section, /\*\*使命\*\*：面向企业的法律问题分析/);
  assert.match(section, /### 工作方法[^\n]*\n先确认管辖地；结论前先检索。/);
  assert.match(section, /中国企业法律知识库 \(legal-cn-enterprise\)/);
  assert.match(section, /### 优先使用的工具与连接器\n- lily_legal_search/);
  assert.match(section, /### 已授权的连接器\n- mail/);
  assert.match(section, /### 本智能体依赖的技能\n- lily-document-query/);
  assert.match(section, /自主度：执行前确认高风险操作/);
});

check("english and arabic locales render their own copy; unknown locale falls back to en", () => {
  assert.match(buildAgentGuidanceSection(definition, "en"), /## Active agent: 中国企业法律顾问/);
  assert.match(buildAgentGuidanceSection(definition, "en"), /China enterprise legal knowledge pack/);
  assert.match(buildAgentGuidanceSection(definition, "ar"), /## الوكيل النشط/);
  assert.match(buildAgentGuidanceSection(definition, "fr"), /## Active agent/);
});

check("an empty definition yields only the title; the section is bounded", () => {
  const bare = buildAgentGuidanceSection(normalizeAgentDefinition({ name: "空" }), "zh-CN");
  assert.equal(bare.trim(), "## 当前智能体：空");
  const long = buildAgentGuidanceSection(normalizeAgentDefinition({ name: "长", knowledge: { guidance: "g".repeat(4000) }, description: "d".repeat(2000), starters: [] }), "zh-CN");
  assert.ok(long.length <= MAX_SECTION_CHARS + 40);
  assert.equal(buildAgentGuidanceSection(null, "zh-CN"), "");
});

// --- guide extension contract over a real store ------------------------------
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agent-guidance-"));
const store = new MessageStore(path.join(tmp, "messages.db"), path.join(tmp, "blobs"));
const OWNER = "profile:account:guide-owner";
const SESSION = "session-guide";
const repo = store.agents();
const ctx = {
  agentRepository: repo,
  sessionManager: {
    resolveTurnOwnerScope: (id) => (id === SESSION ? { ok: true, ownerScope: OWNER } : { ok: false, error: "NO_SESSION" }),
    _store: () => store,
  },
};
try {
  check("extension is silent for unbound sessions and fail-open for unknown ones", () => {
    const extension = createAgentGuideExtension(ctx);
    assert.equal(extension.signature({ id: SESSION }), "");
    assert.equal(extension.build({ id: SESSION }, "zh-CN"), "");
    assert.equal(extension.signature({ id: "nope" }), "");
    assert.equal(createAgentGuideExtension({}).build({ id: SESSION }, "zh-CN"), "");
  });

  check("once bound, the extension renders the section and its signature tracks the revision", () => {
    const extension = createAgentGuideExtension(ctx);
    const revision = repo.createAgent({ ownerScope: OWNER, definition, source: { kind: "created" } }).revision;
    repo.setBinding({ sessionId: SESSION, ownerScope: OWNER, expectedBindingVersion: 0, agentRevisionId: revision.id });
    invalidateSessionAgentPolicy(SESSION);
    const sig1 = extension.signature({ id: SESSION });
    assert.equal(sig1, `agent:${revision.id}\0${revision.definitionHash}`);
    assert.match(extension.build({ id: SESSION }, "en"), /## Active agent: 中国企业法律顾问/);
    const revised = repo.createRevision({ ownerScope: OWNER, agentId: revision.agentId, expectedBaseRevisionId: revision.id, definition: { ...definition, description: "改了" }, source: { kind: "edited" } }).revision;
    // Bound sessions stay pinned to their admitted revision until re-activated.
    assert.equal(extension.signature({ id: SESSION }), sig1);
    repo.setBinding({ sessionId: SESSION, ownerScope: OWNER, expectedBindingVersion: 1, agentRevisionId: revised.id });
    invalidateSessionAgentPolicy(SESSION);
    assert.notEqual(extension.signature({ id: SESSION }), sig1);
    assert.match(extension.build({ id: SESSION }, "zh-CN"), /改了/);
    process.env.LILY_AGENTS = "0";
    invalidateSessionAgentPolicy(SESSION);
    assert.equal(extension.build({ id: SESSION }, "zh-CN"), "", "kill switch removes the section");
    delete process.env.LILY_AGENTS;
  });

  console.log(`\n${checks} checks passed (agent guidance)`);
} finally {
  delete process.env.LILY_AGENTS;
  store.close?.();
  fs.rmSync(tmp, { recursive: true, force: true });
}
