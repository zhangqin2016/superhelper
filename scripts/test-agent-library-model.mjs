import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  buildAgentLibraryItems,
  deriveAgentGroups,
  filterAgentItems,
  sortAgentItems,
  agentPrimaryAction,
  shortlistAgents,
  degradedDimensionLabels,
  agentIconGlyph,
} from "../src/renderer/modules/agent-library-model.js";
import { readCharacterAuthoringMarker } from "../src/renderer/modules/character-authoring-marker.js";
import { isConversationEmpty } from "../src/renderer/modules/agent-starters.js";

const summary = (name, extra = {}) => ({
  name, description: `${name} desc`, icon: "🧭", tags: ["合同"], starters: ["帮我审这份合同", "总结风险", "起草回复", "第四个不显示"],
  skills: { required: ["lily-doc-review"], enabled: ["lily-web-search"] },
  knowledge: { packs: ["legal-cn"], guidance: "" }, model: { presetId: "" },
  tools: { mcpAllow: ["lily_legal_search"], connectors: [], disallow: [] },
  autonomy: { permissionModeId: "ask" }, automations: [], dimensions: ["role", "skills"], cold: false, ...extra,
});

const payload = {
  ok: true,
  agents: [
    { id: "agent_local", name: "我的助理", official: false, officialId: null, currentRevisionId: "rev_l1", sourceKind: "agent_draft", updatedAt: "2026-09-10T00:00:00Z", archivedAt: null, inUse: 1, summary: summary("我的助理", { icon: "" }) },
    { id: "agent_legal", name: "合同审查助手", official: true, officialId: "lily-contract-review", currentRevisionId: "rev_o1", sourceKind: "official", updatedAt: "2026-09-12T00:00:00Z", archivedAt: null, inUse: 0, summary: summary("合同审查助手") },
    { id: "agent_old", name: "旧助理", official: false, officialId: null, currentRevisionId: "rev_x", sourceKind: "created", updatedAt: "2026-01-01T00:00:00Z", archivedAt: "2026-02-01T00:00:00Z", inUse: 0, summary: summary("旧助理") },
  ],
  official: [
    { id: "lily-contract-review", version: 2, locale: "zh-CN", categoryId: "legal-finance", editorialOrder: 1, featured: true, official: true, installedAgentId: "agent_legal", currentRevisionId: "rev_o1", installedVersion: 1, updateAvailable: true, summary: summary("合同审查助手") },
    { id: "lily-weekly-report", version: 1, locale: "zh-CN", categoryId: "work-delivery", editorialOrder: 2, featured: true, official: true, installedAgentId: null, currentRevisionId: null, installedVersion: 0, updateAvailable: false, summary: summary("周报助手", { autonomy: { permissionModeId: "full" }, model: { presetId: "deepseek-v4-pro" } }) },
  ],
  distributed: [
    { packageId: "pkg_1", agentId: "org-onboarding", version: 3, scope: "organization", publisher: "ACME", featured: false, isDefault: true, installedAgentId: null, summary: summary("入职向导") },
  ],
  defaultAgentId: "org-onboarding",
  knowledgePacks: [{ id: "legal-cn", name: "中国法律知识包" }],
};

// Merge + dedupe: installed official row takes the local entity id.
const items = buildAgentLibraryItems(payload, { activeAgentId: "agent_legal" });
const byId = Object.fromEntries(items.map((item) => [item.id, item]));
assert.equal(items.length, 5, "3 local (1 consumed by official) + 1 official + 1 distributed");
assert.ok(byId.agent_legal.official && byId.agent_legal.installed && byId.agent_legal.active, "installed official is deduped into the local entity");
assert.equal(byId.agent_legal.updateAvailable, true);
assert.equal(byId["official:lily-weekly-report"].installed, false);
assert.equal(byId["distributed:pkg_1"].distributed, true);
assert.equal(byId["distributed:pkg_1"].isDefault, true);
assert.equal(byId.agent_local.sourceKind, "agent_draft");
assert.equal(byId.agent_local.icon, "", "an empty icon renders as a monogram");
assert.equal(byId.agent_legal.icon, "🧭");
assert.equal(byId.agent_old.archived, true);
assert.deepEqual(byId.agent_legal.summary.starters.length, 3, "starters are capped at 3");
assert.equal(byId.agent_legal.summary.knowledge.packs[0].name, "中国法律知识包", "knowledge pack ids resolve to names");

// Groups.
const groups = Object.fromEntries(deriveAgentGroups(items).map((group) => [group.id, group.count]));
assert.deepEqual(groups, { featured: 4, all: 4, official: 2, distributed: 1, my: 1, recent: 2, archived: 1 });

// Filters + sort.
assert.deepEqual(filterAgentItems(items, { query: "周报", groupId: "all" }).map((item) => item.id), ["official:lily-weekly-report"]);
assert.equal(filterAgentItems(items, { tag: "合同", groupId: "all" }).length, 4);
assert.equal(filterAgentItems(items, { query: "lily-doc-review", groupId: "all" }).length, 4, "search covers skills");
assert.equal(sortAgentItems(filterAgentItems(items, { groupId: "all" }))[0].id, "agent_legal", "the active agent sorts first");

// Primary action per state.
assert.equal(agentPrimaryAction(byId.agent_legal), "deactivate");
assert.equal(agentPrimaryAction(byId.agent_local), "use");
assert.equal(agentPrimaryAction(byId["official:lily-weekly-report"]), "install");
assert.equal(agentPrimaryAction(byId["distributed:pkg_1"]), "pending");

// Popover ordering (2026-09-15: the picker lists EVERY agent): installed first,
// then official, distributed-pending last; the cap is optional.
const shortlist = shortlistAgents(items, 6).map((item) => item.id);
assert.deepEqual(shortlist, ["agent_legal", "agent_local", "official:lily-weekly-report", "distributed:pkg_1"]);
assert.equal(shortlistAgents(items, 1).length, 1);

// Degraded receipt → localized dimension labels (deduped, unknown passthrough).
const labels = degradedDimensionLabels({ degraded: [{ dimension: "model", reason: "x" }, { dimension: "model" }, { dimension: "tools" }, { dimension: "weird" }] }, (key) => key.split(".").pop());
assert.deepEqual(labels, ["model", "tools", "weird"]);
assert.deepEqual(degradedDimensionLabels(null, (k) => k), []);

// Icon detection: emoji yes, words no.
assert.equal(agentIconGlyph("🧭"), "🧭");
assert.equal(agentIconGlyph("Bot"), "");
assert.equal(agentIconGlyph(""), "");

// Authoring marker accepts kind "agent" (main-side routing key).
const input = { dataset: { characterAuthoringKind: "agent", characterAuthoringStarter: "帮我创建一个智能体" } };
assert.deepEqual(readCharacterAuthoringMarker(input, "帮我创建一个智能体：审合同"), { kind: "agent", starter: "帮我创建一个智能体" });
assert.equal(readCharacterAuthoringMarker({ dataset: { characterAuthoringKind: "bogus", characterAuthoringStarter: "x" } }, "x"), null);

// Starters only for an empty, idle conversation.
assert.equal(isConversationEmpty({ conversation: [], runtime: { committedMessages: [], phase: "idle" } }), true);
assert.equal(isConversationEmpty({ conversation: [{}], runtime: { committedMessages: [], phase: "idle" } }), false);
assert.equal(isConversationEmpty({ conversation: [], runtime: { committedMessages: [{}], phase: "idle" } }), false);
assert.equal(isConversationEmpty({ conversation: [], runtime: { committedMessages: [], phase: "running" } }), false);

// Hostile payloads stay bounded and never throw.
assert.deepEqual(buildAgentLibraryItems(null), []);
assert.deepEqual(buildAgentLibraryItems({ agents: [{ id: 5 }], official: [{}], distributed: [{ packageId: 1 }] }), []);
const huge = buildAgentLibraryItems({ agents: [{ id: "a", name: "x".repeat(5000), summary: { starters: Array(50).fill("s"), tags: Array(500).fill("t") } }] });
assert.equal(huge[0].name.length, 256);
assert.equal(huge[0].tags.length, 32);

// Every new key resolves in all three locales.
const required = [
  "character.library.tabAgents", "character.library.aiCreateAgentPrompt", "character.library.facetHintAgent",
  "character.library.groupDistributed", "character.library.selectHintAgent",
  "character.agent.sectionHeading", "character.agent.noneOption", "character.agent.manageLibrary", "character.agent.bannerActive",
  "character.agent.startersLabel", "character.agent.sidebarMark", "character.agent.emptyList", "character.agent.import",
  "character.agent.restore", "character.agent.confirmRestore", "character.agent.badgeDistributed", "character.agent.badgeDraft",
  "character.agent.badgeDefault", "character.agent.detailStarters", "character.agent.detailCapabilities", "character.agent.capSkills",
  "character.agent.capKnowledge", "character.agent.capTools", "character.agent.capAutonomy", "character.agent.capModel",
  "character.agent.capAutomations", "character.agent.automationsCount", "character.agent.inherit", "character.agent.modelInherit",
  "character.agent.autonomy.inherit", "character.agent.autonomy.plan", "character.agent.autonomy.ask", "character.agent.autonomy.full",
  "character.agent.dimension.role", "character.agent.dimension.skills", "character.agent.dimension.autonomy",
  "character.agent.dimension.knowledge", "character.agent.dimension.model", "character.agent.dimension.tools",
  "character.agent.dimension.automations", "character.agent.activated", "character.agent.activatedDegraded", "character.agent.removed",
  "character.agent.distributedPending", "character.agent.unavailable", "character.agent.disabled", "character.agent.busy",
  "character.agent.conflict", "character.agent.exported", "character.agent.imported", "character.agent.importFailed",
  "character.agent.archived", "character.agent.restored",
];
for (const locale of ["zh-CN", "en", "ar"]) {
  const data = JSON.parse(await readFile(`src/renderer/i18n/locales/${locale}.json`, "utf8"));
  for (const key of required) {
    assert.equal(typeof data[key], "string", `${locale} is missing ${key}`);
    assert.ok(data[key].trim(), `${locale} has empty ${key}`);
  }
}

console.log("PASS: test-agent-library-model");
