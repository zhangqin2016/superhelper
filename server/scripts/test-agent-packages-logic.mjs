#!/usr/bin/env node
// Pure-logic tests for agent distribution (no Postgres):
//   1. validator parity with the desktop client (same output, same codes/fields)
//   2. publish quality gate
//   3. resolveAgentSelection fail-open contract (CAPABILITY-GATE: absent block ⇒ identical config)
//   4. registry builder shape + signing hook
//   5. route registration + coded HTTP rejections via Fastify inject (validation
//      paths that never reach the database; no audit row on a rejected publish)
// Run: cd server && npm run test:agent-packages
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import * as serverDef from "../src/services/agent-definition.js";
import {
  agentPackageErrorResponse,
  buildAgentRegistry,
  evaluateAgentPackageQuality,
  normalizeAgentPackageInput,
  normalizeAgentPackagePatch,
  normalizeRoleCard,
  resolveAgentSelection,
} from "../src/services/agent-packages.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const clientValidatorPath = path.resolve(here, "../../src/main/agents/agent-definition.js");

function fullDefinition() {
  return {
    schemaVersion: 1,
    name: "  合同审查助手 ",
    description: "审查合同风险条款，输出修改建议。",
    icon: "📄",
    tags: ["legal", "legal", "contracts"],
    role: { officialCharacterId: "legal-counsel" },
    starters: ["帮我审这份合同", "列出高风险条款"],
    skills: { required: ["Lily-Contract-Review"], enabled: ["lily-office-docs"] },
    knowledge: { packs: ["legal-cn-2026"], guidance: "优先引用条款原文。" },
    model: { presetId: "deepseek-v4-pro" },
    tools: { mcpAllow: ["lily_legal_search"], connectors: [], disallow: ["Bash"] },
    autonomy: { permissionModeId: "ask" },
    automations: [{ title: "周报", prompt: "汇总本周合同审查结论", schedule: { type: "weekly", day: 5 }, scheduleText: "每周五" }],
  };
}

function codeOf(fn) {
  try {
    fn();
  } catch (error) {
    return { code: error.code, field: error.field };
  }
  return null;
}

// --- 1. validator parity ---------------------------------------------------------

{
  const normalized = serverDef.normalizeAgentDefinition(fullDefinition());
  assert.equal(normalized.name, "合同审查助手");
  assert.deepEqual(normalized.tags, ["legal", "contracts"]);
  assert.deepEqual(normalized.skills, { required: ["lily-contract-review"], enabled: ["lily-office-docs", "lily-contract-review"] });
  assert.deepEqual(serverDef.activeDimensions(normalized), ["role", "skills", "knowledge", "autonomy", "model", "tools", "automations"]);
  assert.equal(serverDef.hasColdDimensions(normalized), true);
  assert.equal(serverDef.normalizeAgentDefinition({ name: "x", model: { presetId: "inherit" } }).model.presetId, "");

  const invalidCases = [
    ["missing name", () => ({}), "AGENT_DEFINITION_INVALID", "name"],
    ["two role refs", () => ({ name: "x", role: { officialCharacterId: "a", characterEntityId: "b" } }), "AGENT_DEFINITION_INVALID", "role"],
    ["bad skill id", () => ({ name: "x", skills: { enabled: ["Not A Skill"] } }), "AGENT_DEFINITION_INVALID", "skills.enabled"],
    ["automation without schedule.type", () => ({ name: "x", automations: [{ prompt: "p", schedule: {} }] }), "AGENT_DEFINITION_INVALID", "automations[0].schedule.type"],
    ["unsupported schemaVersion", () => ({ schemaVersion: 2, name: "x" }), "AGENT_DEFINITION_INVALID", "schemaVersion"],
    ["unknown autonomy", () => ({ name: "x", autonomy: { permissionModeId: "yolo" } }), "AGENT_DEFINITION_INVALID", "autonomy.permissionModeId"],
    ["too many starters", () => ({ name: "x", starters: Array.from({ length: 9 }, (_, i) => `s${i}`) }), "AGENT_DEFINITION_INVALID", "starters"],
    ["dangerous key", () => (JSON.parse('{"name":"x","__proto__":{"polluted":true}}')), "AGENT_DEFINITION_INVALID", "definition"],
    [
      "oversized via uncapped schedule blob",
      () => ({ name: "x", automations: [{ prompt: "p", schedule: { type: "cron", blob: "a".repeat(300 * 1024) } }] }),
      "AGENT_DEFINITION_TOO_LARGE",
      undefined,
    ],
  ];
  for (const [label, makeInput, code, field] of invalidCases) {
    const got = codeOf(() => serverDef.normalizeAgentDefinition(makeInput()));
    assert.ok(got, `${label}: expected a throw`);
    assert.equal(got.code, code, `${label}: code`);
    assert.equal(got.field, field, `${label}: field`);
  }

  if (fs.existsSync(clientValidatorPath)) {
    const clientDef = createRequire(import.meta.url)(clientValidatorPath);
    const fromClient = clientDef.normalizeAgentDefinition(fullDefinition());
    assert.deepEqual(normalized, fromClient, "server and client must normalize identically");
    assert.equal(serverDef.agentDefinitionHash(normalized), clientDef.agentDefinitionHash(fromClient), "hash parity");
    for (const [label, makeInput, code, field] of invalidCases) {
      const got = codeOf(() => clientDef.normalizeAgentDefinition(makeInput()));
      assert.ok(got, `${label}: client throws too`);
      assert.equal(got.code, code, `${label}: client code parity`);
      assert.equal(got.field, field, `${label}: client field parity`);
    }
    console.log("agent-definition parity: ok (server == client on", invalidCases.length + 1, "cases)");
  } else {
    console.log(`agent-definition parity: SKIPPED — client validator not found at ${clientValidatorPath}`);
  }
}

// --- 2. envelope + role card + quality gate -----------------------------------------

{
  const input = normalizeAgentPackageInput({ agentId: "legal.counsel", version: "1.0.0", channel: "Stable", definition: fullDefinition() });
  assert.equal(input.channel, "stable");
  assert.equal(input.scopeType, "global");
  assert.equal(input.organizationId, null);
  assert.equal(input.enabled, true);
  assert.equal(input.publisher, "Lily Workbench");
  assert.deepEqual(evaluateAgentPackageQuality(input), { ok: true, issues: [] });

  const pinned = normalizeAgentPackageInput(
    { agentId: "a1", version: "2", scopeType: "global", organizationId: "org_other", definition: { name: "x", skills: { enabled: ["lily-x"] }, description: "d" } },
    { scopeType: "organization", organizationId: "org_abc" },
  );
  assert.equal(pinned.scopeType, "organization", "URL scope pins over body");
  assert.equal(pinned.organizationId, "org_abc");

  assert.deepEqual(codeOf(() => normalizeAgentPackageInput({ agentId: "a", version: "1", scopeType: "global", organizationId: "org_x", definition: { name: "x" } })), { code: "AGENT_PACKAGE_INVALID", field: "organizationId" });
  assert.deepEqual(codeOf(() => normalizeAgentPackageInput({ agentId: "a", version: "1", scopeType: "organization", definition: { name: "x" } })), { code: "AGENT_PACKAGE_INVALID", field: "organizationId" });
  assert.deepEqual(codeOf(() => normalizeAgentPackageInput({ agentId: "bad id", version: "1", definition: { name: "x" } })), { code: "AGENT_PACKAGE_INVALID", field: "agentId" });
  assert.deepEqual(codeOf(() => normalizeAgentPackageInput({ agentId: "a", version: "1", channel: "Bad Channel", definition: { name: "x" } })), { code: "AGENT_PACKAGE_INVALID", field: "channel" });
  assert.deepEqual(codeOf(() => normalizeAgentPackageInput({ agentId: "a", version: "1", definition: {} })), { code: "AGENT_DEFINITION_INVALID", field: "name" }, "definition errors bubble with the validator's code");

  assert.equal(normalizeRoleCard(null), null);
  assert.deepEqual(normalizeRoleCard({ canonical: { name: "Counsel", voice: "calm" } }), { canonical: { name: "Counsel", voice: "calm" } });
  assert.equal(codeOf(() => normalizeRoleCard({ name: "no canonical" }))?.code, "AGENT_ROLE_CARD_INVALID");
  assert.equal(codeOf(() => normalizeRoleCard({ canonical: { blob: "a".repeat(1024 * 1024 + 1) } }))?.code, "AGENT_ROLE_CARD_TOO_LARGE");

  const issueCodes = (input) => evaluateAgentPackageQuality(input).issues.map((issue) => `${issue.field}:${issue.code}`);
  const base = (definition, roleCard = null) => ({ ...normalizeAgentPackageInput({ agentId: "a", version: "1", definition }), roleCard: roleCard ? normalizeRoleCard(roleCard) : null });

  assert.deepEqual(issueCodes(base({ name: "x", skills: { enabled: ["lily-x"] } })), ["description:DESCRIPTION_REQUIRED"]);
  assert.deepEqual(issueCodes(base({ name: "x", description: "d" })), ["definition:NO_DIMENSIONS"]);
  assert.deepEqual(issueCodes(base({ name: "x", description: "d" }, { canonical: { name: "Role" } })), [], "an embedded roleCard counts as the role dimension");
  assert.deepEqual(issueCodes(base({ name: "x", description: "d", role: { characterEntityId: "local-1" } })), ["role:LOCAL_ROLE_REFERENCE"]);
  assert.deepEqual(issueCodes(base({ name: "x", description: "d", role: { characterRevisionId: "rev-1" } })), ["role:LOCAL_ROLE_REFERENCE"]);
  assert.deepEqual(issueCodes(base({ name: "x", description: "d", role: { officialCharacterId: "legal" } })), []);
  assert.deepEqual(issueCodes(base({ name: "x", description: "d", role: { officialCharacterId: "legal" } }, { canonical: { name: "Role" } })), ["role:ROLE_AMBIGUOUS"]);
  assert.deepEqual(evaluateAgentPackageQuality({}).issues.map((i) => i.code), ["DEFINITION_REQUIRED"]);

  assert.deepEqual(normalizeAgentPackagePatch({ enabled: "false", featured: true }), { enabled: false, featured: true });
  assert.equal(codeOf(() => normalizeAgentPackagePatch({}))?.code, "AGENT_PACKAGE_INVALID");

  assert.deepEqual(agentPackageErrorResponse(serverDef.codedError("AGENT_DEFINITION_INVALID", "bad", { field: "name" })), {
    statusCode: 400,
    body: { ok: false, code: "AGENT_DEFINITION_INVALID", message: "bad", field: "name" },
  });
  assert.equal(agentPackageErrorResponse(serverDef.codedError("AGENT_PACKAGE_CONFLICT", "dup")).statusCode, 409);
  assert.equal(agentPackageErrorResponse(serverDef.codedError("AGENT_DEFINITION_TOO_LARGE", "big")).statusCode, 413);
  assert.equal(agentPackageErrorResponse(new Error("boom")), null, "unknown errors are rethrown by the routes");
  console.log("agent-package envelope + quality gate: ok");
}

// --- 3. resolveAgentSelection (fail-open) ---------------------------------------------

{
  const untouched = { schemaVersion: 1, models: { presets: [] }, tools: { enabledPluginIds: [] } };
  assert.equal(resolveAgentSelection(untouched, ["a", "b"]), untouched, "no agents block ⇒ the very same object back (byte-identical output)");
  assert.equal(resolveAgentSelection(untouched, undefined), untouched);
  assert.equal(resolveAgentSelection(null, ["a"]), null);
  assert.deepEqual(resolveAgentSelection({ agents: "nonsense" }, ["a"]), { agents: "nonsense" }, "non-object block is left alone");

  const profile = { schemaVersion: 1, agents: { available: ["legal", "sales", "ghost"], default: "sales", note: "keep me" } };
  const frozen = JSON.stringify(profile);
  const resolved = resolveAgentSelection(profile, ["legal", "sales", "hr"]);
  assert.deepEqual(resolved.agents, { available: ["legal", "sales"], default: "sales", note: "keep me" });
  assert.equal(JSON.stringify(profile), frozen, "input is never mutated");

  const dropped = resolveAgentSelection({ agents: { available: ["legal", "sales"], default: "ghost" } }, ["legal", "sales"]);
  assert.deepEqual(dropped.agents, { available: ["legal", "sales"] }, "default outside available is dropped, not invented");

  const emptied = resolveAgentSelection({ schemaVersion: 1, agents: { available: ["ghost"], default: "ghost" } }, ["legal"]);
  assert.deepEqual(emptied, { schemaVersion: 1 }, "empty intersection removes the block ⇒ old behavior");
  assert.deepEqual(resolveAgentSelection({ agents: { available: ["legal"] } }, []), {}, "nothing published ⇒ old behavior");
  assert.deepEqual(resolveAgentSelection({ agents: { default: "legal" } }, ["legal"]), {}, "default without available is not an allow-list");
  console.log("resolveAgentSelection fail-open: ok");
}

// --- 4. registry builder -----------------------------------------------------------------

{
  const definition = serverDef.normalizeAgentDefinition({ name: "Legal", description: "d", skills: { enabled: ["lily-x"] } });
  const row = (over) => ({
    id: "agentpkg_x", agent_id: "legal", version: "1.0.0", channel: "stable", scope_type: "global", organization_id: null,
    enabled: true, featured: false, display_in_catalog: true, publisher: "Lily Workbench", definition, role_card: null,
    min_app_version: null, created_at: "2026-09-14T00:00:00.000Z", updated_at: "2026-09-14T00:00:00.000Z", ...over,
  });
  const rows = [
    row({ id: "p-old", version: "1.0.0" }),
    row({ id: "p-new", version: "1.2.0", featured: true }),
    row({ id: "p-disabled", version: "9.9.9", enabled: false }),
    row({ id: "p-org", version: "0.1.0", scope_type: "organization", organization_id: "org_abc", role_card: { canonical: { name: "House counsel" } } }),
    row({ id: "p-other", agent_id: "sales", version: "1.0.0", definition: JSON.stringify(definition) }),
  ];
  const signed = [];
  const registry = buildAgentRegistry(rows, {
    channel: "stable",
    registryUrl: "https://lilych.lilywb.cn/api/agents/registry",
    signer: (payload) => {
      signed.push(payload);
      return "sig";
    },
  });
  assert.equal(registry.schemaVersion, 1);
  assert.equal(registry.channel, "stable");
  assert.ok(Date.parse(registry.generatedAt) > 0);
  assert.equal(registry.signature, "sig");
  assert.equal(signed.length, 1);
  assert.equal("signature" in signed[0], false, "signer sees the payload without a signature field");
  assert.deepEqual(signed[0].agents, registry.agents);

  const ids = registry.agents.map((entry) => entry.packageId).sort();
  assert.deepEqual(ids, ["p-new", "p-org", "p-other"], "newest enabled per (agent, scope); disabled rows never appear");
  const newest = registry.agents.find((entry) => entry.packageId === "p-new");
  assert.deepEqual(Object.keys(newest).sort(), ["agentId", "channel", "definition", "displayInCatalog", "featured", "minAppVersion", "packageId", "publisher", "scope", "updatedAt", "version"]);
  assert.deepEqual(newest.scope, { type: "global" });
  assert.equal(newest.featured, true);
  const org = registry.agents.find((entry) => entry.packageId === "p-org");
  assert.deepEqual(org.scope, { type: "organization", organizationId: "org_abc" });
  assert.deepEqual(org.roleCard, { canonical: { name: "House counsel" } });
  const other = registry.agents.find((entry) => entry.packageId === "p-other");
  assert.deepEqual(other.definition, definition, "jsonb strings are parsed");

  assert.equal("signature" in buildAgentRegistry(rows, { channel: "stable" }), false, "no signer ⇒ no signature field");
  console.log("agent registry builder: ok");
}

// --- 5. routes: registration + coded rejections before any DB access ---------------

{
  // db.js insists on DATABASE_URL at import time; the pool is lazy, and every
  // request below is rejected by validation before a query is issued.
  process.env.DATABASE_URL ||= "postgres://lily:lily@127.0.0.1:1/lily_unreachable";
  let Fastify;
  let cookie;
  try {
    Fastify = (await import("fastify")).default;
    cookie = (await import("@fastify/cookie")).default;
  } catch {
    Fastify = null;
  }
  if (!Fastify) {
    console.log("agent routes: SKIPPED — fastify not installed under server/");
  } else {
    const { installDocOnlyCompilers } = await import("../src/openapi.js");
    const { registerAdminAgentPackageRoutes } = await import("../src/routes/admin/agent-packages.js");
    const { registerPublicEnterpriseAgentRoutes } = await import("../src/routes/public/enterprise-agents.js");
    const { registerPublicAgentRoutes } = await import("../src/routes/public/agents.js");

    const app = Fastify({ logger: false });
    installDocOnlyCompilers(app);
    await app.register(cookie, { secret: "test-secret" });
    const audits = [];
    registerAdminAgentPackageRoutes(app, { audit: async (_request, action, targetType, targetId, metadata) => audits.push({ action, targetType, targetId, metadata }) });
    registerPublicEnterpriseAgentRoutes(app);
    registerPublicAgentRoutes(app);
    await app.ready();

    const expectedRoutes = [
      ["GET", "/api/admin/agent-packages"],
      ["GET", "/api/admin/agent-packages/:id"],
      ["POST", "/api/admin/agent-packages"],
      ["PATCH", "/api/admin/agent-packages/:id"],
      ["DELETE", "/api/admin/agent-packages/:id"],
      ["GET", "/api/enterprise/organizations/:id/agents"],
      ["POST", "/api/enterprise/organizations/:id/agents"],
      ["PATCH", "/api/enterprise/organizations/:id/agents/:packageId"],
      ["GET", "/api/agents/registry"],
    ];
    for (const [method, url] of expectedRoutes) assert.ok(app.hasRoute({ method, url }), `route registered: ${method} ${url}`);

    const post = (payload) => app.inject({ method: "POST", url: "/api/admin/agent-packages", payload });

    let response = await post({ agentId: "legal", version: "1.0.0", definition: {} });
    assert.equal(response.statusCode, 400);
    assert.deepEqual({ code: response.json().code, field: response.json().field }, { code: "AGENT_DEFINITION_INVALID", field: "name" });

    response = await post({ agentId: "legal", version: "1.0.0", definition: { name: "x", description: "d", role: { characterEntityId: "local-1" } } });
    assert.equal(response.statusCode, 400);
    assert.equal(response.json().code, "AGENT_QUALITY_GATE_FAILED");
    assert.deepEqual(response.json().issues.map((issue) => `${issue.field}:${issue.code}`), ["role:LOCAL_ROLE_REFERENCE"]);

    response = await post({ agentId: "legal", version: "1.0.0", scopeType: "organization", definition: { name: "x", description: "d", skills: { enabled: ["lily-x"] } } });
    assert.equal(response.statusCode, 400);
    assert.deepEqual({ code: response.json().code, field: response.json().field }, { code: "AGENT_PACKAGE_INVALID", field: "organizationId" });

    response = await post({ agentId: "legal", version: "1.0.0", definition: { name: "x", automations: [{ prompt: "p", schedule: { type: "cron", blob: "a".repeat(300 * 1024) } }] } });
    assert.equal(response.statusCode, 413);
    assert.equal(response.json().code, "AGENT_DEFINITION_TOO_LARGE");

    response = await app.inject({ method: "PATCH", url: "/api/admin/agent-packages/agentpkg_x", payload: {} });
    assert.equal(response.statusCode, 400);
    assert.equal(response.json().code, "AGENT_PACKAGE_INVALID");

    assert.equal(audits.length, 0, "rejected publishes never write an audit row");
    await app.close();
    console.log("agent routes: ok (", expectedRoutes.length, "routes registered; coded rejections verified over HTTP)");
  }
}

console.log("test-agent-packages-logic: all ok");
