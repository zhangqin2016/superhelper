#!/usr/bin/env node
// 智能体 workspace pack section: bound agents export as definitions (local
// role cards embedded only on opt-in, official roles stay references, no
// local ids/owner leak), import validates, dedupes identical definitions,
// recreates role cards through the character pipeline, and a full
// .lilyspace round trip through workspace-share carries the section.
// Run: node scripts/test-agent-workspace-portability.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { MessageStore } = require("../src/main/store/message-store.js");
const portability = require("../src/main/agents/workspace-portability.js");
const { exportWorkspacePack, importWorkspacePack } = require("../src/main/workspace-share.js");

const OWNER = "profile:account:pack-owner";
const OTHER = "profile:account:pack-other";

let checks = 0;
async function check(name, fn) {
  await fn();
  checks += 1;
  console.log(`ok - ${name}`);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agent-pack-"));
const store = new MessageStore(path.join(tmp, "messages.db"), path.join(tmp, "blobs"));
const agentRepo = store.agents();
const characterRepo = store.characterWorlds();

try {
  const card = characterRepo.createCharacter({ ownerScope: OWNER, canonical: { name: "本地角色", description: "d", personality: "p", scenario: "s" }, source: { kind: "created", format: "lily", container: "json" } });
  const local = agentRepo.createAgent({ ownerScope: OWNER, definition: { name: "本地智能体", role: { characterEntityId: card.entity.id }, skills: { enabled: ["anthropics-docx"] } }, source: { kind: "created" } }).revision;
  const official = agentRepo.createAgent({ ownerScope: OWNER, definition: { name: "官方引用", role: { officialCharacterId: "lily-researcher" } }, source: { kind: "official", officialId: "lily-agent-deep-researcher" } }).revision;
  agentRepo.setBinding({ sessionId: "s-local", ownerScope: OWNER, expectedBindingVersion: 0, agentRevisionId: local.id });
  agentRepo.setBinding({ sessionId: "s-official", ownerScope: OWNER, expectedBindingVersion: 0, agentRevisionId: official.id });
  const sessions = [{ sessionId: "s-local", ownerScope: OWNER }, { sessionId: "s-official", ownerScope: OWNER }, { sessionId: "s-unbound", ownerScope: OWNER }];

  let json;
  await check("export collects bound agents only; local role is stripped unless role cards are included", async () => {
    const plain = portability.collectAgentsForExport(agentRepo, characterRepo, sessions);
    assert.equal(plain.agents.length, 2);
    const localEntry = plain.agents.find((a) => a.displayName === "本地智能体");
    assert.equal(localEntry.definition.role, null);
    assert.equal(localEntry.roleCard, undefined);
    const officialEntry = plain.agents.find((a) => a.displayName === "官方引用");
    assert.deepEqual(officialEntry.definition.role, { officialCharacterId: "lily-researcher" });
    assert.equal(officialEntry.source.officialId, "lily-agent-deep-researcher");
    const withCards = portability.collectAgentsForExport(agentRepo, characterRepo, sessions, { includeRoleCards: true });
    const withCard = withCards.agents.find((a) => a.displayName === "本地智能体");
    assert.equal(withCard.roleCard.canonical.name, "本地角色");
    json = portability.packAgentsSection(withCards).json;
    assert.ok(!json.includes(OWNER), "owner scope never leaves the machine");
    assert.ok(!json.includes(card.entity.id), "local character ids never leave the machine");
    assert.ok(!json.includes("s-local"), "session ids never leave the machine");
    assert.equal(portability.packAgentsSection({ agents: [] }).json, "");
  });

  await check("import recreates role cards, dedupes identical definitions, records imported provenance", async () => {
    const section = portability.unpackAgentsSection(json);
    const first = portability.importAgentsPack(agentRepo, characterRepo, OTHER, section, { importedFrom: "demo.lilyspace.zip" });
    assert.equal(first.imported.length, 2);
    assert.equal(first.errors.length, 0);
    const importedLocal = agentRepo.getRevision(OTHER, first.imported.find((i) => i.displayName === "本地智能体").revisionId);
    assert.equal(importedLocal.source.kind, "imported");
    assert.equal(importedLocal.source.importedFrom, "demo.lilyspace.zip");
    const roleEntity = characterRepo.getCharacter(OTHER, importedLocal.definition.role.characterEntityId);
    assert.equal(characterRepo.getRevision(OTHER, roleEntity.currentRevisionId).canonical.name, "本地角色");
    const again = portability.importAgentsPack(agentRepo, characterRepo, OTHER, section);
    assert.equal(again.imported.length, 0);
    assert.equal(again.skipped.length, 2);
    assert.equal(again.skipped[0].reason, "duplicate");
    assert.equal(agentRepo.listAgents(OTHER).length, 2, "re-import adds nothing");
    assert.equal(characterRepo.listCharacters(OTHER).length, 1, "identical role card reused, not duplicated");
  });

  await check("hostile sections fail by code and never write partial junk", async () => {
    assert.throws(() => portability.unpackAgentsSection("{not json"), (e) => e.code === "AGENT_PACK_CORRUPT");
    assert.throws(() => portability.unpackAgentsSection(JSON.stringify({ schemaVersion: 99, agents: [] })), (e) => e.code === "AGENT_PACK_TOO_NEW");
    assert.deepEqual(portability.unpackAgentsSection(""), { schemaVersion: 1, agents: [] });
    const before = agentRepo.listAgents(OTHER).length;
    const bad = portability.importAgentsPack(agentRepo, characterRepo, OTHER, { agents: [{ displayName: "坏", definition: { name: "" } }, { definition: { name: "好的", role: { characterEntityId: "leaked-local-id" } } }] });
    assert.equal(bad.errors.length, 1);
    assert.equal(bad.errors[0].code, "AGENT_DEFINITION_INVALID");
    assert.equal(bad.imported.length, 1);
    assert.equal(agentRepo.getRevision(OTHER, bad.imported[0].revisionId).definition.role, null, "foreign local role ids are dropped");
    assert.equal(agentRepo.listAgents(OTHER).length, before + 1);
  });

  await check(".lilyspace round trip carries the agents section next to character-worlds", async () => {
    const workspace = path.join(tmp, "ws");
    fs.mkdirSync(workspace, { recursive: true });
    fs.writeFileSync(path.join(workspace, "notes.md"), "# hello\n");
    const buffer = await exportWorkspacePack({
      rootPath: workspace, name: "demo", requiredSkills: [], workspaceSkills: [], automationTemplates: [],
      exportedAt: new Date().toISOString(), characterWorlds: "", agents: json,
    });
    const target = path.join(tmp, "imported");
    const imported = await importWorkspacePack(buffer, target);
    assert.equal(imported.agents, json, "section survives the zip byte-for-byte");
    const result = portability.importAgentsPack(agentRepo, characterRepo, "profile:account:third", portability.unpackAgentsSection(imported.agents));
    assert.equal(result.imported.length, 2);
    const without = await exportWorkspacePack({ rootPath: workspace, name: "demo", requiredSkills: [], workspaceSkills: [], automationTemplates: [], exportedAt: new Date().toISOString(), characterWorlds: "", agents: "" });
    assert.equal((await importWorkspacePack(without, path.join(tmp, "imported2"))).agents, "", "no section when nothing was exported");
  });

  console.log(`\n${checks} checks passed (agent workspace portability)`);
} finally {
  store.close?.();
  fs.rmSync(tmp, { recursive: true, force: true });
}
