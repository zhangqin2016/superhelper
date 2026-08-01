"use strict";
/**
 * §19.7 deterministic native-versus-role Agent task parity: for the SAME task,
 * a role-bound turn must be 100% identical to native for required tools,
 * permissions, evidence, artifacts, and machine-readable output. Only the
 * bounded, lower-authority character suffix may differ.
 *
 * The engine prompt body is the deterministic contract an Agent task receives:
 * tool definitions, permission/evidence layers, artifact/file parts, and the
 * machine-readable task contract all live in `parts` + `taskContract`. This
 * test asserts those are byte-identical between native and role modes, so an
 * Agent task produces identical tools/evidence/artifacts in both modes while
 * only safe conversational prose (the system suffix) changes.
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { buildOpencodePromptBody } = require("../src/main/runtime/opencode-message-parts.js");
const {
  compileCharacterContext,
} = require("../src/main/character-worlds/context-compiler.js");

const snapshot = {
  schemaVersion: 1,
  mode: "character",
  bindingVersion: 5,
  characterRevisionId: "char-rev-parity",
  personaRevisionId: null,
  compatibilityProfile: "v3",
  snapshotStatus: "ready",
};
const revision = {
  id: "char-rev-parity",
  characterId: "char-entity-parity",
  canonical: {
    name: "Parity Narrator",
    description: "A narrative voice used ONLY as a system suffix.",
    personality: "consistent, brief",
  },
  source: { kind: "created", format: "lily", container: "json" },
  characterBookRevisionId: null,
};
const compiled = compileCharacterContext({ snapshot, revision, userText: "solve the task" });
assert.equal(compiled.status, "compiled", "fixture compiles");

// A full Agent task surface: files (artifacts), evidence layers, subagent
// surface, tool-ish parts, output reserve, and the machine-readable contract.
const taskInput = {
  text: "find the bug in src/main.js and fix it",
  guidance: "LILY PROTECTED GUIDANCE: keep the change surgical.",
  agent: "build",
  model: { providerID: "lily", modelID: "deepseek-v4-flash" },
  files: [
    { path: "/abs/src/main.js", size: 2048, mime: "text/javascript", text: "export const x = 1;" },
    { path: "/abs/src/util.js", size: 512, mime: "text/javascript", text: "export const y = 2;" },
  ],
  evidence: { layers: ["file", "tool", "runtime"], enabled: true },
  subagents: ["explore", "general"],
  outputReserve: 4096,
  permissionModeId: "ask",
  taskContract: {
    active: true,
    taskType: "coding",
    successCriteria: ["tests pass", "surgical diff"],
    verification: "run npm test",
  },
};

const nativeBody = buildOpencodePromptBody(taskInput);
const roleBody = buildOpencodePromptBody({ ...taskInput, characterContext: compiled });

let checks = 0;
function check(name, fn) {
  fn();
  checks += 1;
  console.log(`ok - ${name}`);
}

try {
  check("artifact/file parts are byte-identical (native vs role)", () => {
    assert.equal(JSON.stringify(roleBody.parts), JSON.stringify(nativeBody.parts));
  });

  check("machine-readable task contract is identical", () => {
    assert.deepEqual(roleBody.taskContract, nativeBody.taskContract);
  });

  check("output reserve is identical", () => {
    assert.equal(roleBody.outputReserve, nativeBody.outputReserve);
  });

  check("permission/evidence surface is identical", () => {
    assert.deepEqual(roleBody.evidence, nativeBody.evidence);
    assert.equal(roleBody.permissionModeId, nativeBody.permissionModeId);
  });

  check("subagent surface is identical", () => {
    assert.deepEqual(roleBody.subagents, nativeBody.subagents);
  });

  check("the Lily protected prefix stays byte-stable; only a bounded suffix is appended", () => {
    assert.ok(roleBody.system.startsWith(nativeBody.system), "protected prefix unchanged");
    assert.match(roleBody.system, /CHARACTER WORLDS CONTEXT/);
    assert.match(roleBody.system, /lower-authority/i);
    // The ONLY difference between the two system texts is the appended suffix.
    assert.equal(
      roleBody.system.length > nativeBody.system.length,
      true,
      "role mode appends a suffix",
    );
  });

  check("role mode never adds or removes tool definitions", () => {
    const nativeTools = JSON.stringify(nativeBody.parts).match(/"type":"tool"/g)?.length || 0;
    const roleTools = JSON.stringify(roleBody.parts).match(/"type":"tool"/g)?.length || 0;
    assert.equal(roleTools, nativeTools);
  });

  console.log(`PASS: test-character-agent-task-parity (${checks} checks)`);
} catch (error) {
  console.error("FAIL:", error?.message || error);
  process.exitCode = 1;
}
