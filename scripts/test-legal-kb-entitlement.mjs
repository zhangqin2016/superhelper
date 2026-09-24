#!/usr/bin/env node
/**
 * An installed legal pack is used by entitlement, not by connectivity.
 *
 * Making a pack "usable once installed" (so a network blip no longer fails the
 * legal role) briefly let a revoked or expired entitlement keep using it — the
 * server checks the device's plan on every resolve and answers 403
 * NOT_ENTITLED, and nothing on the client remembered that answer. Now the
 * server's last AUTHORITATIVE answer decides, for turns and the search tool
 * alike; an unreachable server changes nothing; offline use is bounded by the
 * licence's own end (`entitledUntil`).
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import JSZip from "jszip";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { installLegalKnowledgePack, readLegalKnowledgePackState } = require("../src/main/legal-kb/legal-kb-installer.js");
const manager = require("../src/main/legal-kb/legal-kb-manager.js");
const { entitlementAllows, verdictFromResolve } = require("../src/main/legal-kb/legal-kb-entitlement.js");
let checks = 0;
const check = (label) => { checks += 1; console.log(`ok - ${label}`); };

const root = fs.mkdtempSync(path.join(os.tmpdir(), "lily-legal-kb-entitlement-"));
const zip = new JSZip();
zip.file("manifest.json", JSON.stringify({ schemaVersion: 1, packId: "legal-cn-enterprise", contentVersion: "V23.3", articleCount: 1, documentCount: 1 }));
zip.file("catalog.json", "[]");
zip.file("articles.jsonl", `${JSON.stringify({ id: "a", title: "合同法", article: "第一条", text: "依法订立合同" })}\n`);
zip.file("lineage.json", JSON.stringify({ lineage: [] }));
const bytes = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
const artifact = { packId: "legal-cn-enterprise", characterId: "lily-cn-legal-counsel", version: "V23.3", url: "https://qny.example/V23.3.zip", sha256, sizeBytes: bytes.length, format: "zip", schemaVersion: 1 };
const downloadArtifact = async ({ partPath }) => { fs.mkdirSync(path.dirname(partPath), { recursive: true }); fs.writeFileSync(partPath, bytes); return { ok: true, path: partPath }; };
const resolveWith = (answer) => ({ legalKnowledgePackArtifact: async () => answer });
const granted = (until) => ({ ok: true, json: { artifact, ...(until ? { entitledUntil: new Date(until).toISOString() } : {}) } });
const install = (answer) => installLegalKnowledgePack({ rootDir: root, serviceClient: resolveWith(answer), downloadArtifact });

// ------------------------------------------------------------- the verdicts
{
  assert.equal(verdictFromResolve({ ok: false, error: "SERVICE_REQUEST_FAILED" }), null, "an unreachable server is not an answer");
  assert.equal(verdictFromResolve({ ok: false, error: "NOT_ENTITLED", status: 403 }).status, "denied");
  assert.equal(verdictFromResolve({ ok: false, error: "LEGAL_KB_NOT_FOUND", status: 404 }).status, "denied", "a withdrawn pack is an answer too");
  assert.equal(verdictFromResolve({ ok: false, error: "BAD_GATEWAY", status: 502 }), null, "a server error is not an answer about entitlement");
  assert.deepEqual(entitlementAllows(undefined), { allowed: true }, "a pack installed before verdicts were kept was installed under a grant");
  check("only 401/403/404 are answers about entitlement; outages and server errors are not");
}

// ------------------------------------------------------------ end to end
{
  const future = Date.now() + 30 * 86_400_000;
  assert.equal((await install(granted(future))).ok, true);
  assert.equal(manager.status(root).usable, true, "installed under a grant: usable");
  const found = await manager.search({ query: "合同" }, { rootDir: root });
  assert.equal(found.ok, true, "and the search tool reads it");

  const offline = await install({ ok: false, error: "SERVICE_REQUEST_FAILED" });
  assert.equal(offline.ok, false);
  assert.equal(manager.status(root).usable, true, "an unreachable server leaves the last answer standing");

  const refused = await install({ ok: false, error: "NOT_ENTITLED", status: 403 });
  assert.equal(refused.authoritative, true);
  assert.equal(manager.status(root).installed, true, "the files stay on disk");
  assert.equal(manager.status(root).usable, false, "but a refused entitlement disables them at once");
  const blocked = await manager.search({ query: "合同" }, { rootDir: root });
  assert.deepEqual([blocked.ok, blocked.error], [false, "NOT_ENTITLED"], "the search tool honours the refusal too — no side door");

  assert.equal((await install(granted(future))).ok, true);
  assert.equal(manager.status(root).usable, true, "a renewed grant restores it");
  check("a grant enables, a refusal disables at once for turns and the tool, an outage changes nothing");
}

{
  // Offline use lasts as long as the licence does.
  await install(granted(Date.now() + 1_000));
  const state = readLegalKnowledgePackState(root);
  assert.ok(Number.isFinite(state.entitlement.entitledUntil));
  assert.deepEqual(entitlementAllows(state.entitlement, Date.now()), { allowed: true });
  assert.deepEqual(entitlementAllows(state.entitlement, state.entitlement.entitledUntil + 1), { allowed: false, code: "ENTITLEMENT_EXPIRED" });
  check("offline use of an installed pack is bounded by the licence's own end");
}

// ------------------------------------------------- the turn still answers
{
  const { prepareLegalKnowledgeForTurn, knowledgeUnavailable, knowledgeWarmups } = require("../src/main/legal-kb/turn-preparation.js");
  const ctx = {
    legalKnowledgeManager: {
      status: () => ({ ok: true, installed: true, usable: false, unusableCode: "NOT_ENTITLED" }),
      ensureLegalKnowledgePack: async () => ({ ok: false, error: "NOT_ENTITLED" }),
    },
    sessionManager: { resolveTurnOwnerScope: () => ({ ok: false }) },
  };
  const agentPolicy = require("../src/main/agents/session-agent-policy.js");
  const original = agentPolicy.resolveSessionAgentPolicy;
  agentPolicy.resolveSessionAgentPolicy = () => ({ knowledgePacks: ["legal-cn-enterprise"] });
  const warn = console.warn; console.warn = () => {};
  try {
    const result = await prepareLegalKnowledgeForTurn({ ctx, session: { id: "s" }, state: {}, options: {}, log: { warn() {} } });
    assert.deepEqual([result.ready, result.error], [false, "KNOWLEDGE_PACK_NOT_ENTITLED"]);
    assert.match(knowledgeUnavailable(result).notice, /未获授权/, "the user is told it is an entitlement, not a network, problem");
    await knowledgeWarmups();
  } finally { agentPolicy.resolveSessionAgentPolicy = original; console.warn = warn; }
  check("a refused entitlement still never fails the turn, and says why");
}

fs.rmSync(root, { recursive: true, force: true });
console.log(`legal-kb-entitlement: ok (${checks} checks)`);
