#!/usr/bin/env node
/**
 * A learned system's capabilities become typed MCP tools so the model CALLS
 * them (schema-validated) instead of authoring/guessing operation plans. Pin:
 * namespaced tool names (no cross-system collision), inputSchema reflecting the
 * learned params (required/enum/types enforced), and risk→annotation mapping so
 * writes stay gated.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import module from "node:module";
import { assert } from "./lib/test-assert.mjs";

const require = module.createRequire(import.meta.url);
const { toolNameForCapability, buildToolInputSchema, annotationsForRisk, buildSystemTools, buildApiPlan, resolveCapabilityContract } = require("../src/main/mcp/web-system-mcp.js");
const { buildWebSystemMcpEntries } = require("../src/main/mcp-config.js");

try {
  // namespacing: <system>__<capability>, sanitized, no "web." prefix
  assert(toolNameForCapability("demo-erp", "web.query-leaves") === "demo_erp__query_leaves", `tool name, got ${toolNameForCapability("demo-erp", "web.query-leaves")}`);
  assert(!toolNameForCapability("a", "web.b").includes("web."), "web. prefix stripped");

  // risk → annotations
  assert(annotationsForRisk("read").readOnlyHint === true, "read → readOnlyHint");
  assert(annotationsForRisk("submit").destructiveHint === true, "submit → destructiveHint");
  assert(annotationsForRisk("destructive").destructiveHint === true, "destructive → destructiveHint");
  assert(!annotationsForRisk("read").destructiveHint, "read is not destructive");

  // inputSchema enforces the learned params
  const cap = {
    id: "web.create-leave",
    risk: "submit",
    params: {
      required: ["days"],
      optional: ["status"],
      properties: {
        days: { id: "days", type: "number", label: "Days", required: true },
        status: { id: "status", type: "enum", label: "Status", options: [{ value: "open" }, { value: "closed" }] },
      },
    },
  };
  const shape = buildToolInputSchema(cap);
  assert(shape.days.safeParse(undefined).success === false, "required param rejects undefined");
  assert(shape.days.safeParse(3).success === true, "required number accepts a number");
  assert(shape.days.safeParse("x").success === false, "number rejects a string");
  assert(shape.status.safeParse(undefined).success === true, "optional param accepts undefined");
  assert(shape.status.safeParse("open").success === true, "enum accepts a valid option");
  assert(shape.status.safeParse("nope").success === false, "enum rejects an invalid option");

  // buildSystemTools end to end over a 2-capability system
  const tools = buildSystemTools("demo-erp", "Demo ERP", [
    { id: "web.query-leaves", title: "Query leaves", risk: "read", intents: ["查请假"], params: { required: [], optional: [], properties: {} } },
    cap,
  ]);
  assert(tools.length === 2, "one tool per capability");
  const read = tools.find((t) => t.name === "demo_erp__query_leaves");
  const write = tools.find((t) => t.name === "demo_erp__create_leave");
  assert(read && read.annotations.readOnlyHint, "read capability tool is read-only");
  assert(write && write.annotations.destructiveHint, "write capability tool is destructive-hinted");
  assert(write.description.includes("risk: submit"), "write tool description flags risk");
  assert(read.description.includes("查请假"), "tool description carries intents for routing");
  assert(write.capabilityId === "web.create-leave", "tool maps back to its capability id");

  // deterministic plan materialization (handler binds params into the contract)
  const getCap = { id: "web.query-leaves", action: "web.query-leaves", risk: "read", execution: { apiContractRefs: ["list-leaves"] } };
  const postCap = { id: "web.create-leave", action: "web.create-leave", risk: "submit", execution: { apiContractRefs: ["create-leave"] } };
  const contracts = [
    { id: "list-leaves", method: "GET", contentType: "query" },
    { id: "create-leave", method: "POST", contentType: "json" },
  ];
  assert(resolveCapabilityContract(getCap, contracts).id === "list-leaves", "resolves first api contract ref");
  assert(resolveCapabilityContract({ execution: {} }, contracts) === null, "no refs → no contract");

  const getPlan = buildApiPlan(getCap, contracts[0], { status: "open" });
  assert(getPlan.action === "web.query-leaves" && getPlan.operations.length === 1, "plan has the action + one op");
  assert(getPlan.operations[0].type === "apiRequest" && getPlan.operations[0].method === "GET", "GET apiRequest op");
  assert(JSON.stringify(getPlan.operations[0].query) === JSON.stringify({ status: "open" }) && getPlan.operations[0].body === undefined, "GET binds params to query, no body");

  const postPlan = buildApiPlan(postCap, contracts[1], { days: 2 });
  assert(postPlan.operations[0].method === "POST" && postPlan.operations[0].risk === "submit", "POST plan carries write risk");
  assert(JSON.stringify(postPlan.operations[0].body) === JSON.stringify({ days: 2 }) && postPlan.operations[0].contentType === "json", "write binds params to JSON body");

  // mcp-config: a learned system dir with playbook+capability-map → one server entry
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lily-mcp-entries-"));
  const sysDir = path.join(tmp, "learned-demo-erp");
  fs.mkdirSync(sysDir, { recursive: true });
  fs.writeFileSync(path.join(sysDir, "capability-map.json"), "{}");
  fs.writeFileSync(path.join(sysDir, "web-system-playbook.json"), "{}");
  const emptyDir = path.join(tmp, "not-a-system");
  fs.mkdirSync(emptyDir, { recursive: true });
  const entries = buildWebSystemMcpEntries([sysDir, emptyDir]);
  const names = Object.keys(entries);
  assert(names.length === 1, `only the real system gets an entry, got ${names.join(",")}`);
  assert(names[0] === "web_learned_demo_erp", `server name namespaced, got ${names[0]}`);
  assert(entries[names[0]].args.includes("--system") && entries[names[0]].args.includes(sysDir), "entry launches the stdio server for that system dir");
  assert(entries[names[0]].env.ELECTRON_RUN_AS_NODE === "1", "entry runs the app binary in node mode");
  fs.rmSync(tmp, { recursive: true, force: true });

  console.log("PASS: test-web-system-mcp (29 tests)");
} catch (err) {
  console.error("FAIL:", err.message);
  process.exit(1);
}
