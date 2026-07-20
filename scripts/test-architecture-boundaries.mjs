#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "src/shared/architecture-boundaries.json"), "utf8"));
const SOURCE_EXTENSIONS = new Set([".js", ".mjs", ".cjs"]);

function walk(relativeRoot) {
  const absoluteRoot = path.join(ROOT, relativeRoot);
  const files = [];
  for (const entry of fs.readdirSync(absoluteRoot, { withFileTypes: true })) {
    const relative = path.posix.join(relativeRoot, entry.name);
    if (entry.isDirectory()) files.push(...walk(relative));
    else if (entry.isFile() && SOURCE_EXTENSIONS.has(path.extname(entry.name))) files.push(relative);
  }
  return files;
}

function sourceText(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), "utf8");
}

function lineCount(text) {
  if (!text) return 0;
  const lines = text.split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  return lines.length;
}

function importedSpecifiers(text) {
  const pattern = /\brequire\s*\(\s*["']([^"']+)["']\s*\)|\bfrom\s+["']([^"']+)["']|\bimport\s*(?:\(\s*)?["']([^"']+)["']\s*\)?/g;
  return [...text.matchAll(pattern)].map((match) => match[1] || match[2] || match[3]).filter(Boolean);
}

assert.equal(manifest.schemaVersion, 1);
const sourceFiles = manifest.sourceRoots.flatMap(walk);
const hotspotBudgets = manifest.hotspotLineBudgets || {};

for (const [relativePath, maxLines] of Object.entries(hotspotBudgets)) {
  assert(fs.existsSync(path.join(ROOT, relativePath)), `tracked hotspot is missing: ${relativePath}`);
  const actual = lineCount(sourceText(relativePath));
  assert(
    actual <= maxLines,
    `${relativePath} grew from its ${maxLines}-line ratchet to ${actual}; extract a focused module before adding behavior`,
  );
}

for (const relativePath of sourceFiles) {
  const actual = lineCount(sourceText(relativePath));
  if (actual > manifest.newFileMaxLines) {
    assert(
      Object.prototype.hasOwnProperty.call(hotspotBudgets, relativePath),
      `new untracked hotspot ${relativePath} has ${actual} lines; split responsibilities before merging`,
    );
  }
}

for (const boundary of manifest.forbiddenImports || []) {
  const destination = path.resolve(ROOT, boundary.to);
  for (const relativePath of walk(boundary.from)) {
    for (const specifier of importedSpecifiers(sourceText(relativePath))) {
      if (!specifier.startsWith(".")) continue;
      const resolved = path.resolve(ROOT, path.dirname(relativePath), specifier);
      assert(
        resolved !== destination && !resolved.startsWith(`${destination}${path.sep}`),
        `${relativePath} crosses the ${boundary.from} -> ${boundary.to} process boundary via ${specifier}`,
      );
    }
  }
}

const orchestrator = sourceText("src/main/turn-orchestrator.js");
const intentCall = orchestrator.indexOf("const turnIntelligence = resolveTurnIntelligence(");
const readinessCall = orchestrator.indexOf("await prepareTurnCapabilityReadiness(");
assert(intentCall >= 0 && readinessCall > intentCall, "turn intent must resolve before capability readiness");

const subagentProjectionSource = manifest.singleSources.subagentRuntimeProjection;
assert(
  orchestrator.includes('require("./subagent-runtime-projection")'),
  `turn orchestration must delegate subagent state projection to ${subagentProjectionSource}`,
);
for (const formerMethod of [
  "_applySubagentEvent",
  "_compactSubagent",
  "_refreshSubagentPhase",
  "_scheduleSubagentWatch",
  "_syncSubagentFromTool",
]) {
  assert(
    !orchestrator.includes(`${formerMethod}(`),
    `${formerMethod} belongs in ${subagentProjectionSource}, not the turn orchestrator`,
  );
}

const taskRunRuntimeSource = manifest.singleSources.taskRunRuntime;
assert(
  orchestrator.includes('require("./task-run-runtime")'),
  `turn orchestration must delegate TaskRun state transitions to ${taskRunRuntimeSource}`,
);
for (const formerMethod of [
  "_addTaskEvidence",
  "_beginTaskRun",
  "_completeTaskRun",
  "_markTaskProgress",
  "_updateTaskLivenessFromNotice",
  "_updateTaskPlanFromTodos",
]) {
  assert(
    !orchestrator.includes(`${formerMethod}(`),
    `${formerMethod} belongs in ${taskRunRuntimeSource}, not the turn orchestrator`,
  );
}

const externalCommandRuntimeSource = manifest.singleSources.externalCommandRuntime;
assert(
  orchestrator.includes('require("./external-command-runtime")'),
  `external command admission must delegate to ${externalCommandRuntimeSource}`,
);
for (const formerOwner of ["_buildLedgerStore(", "_externalLedger(", "_persistExternalLedgers("]) {
  assert(
    !orchestrator.includes(formerOwner),
    `${formerOwner} belongs in ${externalCommandRuntimeSource}, not the turn orchestrator`,
  );
}

const turnRecoveryRuntimeSource = manifest.singleSources.turnRecoveryRuntime;
assert(
  orchestrator.includes('require("./turn-recovery-runtime")'),
  `turn recovery policy must delegate to ${turnRecoveryRuntimeSource}`,
);
assert(
  !orchestrator.includes('require("./tool-call-rescue")'),
  `tool rescue strategy belongs in ${turnRecoveryRuntimeSource}, not the turn orchestrator`,
);

const contextCompactionRuntimeSource = manifest.singleSources.contextCompactionRuntime;
assert(
  orchestrator.includes('require("./context-compaction-runtime")'),
  `context compaction must delegate to ${contextCompactionRuntimeSource}`,
);
for (const movedDependency of ["context-budget-manager", "runtime/runtime-capabilities"]) {
  assert(
    !orchestrator.includes(movedDependency),
    `${movedDependency} belongs behind ${contextCompactionRuntimeSource}`,
  );
}

const terminalFinalizerSource = manifest.singleSources.turnTerminalFinalizer;
assert(
  orchestrator.includes('require("./turn-terminal-finalizer")'),
  `terminal turn projection must delegate to ${terminalFinalizerSource}`,
);
for (const movedDependency of ["evaluateAnswerEvidence", "clearDocumentDeliveryTurnState"]) {
  assert(
    !orchestrator.includes(movedDependency),
    `${movedDependency} belongs behind ${terminalFinalizerSource}`,
  );
}

const runtimeEventRouterSource = manifest.singleSources.turnRuntimeEventRouter;
assert(
  orchestrator.includes('require("./turn-runtime-event-router")'),
  `runtime draft projection must delegate to ${runtimeEventRouterSource}`,
);
for (const movedRuntimeCase of ['case "tool.started"', 'case "permission.requested"', 'case "process.event"']) {
  assert(
    !orchestrator.includes(movedRuntimeCase),
    `${movedRuntimeCase} belongs in ${runtimeEventRouterSource}`,
  );
}
assert(
  orchestrator.includes('require("./turn-event-types")'),
  `turn event sets must use ${manifest.singleSources.turnEventTypes}`,
);

const opencodeSession = sourceText("src/main/opencode-agent-session.js");
for (const [ownerKey, importPath] of [
  ["opencodeHistoryRecovery", "./opencode-history-recovery"],
  ["opencodeSessionFailurePolicy", "./opencode-session-failure-policy"],
  ["opencodeSubagentRuntime", "./opencode-subagent-runtime"],
  ["opencodeTodoCompletionPolicy", "./opencode-todo-completion-policy"],
  ["opencodeTurnLiveness", "./opencode-turn-liveness"],
]) {
  assert(
    opencodeSession.includes(`require("${importPath}")`),
    `OpenCode session must delegate to ${manifest.singleSources[ownerKey]}`,
  );
}
for (const movedDefinition of [
  "function buildAttachmentFallbackPromptPayload(",
  "function buildTodoContinuationPrompt(",
  "function detectIncompleteDeliverable(",
  "function messageTextFromOpenCodeItem(",
  "function shouldDropResumeAfterVisibleFailure(",
]) {
  assert(
    !opencodeSession.includes(movedDefinition),
    `${movedDefinition} has a focused OpenCode owner and must not return to the session coordinator`,
  );
}
for (const movedTimerField of ["this._responseTimer", "this._turnWatchdogTimer", "this._healthTimer"]) {
  assert(
    !opencodeSession.includes(movedTimerField),
    `${movedTimerField} belongs in ${manifest.singleSources.opencodeTurnLiveness}`,
  );
}

const skillManager = sourceText("src/main/skill-manager.js");
assert(
  skillManager.includes('require("./bundled-skill-sync")'),
  `bundled skill installation must delegate to ${manifest.singleSources.bundledSkillSync}`,
);
assert(
  skillManager.includes('require("./skill-platform-overlays")'),
  `skill guide overlays must delegate to ${manifest.singleSources.skillPlatformOverlays}`,
);
for (const movedDefinition of [
  "function installSkillFromSource(",
  "function shouldRefreshBundledSkill(",
  "function syncManifestI18nFromBundled(",
  "const SKILL_PLATFORM_OVERLAYS =",
]) {
  assert(
    !skillManager.includes(movedDefinition),
    `${movedDefinition} must not return to the skill manager coordinator`,
  );
}

const semanticsSource = manifest.singleSources.toolSemantics;
for (const relativePath of walk("src/main")) {
  if (relativePath === semanticsSource) continue;
  assert(
    !/(?:const|let|var)\s+(?:READ_ONLY_TOOLS|REPLAY_SAFE_TOOL_NAMES)\s*=/.test(sourceText(relativePath)),
    `${relativePath} duplicates tool semantics instead of using ${semanticsSource}`,
  );
}
for (const consumer of [
  "src/main/task-run-state.js",
  "src/main/tool-call-rescue.js",
  "src/main/opencode-agent-session.js",
  "src/main/turn-artifacts.js",
  "src/main/mcp/tool-broker-registry.js",
]) {
  assert(sourceText(consumer).includes("tool-semantics"), `${consumer} must use the shared tool semantics registry`);
}

const runtimeSchema = sourceText("src/main/runtime-event-schema.js");
assert(runtimeSchema.includes("shared/runtime-contract.json"), "runtime events must use the shared runtime contract");
const taskContract = sourceText("src/main/task-contract.js");
assert(taskContract.includes("enabled: base.enabled !== false"), "remote task intelligence must preserve the local baseline");
assert(!taskContract.includes("enabled: normalizedRemote.enabled"), "remote task intelligence cannot control baseline enablement");

console.log(`architecture-boundaries: ok (${sourceFiles.length} source files, ${Object.keys(hotspotBudgets).length} ratchets)`);
