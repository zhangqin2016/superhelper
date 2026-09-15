#!/usr/bin/env node
// 智能体 repository over messages.db: owner-scoped entities, immutable
// revisions with CAS + idempotent same-content writes, official install
// uniqueness, session binding CAS with receipt/previous snapshot, append-only
// events, and the lily-agent file import path (embedded role card).
// Run: node scripts/test-agent-repository.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { MessageStore } = require("../src/main/store/message-store.js");
const { AgentRepository } = require("../src/main/agents/agent-repository.js");
const { importAgentFile } = require("../src/main/ipc-agents.js");

const OWNER = "profile:account:test-owner";
const OTHER = "profile:account:other-owner";

let checks = 0;
function check(name, fn) {
  fn();
  checks += 1;
  console.log(`ok - ${name}`);
}
function throwsCode(fn, code) {
  let error = null;
  try { fn(); } catch (err) { error = err; }
  assert.ok(error, `expected ${code}`);
  assert.equal(error.code, code);
  return error;
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agent-repository-"));
const store = new MessageStore(path.join(tmp, "messages.db"), path.join(tmp, "blobs"));
const repo = store.agents();
assert.ok(repo instanceof AgentRepository, "MessageStore.agents() hands out the repository");

try {
  let created;
  check("createAgent validates and stores revision 1 with provenance", () => {
    created = repo.createAgent({
      ownerScope: OWNER,
      definition: { name: "合同审查助手", description: "审合同", skills: { required: ["lily-document-query"] } },
      source: { kind: "created" },
    });
    assert.equal(created.revision.revisionNumber, 1);
    assert.equal(created.entity.currentRevisionId, created.revision.id);
    assert.equal(created.revision.source.kind, "created");
    assert.deepEqual(created.revision.definition.skills, { required: ["lily-document-query"], enabled: ["lily-document-query"] });
    assert.equal(created.entity.officialId, null);
    throwsCode(() => repo.createAgent({ ownerScope: OWNER, definition: { name: "" }, source: { kind: "created" } }), "AGENT_DEFINITION_INVALID");
    throwsCode(() => repo.createAgent({ ownerScope: OWNER, definition: { name: "x" }, source: {} }), "AGENT_SOURCE_INVALID");
  });

  check("owner scope isolates library reads", () => {
    assert.equal(repo.listAgents(OWNER).length, 1);
    assert.equal(repo.listAgents(OTHER).length, 0);
    assert.equal(repo.getAgent(OTHER, created.entity.id), null);
    assert.equal(repo.getRevision(OTHER, created.revision.id), null);
  });

  check("createRevision is CAS-guarded, idempotent on same content, immutable rows", () => {
    throwsCode(() => repo.createRevision({
      ownerScope: OWNER, agentId: created.entity.id, expectedBaseRevisionId: "stale", definition: { name: "合同审查助手 v2" }, source: { kind: "edited" },
    }), "AGENT_REVISION_CONFLICT");
    const same = repo.createRevision({
      ownerScope: OWNER, agentId: created.entity.id, expectedBaseRevisionId: created.revision.id,
      definition: created.revision.definition, source: { kind: "created" },
    });
    assert.equal(same.unchanged, true);
    assert.equal(same.revision.id, created.revision.id);
    const revised = repo.createRevision({
      ownerScope: OWNER, agentId: created.entity.id, expectedBaseRevisionId: created.revision.id,
      definition: { ...created.revision.definition, description: "审合同并出批注版" }, source: { kind: "edited" },
    });
    assert.equal(revised.revision.revisionNumber, 2);
    assert.equal(revised.revision.parentRevisionId, created.revision.id);
    assert.equal(repo.getAgent(OWNER, created.entity.id).currentRevisionId, revised.revision.id);
    assert.equal(repo.listRevisions(OWNER, created.entity.id).length, 2);
    assert.throws(() => repo.db.run("UPDATE agent_revisions SET display_name = 'x' WHERE id = ?", created.revision.id), /immutable/);
    assert.throws(() => repo.db.run("DELETE FROM agent_revisions WHERE id = ?", created.revision.id), /immutable/);
    throwsCode(() => repo.createRevision({ ownerScope: OWNER, agentId: "missing", definition: { name: "x" }, source: { kind: "edited" } }), "AGENT_NOT_FOUND");
  });

  check("official install is unique per owner and findable by official id", () => {
    const official = repo.createAgent({
      ownerScope: OWNER, definition: { name: "法律顾问" }, officialId: "lily-agent-cn-legal-counsel",
      source: { kind: "official", officialId: "lily-agent-cn-legal-counsel", officialVersion: 1, officialLocale: "zh-CN" },
    });
    assert.equal(repo.findByOfficialId(OWNER, "lily-agent-cn-legal-counsel").id, official.entity.id);
    assert.equal(repo.findByOfficialId(OTHER, "lily-agent-cn-legal-counsel"), null);
    throwsCode(() => repo.createAgent({
      ownerScope: OWNER, definition: { name: "法律顾问" }, officialId: "lily-agent-cn-legal-counsel", source: { kind: "official" },
    }), "AGENT_OFFICIAL_EXISTS");
  });

  check("archive hides from default list, restore brings it back, archived refuses revisions", () => {
    const archived = repo.archiveAgent(OWNER, created.entity.id);
    assert.ok(archived.archivedAt);
    assert.equal(repo.listAgents(OWNER).some((item) => item.id === created.entity.id), false);
    assert.equal(repo.listAgents(OWNER, { includeArchived: true }).some((item) => item.id === created.entity.id), true);
    throwsCode(() => repo.createRevision({ ownerScope: OWNER, agentId: created.entity.id, definition: { name: "y" }, source: { kind: "edited" } }), "AGENT_ARCHIVED");
    assert.equal(repo.restoreAgent(OWNER, created.entity.id).archivedAt, null);
  });

  check("session binding starts empty, activates with CAS, records receipt + previous, logs events", () => {
    const empty = repo.getBinding("session-1", OWNER);
    assert.deepEqual({ v: empty.bindingVersion, a: empty.agentRevisionId }, { v: 0, a: null });
    const current = repo.getCurrentRevision(OWNER, created.entity.id);
    throwsCode(() => repo.setBinding({ sessionId: "session-1", ownerScope: OWNER, expectedBindingVersion: 3, agentRevisionId: current.id }), "AGENT_BINDING_CONFLICT");
    throwsCode(() => repo.setBinding({ sessionId: "session-1", ownerScope: OWNER, expectedBindingVersion: 0, agentRevisionId: "nope" }), "AGENT_REVISION_NOT_FOUND");
    const bound = repo.setBinding({
      sessionId: "session-1", ownerScope: OWNER, expectedBindingVersion: 0, agentRevisionId: current.id,
      receipt: { role: { status: "applied" } }, previous: { enabledSkillIds: null, permissionModeId: null },
    });
    assert.equal(bound.bindingVersion, 1);
    assert.equal(bound.agentId, created.entity.id);
    assert.equal(bound.displayName, "合同审查助手");
    assert.deepEqual(bound.receipt, { role: { status: "applied" } });
    assert.deepEqual(bound.previous, { enabledSkillIds: null, permissionModeId: null });
    assert.equal(repo.countBindingsForAgent(OWNER, created.entity.id), 1);
    throwsCode(() => repo.getBinding("session-1", OTHER), "AGENT_BINDING_OWNER_MISMATCH");
    const cleared = repo.setBinding({ sessionId: "session-1", ownerScope: OWNER, expectedBindingVersion: 1, agentRevisionId: null });
    assert.equal(cleared.bindingVersion, 2);
    assert.equal(cleared.agentRevisionId, null);
    assert.equal(repo.countBindingsForAgent(OWNER, created.entity.id), 0);
    const events = repo.getBindingEvents("session-1", OWNER);
    assert.deepEqual(events.map((event) => event.type), ["agent_binding.activated", "agent_binding.cleared"]);
    assert.throws(() => repo.db.run("DELETE FROM agent_binding_events WHERE session_id = 'session-1'"), /append-only/);
  });

  check("lily-agent file import recreates an embedded role card through the character pipeline", () => {
    const characterRepo = store.characterWorlds();
    const file = {
      kind: "lily-agent",
      schemaVersion: 1,
      definition: { name: "导入的助手", skills: { enabled: ["anthropics-docx"] }, role: null },
      roleCard: { canonical: { name: "导入角色", description: "一个导入的角色", personality: "稳", scenario: "工作" } },
    };
    const result = importAgentFile({ repo, owner: OWNER, characterRepo, file, importedFrom: "x.lily-agent.json" });
    assert.equal(result.roleImported, true);
    assert.equal(result.revision.source.kind, "imported");
    assert.equal(result.revision.source.importedFrom, "x.lily-agent.json");
    const entityId = result.revision.definition.role.characterEntityId;
    const character = characterRepo.getCharacter(OWNER, entityId);
    assert.ok(character, "role card became a local character entity");
    assert.equal(characterRepo.getRevision(OWNER, character.currentRevisionId).canonical.name, "导入角色");
    // A malformed file fails coded before any storage write.
    const before = repo.listAgents(OWNER).length;
    throwsCode(() => importAgentFile({ repo, owner: OWNER, characterRepo, file: { kind: "lily-agent", definition: { name: "" } } }), "AGENT_DEFINITION_INVALID");
    assert.equal(repo.listAgents(OWNER).length, before);
  });

  console.log(`\n${checks} checks passed (agent repository)`);
} finally {
  store.close?.();
  fs.rmSync(tmp, { recursive: true, force: true });
}
