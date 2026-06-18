#!/usr/bin/env node
/**
 * End-to-end: authoritative published contracts must (1) reach the persisted
 * skill ("学到了要存下来") and (2) arrive in a form the runtime AI can actually
 * operate from — api-first execution, enum-typed params, and a real result
 * schema ("用的时候 AI 要用得明白"). Runs the generator with --contracts and
 * asserts the chain through to the on-disk skill files.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = path.resolve(new URL("..", import.meta.url).pathname);
const script = path.join(ROOT, "resources/skills-catalog/lily-web-system-learning/scripts/create_web_system_skill.cjs");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lily-contract-int-"));
const specPath = path.join(tmp, "spec.json");
const contractsPath = path.join(tmp, "api-contracts.json");
const outDir = path.join(tmp, "out");

fs.writeFileSync(specPath, JSON.stringify({
  id: "demo-erp",
  name: "Demo ERP",
  systemName: "Demo ERP",
  baseUrl: "https://erp.example.com/home",
  allowedDomains: ["example.com"],
  summary: "Demo ERP leave management.",
  actions: [
    { id: "query-leaves", name: "Query leaves", intentExamples: ["查请假"], risk: "read", confirmation: "none", entry: "Leaves", steps: ["Open leaves.", "Return list."] },
    { id: "submit-leave", name: "Submit leave", intentExamples: ["提交请假"], risk: "submit", confirmation: "explicit", steps: ["Open form.", "Confirm before submit."] },
  ],
}, null, 2));

// Shape mirrors discover_contracts.cjs output.
fs.writeFileSync(contractsPath, JSON.stringify({
  ok: true,
  schemaVersion: 1,
  baseUrl: "https://erp.example.com",
  allowedDomains: ["example.com"],
  sources: [{ kind: "openapi3", url: "https://erp.example.com/openapi.json", title: "Demo ERP", version: "1.0", endpointCount: 2 }],
  contracts: [
    {
      id: "list-leaves", source: "openapi", authoritative: true,
      endpoint: "https://erp.example.com/api/leaves", method: "GET", risk: "read",
      operationId: "listLeaves", contentType: "query",
      requestFields: [{ name: "status", in: "query", type: "string", required: false, enum: ["open", "closed"] }],
      responseSchema: { type: "array", items: { $ref: "Leave" } },
      responseShape: [{ days: "<integer>" }],
    },
    {
      id: "create-leave", source: "openapi", authoritative: true,
      endpoint: "https://erp.example.com/api/leaves", method: "POST", risk: "submit",
      operationId: "createLeave", contentType: "json",
      requestFields: [{ name: "days", in: "body", type: "integer", required: true }],
      requestSchema: { type: "object", required: ["days"], properties: { days: { type: "integer" } } },
    },
  ],
  dataSchemas: { Leave: { type: "object", properties: { days: { type: "integer" } } } },
  coverage: { endpointCount: 2, writeEndpoints: 1 },
}, null, 2));

const result = spawnSync(process.execPath, [script, "--spec", specPath, "--contracts", contractsPath, "--out", outDir], { cwd: ROOT, encoding: "utf8" });
if (result.status !== 0) throw new Error(`generator failed: ${result.stderr || result.stdout}`);

const summary = JSON.parse(result.stdout);
const draftDir = path.join(outDir, "demo-erp");
const readJson = (name) => JSON.parse(fs.readFileSync(path.join(draftDir, name), "utf8"));

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

try {
  // (1) learned → persisted
  assert(summary.authoritativeContracts === 2, `expected 2 authoritative contracts, got ${summary.authoritativeContracts}`);
  assert(fs.existsSync(path.join(draftDir, "api-contracts.json")), "api-contracts.json must be persisted verbatim");
  assert(fs.existsSync(path.join(draftDir, "scripts/discover_contracts.cjs")), "discover_contracts.cjs must ship with the skill");
  const persisted = readJson("api-contracts.json");
  assert(persisted.contracts.length === 2 && persisted.dataSchemas.Leave, "persisted contracts + data schemas intact");

  // api-map carries authoritative schemas + reusable data schemas
  const apiMap = readJson("api-map.json");
  const get = apiMap.contracts.find((c) => c.id === "list-leaves");
  assert(get && get.authoritative === true, "api-map marks authoritative contract");
  assert(get.responseSchema, "api-map keeps response schema");
  assert(apiMap.dataSchemas.Leave, "api-map carries reusable data schemas");
  assert(Array.isArray(apiMap.sources) && apiMap.sources.length === 1, "api-map records contract provenance");

  // (2) AI can operate: api-first + enum params + real result schema
  const playbook = readJson("web-system-playbook.json");
  const readAction = playbook.actions.find((a) => a.action === "web.query-leaves");
  assert(readAction.metadata.executionStrategy.preferred === "api-first", "read action is api-first when a contract exists");
  assert(readAction.metadata.apiContractRefs.includes("list-leaves"), "read action references the GET contract");
  assert(readAction.resultSchema && readAction.resultSchema.schema, "read action gets a real result schema (parseable results)");
  const statusParam = readAction.paramsSchema.properties.status;
  assert(statusParam && statusParam.type === "enum", "enum param typed from contract");
  assert(statusParam.options.length === 2, "enum options carried from contract enum");

  const writeAction = playbook.actions.find((a) => a.action === "web.submit-leave");
  assert(writeAction.paramsSchema.required.includes("days"), "required write param captured from contract requestSchema");

  // health reflects api-first coverage
  const health = readJson("health.json");
  assert(health.coverage.apiContractCount === 2, "health counts authoritative contracts");

  console.log("PASS: test-web-system-contract-integration (15 tests)");
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
