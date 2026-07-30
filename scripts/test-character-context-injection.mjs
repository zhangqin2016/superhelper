#!/usr/bin/env node
/**
 * Character Worlds OpenCode injection boundary (Task 7, spec §10.2). The
 * compiled lower-authority context rides ONLY as a delimited suffix of the
 * per-request system field, after the protected Lily prefix:
 * - absent / disabled / invalid / oversized context → the body is BYTE-EQUAL
 *   to the native baseline (system and parts);
 * - a compiled context leaves the Lily prefix byte-stable at the head of
 *   `system` and NEVER appears in user text/parts or file parts;
 * - providers that cannot reliably carry per-request system context
 *   (conservative capability check, injectable) receive the native body.
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { buildOpencodePromptBody } = require("../src/main/runtime/opencode-message-parts.js");
const { OpencodeServerManager } = require("../src/main/runtime/opencode-server-manager.js");
const { compileCharacterContext } = require("../src/main/character-worlds/context-compiler.js");

const snapshot = Object.freeze({
  schemaVersion: 1,
  mode: "character",
  bindingVersion: 2,
  characterRevisionId: "rev-9",
  compatibilityProfile: "lily-character-worlds-v1",
  snapshotStatus: "ready",
});
const revision = {
  schemaVersion: 1,
  id: "rev-9",
  characterId: "char-9",
  revisionNumber: 1,
  contentHash: "sha256:" + "b".repeat(64),
  source: { kind: "imported", format: "character_card_v2", container: "json" },
  canonical: {
    schemaVersion: 1,
    name: "Aria",
    description: "A meticulous archivist.",
    personality: "precise",
    scenario: "The great library.",
    exampleDialogue: "{{user}}: Hi\n{{char}}: Hello.",
    systemPrompt: "Imported narrator prompt.",
    postHistoryInstructions: "Stay in character.",
  },
};
const compiled = compileCharacterContext({
  snapshot,
  revision,
  userText: "hello",
  taskContract: { active: true, taskType: "roleplay" },
  modelBudget: { usableInputTokens: 32768, remainingInputTokens: 12000 },
});
assert.equal(compiled.status, "compiled", "fixture compiles");

const baseInput = {
  text: "hello there",
  guidance: "LILY PROTECTED GUIDANCE",
  agent: "build",
  model: { providerID: "anthropic", modelID: "claude-sonnet-4" },
};
const baselineBody = buildOpencodePromptBody(baseInput);

function assertNativeEqual(body, label) {
  assert.equal(body.system, baselineBody.system, `${label}: system bytes unchanged`);
  assert.equal(
    JSON.stringify(body.parts),
    JSON.stringify(baselineBody.parts),
    `${label}: parts bytes unchanged`,
  );
  assert.equal("system" in body, "system" in baselineBody, `${label}: system key presence unchanged`);
}

// --- absent / disabled / invalid / oversized → byte-equal native body ---------
assertNativeEqual(buildOpencodePromptBody({ ...baseInput, characterContext: null }), "null context");
assertNativeEqual(buildOpencodePromptBody({ ...baseInput, characterContext: undefined }), "absent context");
assertNativeEqual(
  buildOpencodePromptBody({ ...baseInput, characterContext: { status: "native", text: "", fingerprint: null, warnings: [] } }),
  "native-sentinel context",
);
assertNativeEqual(
  buildOpencodePromptBody({ ...baseInput, characterContext: { status: "compiled", text: "forged" } }),
  "structurally invalid context",
);
assertNativeEqual(
  buildOpencodePromptBody({
    ...baseInput,
    characterContext: { ...compiled, tokenEstimate: 999999 },
  }),
  "oversized context",
);
assertNativeEqual(
  buildOpencodePromptBody({
    ...baseInput,
    characterContext: { ...compiled, fingerprint: "sha256:not-a-real-fingerprint" },
  }),
  "context with an invalid fingerprint",
);
assertNativeEqual(
  buildOpencodePromptBody({ ...baseInput, characterContext: compiled, characterContextSupport: false }),
  "explicitly disabled support (injectable)",
);
assertNativeEqual(
  buildOpencodePromptBody({ ...baseInput, characterContext: compiled, capabilityGrade: "lite" }),
  "lite-grade provider without safe system context",
);
assertNativeEqual(
  buildOpencodePromptBody({
    ...baseInput,
    characterContext: compiled,
    providerCapabilities: { safeSystemContext: false },
  }),
  "provider capability metadata opting out of safe system context",
);

// --- compiled context: delimited suffix after the protected prefix -------------
{
  const roleBody = buildOpencodePromptBody({ ...baseInput, characterContext: compiled });
  assert.ok(
    roleBody.system.startsWith(baselineBody.system),
    "Lily protected prefix stays byte-stable at the head of system",
  );
  assert.match(roleBody.system, /CHARACTER WORLDS CONTEXT/);
  assert.match(roleBody.system, /lower-authority narrative context/i);
  assert.ok(
    roleBody.system.indexOf("CHARACTER WORLDS CONTEXT") > baselineBody.system.length,
    "the character block is appended AFTER the Lily prefix",
  );
  assert.ok(
    roleBody.system.includes(compiled.fingerprint),
    "the dynamic suffix is separately fingerprinted",
  );
  assert.doesNotMatch(
    JSON.stringify(roleBody.parts),
    /CHARACTER WORLDS CONTEXT/,
    "character context never appears in user text or file parts",
  );
  assert.doesNotMatch(JSON.stringify(roleBody.parts), /Aria/);
}

// --- compiled context with no Lily guidance still lands in system only --------
{
  const bareBaseline = buildOpencodePromptBody({ text: "hello there", agent: "build" });
  assert.equal("system" in bareBaseline, false, "baseline without guidance has no system key");
  const roleBody = buildOpencodePromptBody({
    text: "hello there",
    agent: "build",
    characterContext: compiled,
  });
  assert.match(roleBody.system, /CHARACTER WORLDS CONTEXT/);
  assert.ok(
    !roleBody.system.startsWith("\n"),
    "an empty Lily prefix never leaves stray leading blank lines",
  );
  assert.ok(
    roleBody.system.startsWith("[CHARACTER WORLDS CONTEXT suffix;"),
    "the suffix starts with its own delimiter when there is no Lily prefix",
  );
  assert.doesNotMatch(JSON.stringify(roleBody.parts), /CHARACTER WORLDS CONTEXT/);
  const disabled = buildOpencodePromptBody({
    text: "hello there",
    agent: "build",
    characterContext: compiled,
    characterContextSupport: false,
  });
  assert.equal("system" in disabled, false, "unsupported provider never gains a system key");
}

// --- through the server-manager path (stubbed SDK session) ---------------------
async function captureBody(env = {}) {
  const manager = new OpencodeServerManager({
    serverCommand: "/bin/true",
    cwd: "/workspace",
    dataDir: ":memory:",
    env,
  });
  manager.sessionID = "ses_character_context";
  let sentBody = null;
  manager._sdkSession = {
    promptAsync: async (_sid, body) => {
      sentBody = body;
    },
  };
  return { manager, send: async (payload) => { await manager.sendPrompt(payload); return sentBody; } };
}

{
  const { send } = await captureBody();
  const native = await send({ text: "hello there", guidance: "LILY PROTECTED GUIDANCE" });
  assert.equal(native.system, "LILY PROTECTED GUIDANCE", "server-manager baseline unchanged");
  assert.doesNotMatch(JSON.stringify(native.parts), /CHARACTER WORLDS CONTEXT/);
}
{
  const { send } = await captureBody();
  const roleBody = await send({
    text: "hello there",
    guidance: "LILY PROTECTED GUIDANCE",
    characterContext: compiled,
  });
  assert.ok(roleBody.system.startsWith("LILY PROTECTED GUIDANCE"), "prefix byte-stable via server-manager");
  assert.match(roleBody.system, /CHARACTER WORLDS CONTEXT/);
  assert.doesNotMatch(JSON.stringify(roleBody.parts), /CHARACTER WORLDS CONTEXT/);
}
{
  const { send } = await captureBody({ LILY_MODEL_CAPABILITY_GRADE: "lite" });
  const native = await send({
    text: "hello there",
    guidance: "LILY PROTECTED GUIDANCE",
    characterContext: compiled,
  });
  assert.equal(
    native.system,
    "LILY PROTECTED GUIDANCE",
    "a provider without safe per-request system context receives the native body",
  );
  assert.doesNotMatch(JSON.stringify(native.parts), /CHARACTER WORLDS CONTEXT/);
}
{
  const { send } = await captureBody();
  const native = await send({
    text: "hello there",
    guidance: "LILY PROTECTED GUIDANCE",
    characterContext: { status: "compiled", text: "forged" },
  });
  assert.equal(native.system, "LILY PROTECTED GUIDANCE", "invalid context dropped by server-manager");
}

console.log("character-context-injection: ok");
