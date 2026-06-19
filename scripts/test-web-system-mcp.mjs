#!/usr/bin/env node
/**
 * A learned system's capabilities become typed MCP tools so the model CALLS
 * them (schema-validated) instead of authoring/guessing operation plans. Pin:
 * namespaced tool names (no cross-system collision), inputSchema reflecting the
 * learned params (required/enum/types enforced), and risk→annotation mapping so
 * writes stay gated.
 */
import module from "node:module";
import { assert } from "./lib/test-assert.mjs";

const require = module.createRequire(import.meta.url);
const { toolNameForCapability, buildToolInputSchema, annotationsForRisk, buildSystemTools } = require("../src/main/mcp/web-system-mcp.js");

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

  console.log("PASS: test-web-system-mcp (18 tests)");
} catch (err) {
  console.error("FAIL:", err.message);
  process.exit(1);
}
