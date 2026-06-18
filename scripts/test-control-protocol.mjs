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
  buildUserDialogResponse,
  buildElicitationResponse,
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

  // buildUserDialogResponse — the CLI's W6K schema is {behavior, result?}; a
  // response that is not exactly this shape is dropped as response_ignored.
  const dlgCancel = buildUserDialogResponse("rd1");
  assert(dlgCancel.type === "control_response", "dialog response is a control_response");
  assert(dlgCancel.response.subtype === "success", "dialog response wraps success");
  assert(dlgCancel.response.request_id === "rd1", "dialog request_id propagated");
  assert(dlgCancel.response.response.behavior === "cancelled", "default dialog behavior is cancelled");
  assert(!("result" in dlgCancel.response.response), "cancelled dialog carries no result");
  const dlgDone = buildUserDialogResponse("rd2", { behavior: "completed", result: "retry_fallback" });
  assert(dlgDone.response.response.behavior === "completed", "completed behavior passes through");
  assert(dlgDone.response.response.result === "retry_fallback", "completed result passes through");
  // completed with no result must still omit the key (don't send result:undefined)
  assert(!("result" in buildUserDialogResponse("rd3", { behavior: "completed" }).response.response),
    "completed without result omits the key");
  // unknown behavior is coerced to cancelled (fail closed), never echoed raw
  assert(buildUserDialogResponse("rd4", { behavior: "weird" }).response.response.behavior === "cancelled",
    "unknown dialog behavior fails closed to cancelled");

  // buildElicitationResponse — the CLI's X6K schema is {action, content?}.
  const elAccept = buildElicitationResponse("re1", { action: "accept", content: { name: "x" } });
  assert(elAccept.response.response.action === "accept", "elicitation accept action");
  assert(elAccept.response.response.content.name === "x", "elicitation accept content passes through");
  const elCancel = buildElicitationResponse("re2");
  assert(elCancel.response.response.action === "cancel", "default elicitation action is cancel");
  assert(!("content" in elCancel.response.response), "cancel elicitation carries no content");
  // content is only attached on accept (decline/cancel must not leak answers)
  assert(!("content" in buildElicitationResponse("re3", { action: "decline", content: { a: 1 } }).response.response),
    "decline elicitation drops content");

  console.log("PASS: test-control-protocol (29 tests)");
} catch (err) {
  console.error("FAIL:", err.message);
  process.exit(1);
}
