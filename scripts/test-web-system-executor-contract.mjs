#!/usr/bin/env node
/**
 * Phase 2 executor contract surface (dry-run testable):
 *  - declared fallbackOperations / rollbackOperations are accepted and held to
 *    the same risk ceiling + domain allowlist as primary operations;
 *  - --audit-log writes a durable JSONL trail even at validation time.
 * (Live API→browser fallback / rollback execution needs a real browser and is
 *  integration-tested manually; here we pin the validated contract + audit.)
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const executor = path.join(ROOT, "resources/skills-catalog/lily-web-system-learning/scripts/execute_web_playbook.cjs");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lily-exec-contract-"));

const playbook = {
  schemaVersion: 1,
  id: "demo",
  baseUrl: "https://erp.example.com/home",
  allowedDomains: ["example.com"],
  apiContracts: [],
  actions: [{ action: "web.submit-leave", title: "Submit leave", risk: "submit", confirmation: "explicit", metadata: { apiContractRefs: [] } }],
};
const playbookPath = path.join(tmp, "playbook.json");
fs.writeFileSync(playbookPath, JSON.stringify(playbook));

function writePlan(name, plan) {
  const p = path.join(tmp, name);
  fs.writeFileSync(p, JSON.stringify(plan));
  return p;
}

function run(planPath, extra = []) {
  return spawnSync(process.execPath, [executor, "--playbook", playbookPath, "--action", "web.submit-leave", "--plan", planPath, "--dry-run", "--confirmed", ...extra], { cwd: ROOT, encoding: "utf8" });
}

function assert(cond, msg) { if (!cond) throw new Error(msg); }

try {
  // valid plan with fallback + rollback, plus audit log
  const auditPath = path.join(tmp, "audit.jsonl");
  const goodPlan = writePlan("good.json", {
    action: "web.submit-leave",
    operations: [
      { type: "goto", path: "/leave/new", risk: "read" },
      { type: "fill", selector: "#reason", value: "x", risk: "prepare" },
      { type: "click", selector: "#submit", risk: "submit" },
    ],
    fallbackOperations: [{ type: "goto", path: "/leave/new", risk: "read" }],
    rollbackOperations: [{ type: "goto", path: "/leave/cancel", risk: "read" }],
  });
  const good = run(goodPlan, ["--audit-log", auditPath]);
  assert(good.status === 0, `valid plan should pass dry-run: ${good.stderr}`);
  const validated = JSON.parse(good.stdout);
  assert(Array.isArray(validated.fallbackOperations) && validated.fallbackOperations.length === 1, "fallbackOperations resolved");
  assert(Array.isArray(validated.rollbackOperations) && validated.rollbackOperations.length === 1, "rollbackOperations resolved");
  assert(validated.fallbackOperations[0].url === "https://erp.example.com/leave/new", "fallback goto resolved to absolute allowlisted URL");
  // audit log written durably
  assert(fs.existsSync(auditPath), "--audit-log file created");
  const auditLines = fs.readFileSync(auditPath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert(auditLines.some((e) => e.phase === "validate" && e.fallbackOperations === 1 && e.rollbackOperations === 1), "audit records validation with fallback/rollback counts");

  // fallback op exceeding action risk must be rejected (same ceiling as primary)
  const badRiskPlan = writePlan("bad-risk.json", {
    action: "web.submit-leave",
    operations: [{ type: "goto", path: "/x", risk: "read" }],
    fallbackOperations: [{ type: "click", selector: "#nuke", risk: "destructive" }],
  });
  const badRisk = run(badRiskPlan);
  assert(badRisk.status !== 0, "fallback op exceeding action risk must be rejected");
  assert(/fallbackOperations\[0\]/.test(badRisk.stderr) || /exceeds action risk/.test(badRisk.stderr), "rejection points at fallbackOperations risk");

  // rollback op targeting an off-allowlist domain must be rejected
  const badDomainPlan = writePlan("bad-domain.json", {
    action: "web.submit-leave",
    operations: [{ type: "goto", path: "/x", risk: "read" }],
    rollbackOperations: [{ type: "goto", url: "https://evil.com/y", risk: "read" }],
  });
  const badDomain = run(badDomainPlan);
  assert(badDomain.status !== 0, "rollback op outside allowlist must be rejected");
  assert(/rollbackOperations\[0\]/.test(badDomain.stderr) || /allowedDomains/.test(badDomain.stderr), "rejection points at rollback domain");

  console.log("PASS: test-web-system-executor-contract (9 tests)");
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
