#!/usr/bin/env node
/**
 * Test ApprovalBroker: permission state machine (allow, deny, cancel, timeouts).
 * Pure logic — all side effects are injected, so no Electron needed.
 */
import module from "node:module";

const require = module.createRequire(import.meta.url);
const { ApprovalBroker } = require("../src/main/approval-broker.js");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function makeMocks() {
  const written = [];
  const ingested = [];
  const notices = [];
  let blockingCalls = 0;
  let activityCalls = 0;
  let gatePolls = 0;
  let mode = "default";
  let timeout = 30000;

  return {
    written,
    ingested,
    notices,

    writeControl(payload) { written.push(structuredClone(payload)); },
    ingest(drafts) { ingested.push(...drafts.map(d => structuredClone(d))); },
    emitNotice(notice) { notices.push(structuredClone(notice)); },
    onBlockingRequest() { blockingCalls++; },
    onActivity() { activityCalls++; },
    pollGate() { gatePolls++; },
    permissionMode() { return mode; },
    setPermissionMode(m) { mode = m; },
    timeoutMs() { return timeout; },
    setTimeoutMs(t) { timeout = t; },
    normalizeQuestions(input) {
      return (input?.questions || []).map(q => ({
        question: q.question || q.label || "",
        header: q.header || "",
        options: q.options || [],
      }));
    },

    getAllWritten() { return written; },
    getAllIngested() { return ingested; },
    getAllNotices() { return notices; },
    getBlockingCalls() { return blockingCalls; },
    getActivityCalls() { return activityCalls; },
    getGatePolls() { return gatePolls; },
    reset() {
      written.length = 0;
      ingested.length = 0;
      notices.length = 0;
      blockingCalls = 0;
      activityCalls = 0;
      gatePolls = 0;
    },
  };
}

try {
  // ===== Test 1: construction and initial state =====
  const m = makeMocks();
  const broker = new ApprovalBroker(m);
  assert(broker.permissionCount() === 0, "should start with 0 permissions");
  assert(broker.hookCount() === 0, "should start with 0 hooks");

  // ===== Test 2: handleCanUseTool with default mode → needs approval =====
  broker.handleCanUseTool({
    requestId: "req_1",
    toolName: "Bash",
    input: { command: "ls" },
  }, null);
  assert(broker.permissionCount() === 1, "Bash should wait for approval in default mode");
  assert(broker.permissionIds().includes("req_1"), "req_1 should be pending");

  // ===== Test 3: respondPermission allow =====
  m.reset();
  const allowed = broker.respondPermission("req_1", { allow: true });
  assert(allowed === true, "respondPermission should return true");
  assert(broker.permissionCount() === 0, "permission should be removed after allow");
  const allowControl = m.getAllWritten().find(c => c?.response?.response?.behavior === "allow");
  assert(allowControl, "should write allow control");
  assert(m.getAllIngested().some(e => e.type === "permission.resolved"), "should ingest resolved");
  assert(m.getActivityCalls() === 1, "should trigger activity");
  assert(m.getGatePolls() === 1, "should poll gate");

  // ===== Test 4: respondPermission deny =====
  broker.handleCanUseTool({
    requestId: "req_2",
    toolName: "Write",
    input: { file_path: "/tmp/x" },
  }, null);
  m.reset();
  const denied = broker.respondPermission("req_2", { allow: false, message: "nope" });
  assert(denied === true, "deny should return true");
  assert(broker.permissionCount() === 0, "permission should be removed after deny");
  assert(m.getAllNotices().some(n => n.code === "permissionUserDenied"), "should emit deny notice");

  // ===== Test 5: respondPermission for unknown request =====
  assert(broker.respondPermission("nonexistent", { allow: true }) === false, "unknown request should return false");

  // ===== Test 6: cancelPermission =====
  broker.handleCanUseTool({
    requestId: "req_3",
    toolName: "Bash",
    input: { command: "rm -rf" },
  }, null);
  m.reset();
  const cancelled = broker.cancelPermission("req_3");
  assert(cancelled === true, "cancel should return true");
  assert(broker.permissionCount() === 0, "should remove permission");
  assert(m.getGatePolls() === 1, "should poll gate on cancel");

  // ===== Test 7: cancelPermission unknown =====
  assert(broker.cancelPermission("ghost") === false, "unknown cancel should return false");

  // ===== Test 8: denyAllPermissions =====
  broker.handleCanUseTool({ requestId: "r1", toolName: "Bash", input: {} }, null);
  broker.handleCanUseTool({ requestId: "r2", toolName: "Write", input: {} }, null);
  assert(broker.permissionCount() === 2, "should have 2 pending");
  m.reset();
  broker.denyAllPermissions("mass deny");
  assert(broker.permissionCount() === 0, "all should be cleared");
  assert(m.getAllWritten().length >= 4, "should write deny + cancel for each");

  // ===== Test 9: clearPermissions with notify =====
  broker.handleCanUseTool({ requestId: "rx", toolName: "Bash", input: {} }, null);
  m.reset();
  broker.clearPermissions(true);
  assert(broker.permissionCount() === 0, "should be cleared");
  assert(m.getAllIngested().some(e => e.type === "permission.resolved"), "should notify cancel");

  // ===== Test 10: clearPermissions without notify =====
  broker.handleCanUseTool({ requestId: "ry", toolName: "Bash", input: {} }, null);
  m.reset();
  broker.clearPermissions(false);
  assert(broker.permissionCount() === 0, "should be cleared");
  assert(m.getAllIngested().length === 0, "should not notify");

  // ===== Test 11: dontAsk mode → auto-deny =====
  m.setPermissionMode("dontAsk");
  m.reset();
  broker.handleCanUseTool({
    requestId: "req_da",
    toolName: "Bash",
    input: { command: "ls" },
  }, null);
  assert(broker.permissionCount() === 0, "dontAsk should auto-deny without waiting");
  assert(m.getAllNotices().some(n => n.code === "permissionAutoDenied"), "should emit auto-deny notice");

  // ===== Test 12: AskUserQuestion special handling =====
  m.setPermissionMode("default");
  m.reset();
  broker.handleCanUseTool({
    requestId: "req_aq",
    toolName: "AskUserQuestion",
    input: { questions: [{ question: "What?", header: "Q", options: ["A", "B"] }] },
  }, null);
  assert(broker.permissionCount() === 1, "AskUserQuestion should wait");

  const aqAllowed = broker.respondUserQuestion("req_aq", { answers: { Q: "A" } });
  assert(aqAllowed === true, "should respond to question");
  assert(broker.permissionCount() === 0, "should clear after response");

  // ===== Test 13: respondUserQuestion for non-AskUserQuestion =====
  broker.handleCanUseTool({ requestId: "req_bash", toolName: "Bash", input: {} }, null);
  assert(broker.respondUserQuestion("req_bash", {}) === false, "should reject non-AQ request");

  // ===== Test 14: hooks (clear, count) =====
  // Hooks are set externally but managed by broker
  broker._pendingHooks.set("hk_1", { hookName: "PreToolUse", toolName: "Bash", requestId: "hk_1" });
  assert(broker.hookCount() === 1, "should track hooks");
  assert(broker.hookIds().includes("hk_1"), "should list hook ids");
  m.reset();
  broker.clearHooks(true);
  assert(broker.hookCount() === 0, "should clear hooks");
  assert(m.getAllIngested().some(e => e.type === "hook.resolved"), "should notify hook cancel");

  console.log("PASS: test-approval-broker (14 tests)");
} catch (err) {
  console.error("FAIL:", err.message);
  process.exit(1);
}
