#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import module from "node:module";
import { assert } from "./lib/test-assert.mjs";

const require = module.createRequire(import.meta.url);
const { buildBrokerTools, findBrokerTool } = require("../src/main/mcp/tool-broker-registry.js");

function names(context, deps) {
  return buildBrokerTools(context, deps).map((tool) => tool.name).sort();
}

const PLATFORM_TOOLS = [
  "lily_capability_list",
  "lily_capability_status",
  "runtime_pack_install",
  "runtime_pack_list",
];

try {
  const base = { sessionId: "s1", activeSkillIds: [] };
  assert(
    JSON.stringify(names(base)) === JSON.stringify(PLATFORM_TOOLS),
    "platform capabilities are visible even when no optional skills are enabled",
  );
  assert(names({ activeSkillIds: ["lily-mail-assistant"], connectorStatus: { mailConnected: true } }).length === 0, "missing session id fails closed");

  const mail = {
    sessionId: "s1",
    activeSkillIds: ["lily-mail-assistant"],
    connectorStatus: { mailConnected: true },
  };
  assert(
    JSON.stringify(names(mail)) === JSON.stringify([...PLATFORM_TOOLS, "mail_list_accounts", "mail_read", "mail_search", "mail_send"].sort()),
    "mail tools are added when mail skill + bridge are active",
  );
  assert(JSON.stringify(names({ ...mail, connectorStatus: { mailConnected: false } })) === JSON.stringify(PLATFORM_TOOLS), "mail bridge unavailable hides only mail tools");
  assert(findBrokerTool(mail, "mail_send").annotations.destructiveHint === true, "mail_send remains destructive");
  assert(findBrokerTool(mail, "mail_search").inputSchema.limit.safeParse(100).success === false, "mail_search schema clamps limit");

  const runtime = { sessionId: "s1", activeSkillIds: [] };
  assert(names(runtime).includes("runtime_pack_install"), "runtime-pack install is a platform tool, not gated by a skill");
  assert(findBrokerTool(runtime, "runtime_pack_install").annotations.destructiveHint === true, "runtime pack install is destructive");
  assert(findBrokerTool(runtime, "lily_capability_status").annotations.readOnlyHint === true, "capability status is read-only");

  const browser = { sessionId: "s1", activeSkillIds: ["lily-browser-qa"], runtime: { browserAvailable: true } };
  assert(JSON.stringify(names(browser)) === JSON.stringify([...PLATFORM_TOOLS, "browser_open"].sort()), "browser tool visible when runtime exists");
  assert(JSON.stringify(names({ ...browser, runtime: { browserAvailable: false } })) === JSON.stringify(PLATFORM_TOOLS), "browser tool hidden when runtime missing");

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lily-broker-registry-"));
  const on = path.join(tmp, "learned-on");
  const off = path.join(tmp, "learned-off");
  for (const dir of [on, off]) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "web-system-playbook.json"), "{}");
    fs.writeFileSync(path.join(dir, "capability-map.json"), JSON.stringify({
      systemId: path.basename(dir),
      systemName: path.basename(dir),
      capabilities: [{
        id: "web.query",
        title: "Query",
        risk: "read",
        params: { required: ["q"], properties: { q: { type: "string", label: "Query" } } },
      }],
    }));
  }
  try {
    const learned = {
      sessionId: "s1",
      activeSkillIds: ["learned-on"],
    };
    const deps = { learnedWebSystemDirs: () => [on, off] };
    const learnedNames = names(learned, deps);
    assert(JSON.stringify(learnedNames) === JSON.stringify([...PLATFORM_TOOLS, "learned_on__query"].sort()), `only active learned system visible, got ${learnedNames.join(",")}`);
    assert(findBrokerTool(learned, "learned_on__query", deps).annotations.readOnlyHint === true, "learned read tool carries annotation");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  console.log("PASS: test-tool-broker-registry (13 tests)");
} catch (err) {
  console.error("FAIL:", err.message);
  process.exit(1);
}
