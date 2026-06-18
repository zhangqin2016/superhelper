#!/usr/bin/env node
"use strict";

/**
 * Contract drift detection for re-learn / change management.
 *
 * A learned skill must not silently rot. When a system is re-learned, compare
 * the freshly discovered contracts against the persisted ones and report drift:
 * which endpoints/types were added, removed, or changed. Removed/changed
 * endpoints mean the capabilities that depend on them may be stale and should be
 * re-verified before reuse.
 *
 * Pure, deterministic, no network — operates on two api-contracts.json files.
 */

const fs = require("node:fs");
const path = require("node:path");

function contractKey(contract) {
  // Identity is the operation, not the generated id (ids can shift across runs).
  return `${String(contract.method || "GET").toUpperCase()} ${String(contract.endpoint || "")}`;
}

function indexContracts(doc) {
  const map = new Map();
  for (const contract of Array.isArray(doc?.contracts) ? doc.contracts : []) {
    if (!contract || !contract.endpoint) continue;
    map.set(contractKey(contract), contract);
  }
  return map;
}

function fieldSet(contract) {
  return new Set((Array.isArray(contract.requestFields) ? contract.requestFields : []).map((f) => `${f.in || "?"}:${f.name}`));
}

function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(",")}}`;
}

/** Field-level changes between two versions of the same operation. */
function contractChanges(oldC, newC) {
  const changes = [];
  if (String(oldC.risk || "") !== String(newC.risk || "")) {
    changes.push({ field: "risk", from: oldC.risk || "", to: newC.risk || "" });
  }
  const oldFields = fieldSet(oldC);
  const newFields = fieldSet(newC);
  const addedFields = [...newFields].filter((f) => !oldFields.has(f));
  const removedFields = [...oldFields].filter((f) => !newFields.has(f));
  if (addedFields.length) changes.push({ field: "requestFields.added", values: addedFields });
  if (removedFields.length) changes.push({ field: "requestFields.removed", values: removedFields });
  if (stableStringify(oldC.responseSchema || {}) !== stableStringify(newC.responseSchema || {})) {
    changes.push({ field: "responseSchema", changed: true });
  }
  return changes;
}

function diffSchemas(oldDoc, newDoc) {
  const oldSchemas = oldDoc?.dataSchemas && typeof oldDoc.dataSchemas === "object" ? oldDoc.dataSchemas : {};
  const newSchemas = newDoc?.dataSchemas && typeof newDoc.dataSchemas === "object" ? newDoc.dataSchemas : {};
  const oldNames = new Set(Object.keys(oldSchemas));
  const newNames = new Set(Object.keys(newSchemas));
  return {
    added: [...newNames].filter((n) => !oldNames.has(n)),
    removed: [...oldNames].filter((n) => !newNames.has(n)),
    changed: [...newNames].filter((n) => oldNames.has(n) && stableStringify(oldSchemas[n]) !== stableStringify(newSchemas[n])),
  };
}

function diffContracts(oldDoc, newDoc) {
  const oldMap = indexContracts(oldDoc);
  const newMap = indexContracts(newDoc);

  const addedContracts = [];
  const removedContracts = [];
  const changedContracts = [];

  for (const [key, newC] of newMap) {
    if (!oldMap.has(key)) {
      addedContracts.push({ id: newC.id, key, method: newC.method, endpoint: newC.endpoint, risk: newC.risk });
    } else {
      const changes = contractChanges(oldMap.get(key), newC);
      if (changes.length) changedContracts.push({ id: newC.id, key, changes });
    }
  }
  for (const [key, oldC] of oldMap) {
    if (!newMap.has(key)) {
      removedContracts.push({ id: oldC.id, key, method: oldC.method, endpoint: oldC.endpoint, risk: oldC.risk });
    }
  }

  const dataSchemaChanges = diffSchemas(oldDoc, newDoc);
  const drift =
    addedContracts.length > 0 ||
    removedContracts.length > 0 ||
    changedContracts.length > 0 ||
    dataSchemaChanges.added.length > 0 ||
    dataSchemaChanges.removed.length > 0 ||
    dataSchemaChanges.changed.length > 0;

  return {
    ok: true,
    schemaVersion: 1,
    drift,
    summary: {
      added: addedContracts.length,
      removed: removedContracts.length,
      changed: changedContracts.length,
      dataSchemasAdded: dataSchemaChanges.added.length,
      dataSchemasRemoved: dataSchemaChanges.removed.length,
      dataSchemasChanged: dataSchemaChanges.changed.length,
    },
    // Capabilities bound to these need re-verification before reuse.
    breaking: removedContracts.concat(changedContracts.filter((c) => c.changes.some((ch) => ch.field === "risk" || ch.field === "requestFields.removed"))),
    addedContracts,
    removedContracts,
    changedContracts,
    dataSchemaChanges,
  };
}

function parseArgs(argv) {
  const args = { old: null, new: null, out: null };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--old" || arg === "--baseline") args.old = argv[++i];
    else if (arg === "--new" || arg === "--current") args.new = argv[++i];
    else if (arg === "--out") args.out = argv[++i];
    else if (arg === "--help" || arg === "-h") {
      console.log("Usage: node diff_contracts.cjs --old <api-contracts.json> --new <api-contracts.json> [--out <file>]");
      process.exit(0);
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!args.old || !args.new) throw new Error("Missing --old or --new");
  return args;
}

function main() {
  const args = parseArgs(process.argv);
  const oldDoc = JSON.parse(fs.readFileSync(path.resolve(args.old), "utf8"));
  const newDoc = JSON.parse(fs.readFileSync(path.resolve(args.new), "utf8"));
  const report = diffContracts(oldDoc, newDoc);
  const json = JSON.stringify(report, null, 2);
  if (args.out) fs.writeFileSync(path.resolve(args.out), `${json}\n`);
  else process.stdout.write(`${json}\n`);
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    process.stderr.write(`${JSON.stringify({ ok: false, error: String(err?.message || err) })}\n`);
    process.exit(1);
  }
}

module.exports = { diffContracts, contractKey, contractChanges, diffSchemas };
