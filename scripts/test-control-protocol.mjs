#!/usr/bin/env node
import module from "node:module";
import { assert } from "./lib/test-assert.mjs";
const require = module.createRequire(import.meta.url);
const {
  needsUserApproval,
  buildControlResponse,
  buildRememberAllowPermissions,
  buildControlCancelRequest,
  parseCanUseToolRequest,
  withPersistentDestination,
} = require("../src/main/control-protocol.js");

try {
  // needsUserApproval
  assert(needsUserApproval("Write", "default"), "Write needs approval in default mode");
  assert(needsUserApproval("Bash", "acceptEdits"), "Bash needs approval in acceptEdits");
  assert(!needsUserApproval("anything", "bypassPermissions"), "bypass skips approval");
  assert(!needsUserApproval("Write", "bypassPermissions"), "Write skipped in bypass");

  // buildControlResponse — allow
  const allow = buildControlResponse("req1", { behavior: "allow", updatedInput: { path: "/a" } });
  assert(allow.type === "control_response", "allow has correct type");
  assert(allow.response.request_id === "req1", "request_id propagated");
  assert(allow.response.response.behavior === "allow", "behavior is allow");
  assert(allow.response.response.updatedInput.path === "/a", "updatedInput passed through");

  // buildControlResponse — deny
  const deny = buildControlResponse("req2", { behavior: "deny" });
  assert(deny.response.response.behavior === "deny", "behavior is deny");
  assert(deny.response.response.message === "User denied this action", "default deny message");

  // buildRememberAllowPermissions
  const perms = buildRememberAllowPermissions("Bash");
  assert(Array.isArray(perms) && perms.length === 1, "returns array");
  assert(perms[0].rules[0].toolName === "Bash", "tool name correct");
  assert(perms[0].destination === "localSettings", "persists to localSettings");

  // buildControlCancelRequest
  const cancel = buildControlCancelRequest("req3");
  assert(cancel.type === "control_cancel_request", "correct type");
  assert(cancel.request_id === "req3", "request_id propagated");

  // withPersistentDestination
  const suggestions = [{ toolName: "Write", destination: "session" }, { toolName: "Read" }];
  const persisted = withPersistentDestination(suggestions);
  assert(persisted[0].destination === "localSettings", "session → localSettings");
  assert(persisted[1].destination === "localSettings", "missing → localSettings");

  // parseCanUseToolRequest — valid
  const parsed = parseCanUseToolRequest({ subtype: "can_use_tool", tool_name: "Write", request_id: "r1", input: { path: "/a" } });
  assert(parsed.toolName === "Write", "tool parsed");
  assert(parsed.requestId === "r1", "requestId parsed");
  assert(parsed.input.path === "/a", "input parsed");

  // parseCanUseToolRequest — nested
  const nested = parseCanUseToolRequest({ type: "sdk_control_request", request: { subtype: "permission", tool_name: "Bash" } });
  assert(nested && nested.toolName === "Bash", "nested request parsed");

  // parseCanUseToolRequest — invalid
  assert(parseCanUseToolRequest({ subtype: "other" }) === null, "non-tool request returns null");
  assert(parseCanUseToolRequest(null) === null, "null returns null");
  assert(parseCanUseToolRequest("str") === null, "string returns null");

  console.log("PASS: test-control-protocol (17 tests)");
} catch (err) {
  console.error("FAIL:", err.message);
  process.exit(1);
}
