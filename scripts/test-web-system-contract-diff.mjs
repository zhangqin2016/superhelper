#!/usr/bin/env node
/**
 * Contract drift detection: a re-learn must surface added/removed/changed
 * endpoints + data schemas, and flag breaking changes (removed endpoints,
 * risk escalation, dropped required fields) so dependent capabilities get
 * re-verified instead of silently rotting.
 */
import module from "node:module";
import { assert } from "./lib/test-assert.mjs";

const require = module.createRequire(import.meta.url);
const { diffContracts, contractKey } = require("../resources/skills-catalog/lily-web-system-learning/scripts/diff_contracts.cjs");

try {
  const oldDoc = {
    contracts: [
      { id: "list-leaves", method: "GET", endpoint: "https://erp.example.com/api/leaves", risk: "read", requestFields: [{ in: "query", name: "status" }], responseSchema: { type: "array" } },
      { id: "get-user", method: "GET", endpoint: "https://erp.example.com/api/user", risk: "read", requestFields: [] },
    ],
    dataSchemas: { Leave: { type: "object", properties: { days: { type: "integer" } } }, Old: { type: "object" } },
  };
  const newDoc = {
    contracts: [
      // unchanged endpoint, but response schema changed + a new field added
      { id: "list-leaves", method: "GET", endpoint: "https://erp.example.com/api/leaves", risk: "read", requestFields: [{ in: "query", name: "status" }, { in: "query", name: "team" }], responseSchema: { type: "object" } },
      // brand new endpoint
      { id: "create-leave", method: "POST", endpoint: "https://erp.example.com/api/leaves", risk: "submit", requestFields: [{ in: "body", name: "days" }] },
    ],
    dataSchemas: { Leave: { type: "object", properties: { days: { type: "integer" }, type: { type: "string" } } }, New: { type: "object" } },
  };

  const report = diffContracts(oldDoc, newDoc);
  assert(report.drift === true, "drift detected");
  assert(report.summary.added === 1, "one added endpoint (POST /leaves)");
  assert(report.summary.removed === 1, "one removed endpoint (GET /user)");
  assert(report.summary.changed === 1, "one changed endpoint (GET /leaves)");

  assert(report.addedContracts[0].key === contractKey({ method: "POST", endpoint: "https://erp.example.com/api/leaves" }), "added keyed by method+endpoint");
  assert(report.removedContracts[0].id === "get-user", "removed endpoint identified");

  const changed = report.changedContracts.find((c) => c.id === "list-leaves");
  assert(changed, "changed endpoint reported");
  assert(changed.changes.some((c) => c.field === "requestFields.added" && c.values.includes("query:team")), "added request field detected");
  assert(changed.changes.some((c) => c.field === "responseSchema" && c.changed), "response schema change detected");

  // data schema drift
  assert(report.dataSchemaChanges.added.includes("New"), "new data schema detected");
  assert(report.dataSchemaChanges.removed.includes("Old"), "removed data schema detected");
  assert(report.dataSchemaChanges.changed.includes("Leave"), "changed data schema detected");

  // breaking = removed endpoints (+ risk/required-field regressions)
  assert(report.breaking.some((b) => b.id === "get-user"), "removed endpoint flagged breaking");

  // risk escalation is breaking
  const escalation = diffContracts(
    { contracts: [{ id: "x", method: "POST", endpoint: "https://erp.example.com/api/x", risk: "submit", requestFields: [] }] },
    { contracts: [{ id: "x", method: "POST", endpoint: "https://erp.example.com/api/x", risk: "destructive", requestFields: [] }] },
  );
  assert(escalation.breaking.some((b) => b.id === "x"), "risk escalation flagged breaking");

  // identical docs → no drift
  const same = diffContracts(oldDoc, oldDoc);
  assert(same.drift === false, "identical contracts → no drift");

  console.log("PASS: test-web-system-contract-diff (15 tests)");
} catch (err) {
  console.error("FAIL:", err.message);
  process.exit(1);
}
