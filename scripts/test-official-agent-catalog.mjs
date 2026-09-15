#!/usr/bin/env node
// Official 智能体 catalog: every entry validates in all three locales, every
// role references an existing official character, every skill id exists in
// the bundled registry, every knowledge pack is known, and the legal counsel
// agent carries the pack + tool that used to be a hard-coded coupling.
// Run: node scripts/test-official-agent-catalog.mjs
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const catalog = require("../src/main/agents/official-agent-catalog.js");
const characters = require("../src/main/character-worlds/official-character-catalog.js");
const { getKnowledgePack } = require("../src/main/agents/knowledge-packs.js");
const registry = require("../resources/skills-registry/registry.json");

const skillIds = new Set((registry.skills || registry).map((skill) => skill.id));
let checks = 0;
function check(name, fn) {
  fn();
  checks += 1;
  console.log(`ok - ${name}`);
}

check("every official agent validates in zh-CN, en and ar with a distinct name per locale", () => {
  for (const locale of ["zh-CN", "en", "ar"]) {
    const list = catalog.listOfficialAgents(locale);
    assert.equal(list.length, catalog.OFFICIAL_AGENTS.length);
    for (const item of list) {
      assert.equal(item.locale, locale);
      assert.ok(item.summary.name.length > 0);
      assert.ok(item.summary.starters.length >= 1, `${item.id} needs starters in ${locale}`);
      assert.ok(item.summary.dimensions.length >= 1, `${item.id} must set at least one dimension`);
    }
  }
  const zh = catalog.getOfficialAgent("lily-agent-deep-researcher", "zh-CN").definition.name;
  const en = catalog.getOfficialAgent("lily-agent-deep-researcher", "en").definition.name;
  assert.notEqual(zh, en);
  assert.equal(catalog.getOfficialAgent("lily-agent-deep-researcher", "de").locale, "en");
});

check("ids are unique and editorial order is total", () => {
  const ids = catalog.OFFICIAL_AGENTS.map((item) => item.id);
  assert.equal(new Set(ids).size, ids.length);
  const orders = catalog.OFFICIAL_AGENTS.map((item) => item.editorialOrder);
  assert.equal(new Set(orders).size, orders.length);
});

check("every role references an existing official character", () => {
  for (const item of catalog.OFFICIAL_AGENTS) {
    assert.ok(characters.getOfficialCharacter(item.roleOfficialId, "zh-CN"), `${item.id} → ${item.roleOfficialId}`);
    assert.equal(catalog.getOfficialAgent(item.id).definition.role.officialCharacterId, item.roleOfficialId);
  }
});

check("every skill id exists in the bundled registry and every pack is known", () => {
  for (const item of catalog.OFFICIAL_AGENTS) {
    const definition = catalog.getOfficialAgent(item.id).definition;
    for (const id of definition.skills.enabled) assert.ok(skillIds.has(id), `${item.id} references unknown skill ${id}`);
    for (const id of definition.knowledge.packs) assert.ok(getKnowledgePack(id), `${item.id} references unknown pack ${id}`);
  }
});

check("legal counsel agent replaces the hard-coded knowledge coupling with data", () => {
  const legal = catalog.getOfficialAgent("lily-agent-cn-legal-counsel", "zh-CN");
  assert.equal(legal.roleOfficialId, "lily-cn-legal-counsel");
  assert.deepEqual(legal.definition.knowledge.packs, ["legal-cn-enterprise"]);
  assert.deepEqual(legal.definition.tools.mcpAllow, ["lily_legal_search"]);
  assert.equal(legal.definition.autonomy.permissionModeId, "ask");
  assert.ok(legal.definition.skills.required.includes("lily-document-query"));
  assert.match(legal.definition.knowledge.guidance, /lily_legal_search/);
  assert.equal(legal.source.kind, "official");
  assert.equal(legal.source.officialId, "lily-agent-cn-legal-counsel");
});

check("official agents never set cold dimensions (no serve fork on activation)", () => {
  for (const item of catalog.listOfficialAgents("zh-CN")) {
    assert.equal(item.summary.cold, false, `${item.id} must stay hot-only`);
  }
  assert.equal(catalog.getOfficialAgent("missing"), null);
});

console.log(`\n${checks} checks passed (official agent catalog)`);
