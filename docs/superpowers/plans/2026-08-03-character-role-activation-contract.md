# Character Role Activation Contract Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a selected Character Worlds role the verified conversational identity on every admitted turn without changing Lily's tools, permissions, safety, evidence, or exact task output.

**Architecture:** Add a pure host-owned activation-contract compiler beside the existing lower-authority narrative compiler. Compose and validate both layers only at the final OpenCode request boundary, emit a metadata-only application receipt through the runtime event stream, and drive the role UI from `applied` evidence instead of selection alone. Every failure keeps the current native Lily prompt bytes and capabilities.

**Tech Stack:** Electron main process, CommonJS runtime modules, OpenCode SDK prompt body, shared runtime-event contract, renderer ES modules, Node/Electron script tests.

---

## File Map

- Create `src/main/character-worlds/role-activation-contract.js`: pure validation, profile semantics, trusted serialization, and fingerprints.
- Modify `src/main/character-worlds/context-compiler.js`: attach a host contract to successful character compilations while retaining the narrative envelope and native sentinel.
- Modify `src/main/runtime/opencode-character-context.js`: compose activation and narrative layers and return a metadata-only application receipt.
- Modify `src/main/runtime/opencode-message-parts.js`: expose the receipt on the non-enumerable request-build result without changing provider JSON.
- Modify `src/main/runtime/opencode-server-manager.js`: report final application evidence before dispatch.
- Modify `src/main/opencode-agent-session.js`: ingest application evidence as a runtime draft and preserve it on retries.
- Modify `src/shared/runtime-contract.json`: add the `character.application` metadata event contract.
- Modify `src/renderer/modules/session-runtime-store.js`: project application status per session/turn.
- Modify `src/renderer/modules/character-control-model.js`: store only current-session application metadata.
- Modify `src/renderer/modules/character-session-control.js`: subscribe to runtime state and render selected/applied/bypassed accurately.
- Modify `src/renderer/modules/character-binding-updates.js`: render the status text and accessible label in the existing role row.
- Modify `src/renderer/i18n/locales/{zh-CN,en,ar}.json`: application-state labels.
- Modify `src/main/character-worlds/agent-draft-tools.js`: strengthen Lily's character authoring contract for complete cards.
- Create `scripts/test-character-role-activation-contract.mjs`: pure host-contract tests.
- Modify focused Character Worlds, OpenCode injection, runtime schema, renderer, and authoring tests listed below.
- Modify `CAPABILITY-GATE.md`: register the behavioral activation and native-parity guards.

### Task 1: Host-Owned Activation Contract

**Files:**
- Create: `src/main/character-worlds/role-activation-contract.js`
- Create: `scripts/test-character-role-activation-contract.mjs`

- [ ] **Step 1: Write the failing pure contract test**

Cover `balanced`, `immersive`, and `task_preserving`; assert the contract names the selected role, requires identity adoption, protects capability domains, rejects malformed names/profiles, and contains none of the imported description or system-prompt text.

```js
const contract = compileRoleActivationContract({
  role: { revisionId: "rev-1", name: "Lily · Chief Architect" },
  expressionProfile: "balanced",
  narrativeFingerprint: `sha256:${"a".repeat(64)}`,
});
assert.equal(contract.status, "compiled");
assert.match(contract.text, /active conversational identity/i);
assert.match(contract.text, /Lily · Chief Architect/);
assert.doesNotMatch(contract.text, /disable tools|imported secret/i);
assert.ok(contract.protectedDomains.includes("tools"));
```

- [ ] **Step 2: Run RED**

Run: `node scripts/test-character-role-activation-contract.mjs`

Expected: FAIL because `role-activation-contract.js` does not exist.

- [ ] **Step 3: Implement the minimal pure compiler**

Export:

```js
compileRoleActivationContract({ role, expressionProfile, narrativeFingerprint })
normalizeRoleActivationContract(value)
ROLE_ACTIVATION_SCHEMA_VERSION
```

Use fixed host-owned profile clauses, bounded sanitized role names, an allowlisted protected-domain array, stable JSON, and separate SHA-256 activation/narrative fingerprints. Invalid input returns `null`; it never guesses a role.

- [ ] **Step 4: Run GREEN**

Run: `node scripts/test-character-role-activation-contract.mjs`

Expected: PASS with all profile, hostile-input, and determinism checks.

- [ ] **Step 5: Commit**

```bash
git add src/main/character-worlds/role-activation-contract.js scripts/test-character-role-activation-contract.mjs
git commit -m "feat: add host-owned role activation contract"
```

### Task 2: Character Compiler Integration

**Files:**
- Modify: `src/main/character-worlds/context-compiler.js`
- Modify: `scripts/test-character-context-compiler.mjs`
- Modify: `scripts/test-character-worlds-capability-gate.mjs`

- [ ] **Step 1: Add failing compiler assertions**

Assert successful character compilation returns `activationContract`, all profiles have executable host semantics, native/fallback compilation has no activation contract, and imported imperative strings appear only in the narrative envelope.

```js
assert.equal(compiled.activationContract.status, "compiled");
assert.equal(compiled.activationContract.conversationRole.name, "Aria");
assert.equal(compiled.activationContract.expressionProfile, "task_preserving");
assert.doesNotMatch(compiled.activationContract.text, /ignore permission/i);
```

- [ ] **Step 2: Run RED**

Run: `node scripts/test-character-context-compiler.mjs && node scripts/test-character-worlds-capability-gate.mjs`

Expected: first relevant assertion FAILS because successful contexts have no activation contract.

- [ ] **Step 3: Attach the contract after final narrative assembly**

Call `compileRoleActivationContract` only after the narrative text and fingerprint are final. Return native if identity plus activation cannot be represented safely. Preserve existing `text`, `fingerprint`, budgets, world-book activation, and native sentinel fields.

- [ ] **Step 4: Run GREEN**

Run the two commands from Step 2.

Expected: PASS; current lower-authority redaction and capability-gate tests remain green.

- [ ] **Step 5: Commit**

```bash
git add src/main/character-worlds/context-compiler.js scripts/test-character-context-compiler.mjs scripts/test-character-worlds-capability-gate.mjs
git commit -m "feat: compile trusted role activation with character context"
```

### Task 3: Final Request Composition And Receipt

**Files:**
- Modify: `src/main/runtime/opencode-character-context.js`
- Modify: `src/main/runtime/opencode-message-parts.js`
- Modify: `src/main/runtime/opencode-server-manager.js`
- Modify: `scripts/test-character-context-injection.mjs`
- Modify: `scripts/test-character-agent-task-parity.mjs`

- [ ] **Step 1: Write failing final-body tests**

Require this composition result:

```js
{
  system: "<kernel>\n\n<host activation>\n\n<narrative data>",
  application: {
    status: "applied",
    revisionId: "rev-1",
    expressionProfile: "balanced",
    activationFingerprint: "sha256:...",
    narrativeFingerprint: "sha256:..."
  }
}
```

Assert unsupported/lite/invalid/budget cases preserve the exact kernel bytes and return `bypassed` with a bounded reason. Native input returns `native`. Assert application metadata is not serialized into the provider body.

- [ ] **Step 2: Run RED**

Run: `node scripts/test-character-context-injection.mjs && node scripts/test-character-agent-task-parity.mjs`

Expected: FAIL because the current composer returns only a string and has no receipt.

- [ ] **Step 3: Implement one composition boundary**

Add:

```js
composeCharacterSystemLayers(systemText, characterContext, supportOptions)
```

Keep `withCharacterContextSuffix` as a compatibility wrapper. Attach the receipt to the local build result with a non-enumerable symbol/property, then let `OpencodeServerManager.sendPrompt` call an optional `onCharacterApplication(receipt)` immediately after final body construction and before `promptAsync`.

- [ ] **Step 4: Run GREEN and native parity**

Run the commands from Step 2 plus:

```bash
node scripts/test-opencode-message-parts.mjs
node scripts/test-opencode-server-manager.mjs
```

Expected: PASS; native body deep-equality assertions remain byte-identical.

- [ ] **Step 5: Commit**

```bash
git add src/main/runtime/opencode-character-context.js src/main/runtime/opencode-message-parts.js src/main/runtime/opencode-server-manager.js scripts/test-character-context-injection.mjs scripts/test-character-agent-task-parity.mjs
git commit -m "feat: verify role application at final prompt boundary"
```

### Task 4: Runtime Application Event

**Files:**
- Modify: `src/shared/runtime-contract.json`
- Modify: `src/main/opencode-agent-session.js`
- Modify: `src/main/turn-orchestrator.js`
- Modify: `src/main/store/runtime-event-persistence.js`
- Modify: `scripts/test-runtime-event-schema.mjs`
- Modify: `scripts/test-character-worlds-capability-gate.mjs`
- Modify: `scripts/test-turn-orchestrator.mjs`

- [ ] **Step 1: Write failing event-contract tests**

Add `character.application` with required `status` and metadata-only optional properties. Assert payloads reject card text, unknown status/reason, oversized strings, or missing turn IDs.

- [ ] **Step 2: Run RED**

Run: `node scripts/test-runtime-event-schema.mjs`

Expected: FAIL because the event type is not registered.

- [ ] **Step 3: Emit final application evidence**

In `OpencodeAgentSession`, pass `onCharacterApplication` for initial dispatch and retries, then ingest:

```js
{ type: "character.application", payload: receipt }
```

The orchestrator forwards and persists the metadata event. Remove the misleading compile-only implication from `turn.started`; compile trace remains diagnostic but is not called applied.

- [ ] **Step 4: Run GREEN and replay checks**

Run:

```bash
node scripts/test-runtime-event-schema.mjs
node scripts/test-character-worlds-capability-gate.mjs
node scripts/test-turn-orchestrator.mjs
```

Expected: PASS with one application event per dispatch attempt and no card content in persistence.

- [ ] **Step 5: Commit**

```bash
git add src/shared/runtime-contract.json src/main/opencode-agent-session.js src/main/turn-orchestrator.js src/main/store/runtime-event-persistence.js scripts/test-runtime-event-schema.mjs scripts/test-character-worlds-capability-gate.mjs scripts/test-turn-orchestrator.mjs
git commit -m "feat: persist character application evidence"
```

### Task 5: Renderer Applied-State Projection

**Files:**
- Modify: `src/renderer/modules/session-runtime-store.js`
- Modify: `src/renderer/modules/character-control-model.js`
- Modify: `src/renderer/modules/character-session-control.js`
- Modify: `src/renderer/modules/character-binding-updates.js`
- Modify: `src/renderer/i18n/locales/zh-CN.json`
- Modify: `src/renderer/i18n/locales/en.json`
- Modify: `src/renderer/i18n/locales/ar.json`
- Modify: `scripts/test-character-session-control.mjs`
- Modify: `scripts/test-character-session-control.cjs`

- [ ] **Step 1: Write failing reducer and DOM tests**

Assert selection initially renders “selected”; `character.application/applied` changes it to “role active”; `bypassed` renders a quiet native-fallback state; stale session/turn/revision events cannot change the current conversation row.

- [ ] **Step 2: Run RED**

Run:

```bash
node scripts/test-character-session-control.mjs
npx electron scripts/test-character-session-control.cjs
```

Expected: FAIL because control state has no application projection.

- [ ] **Step 3: Project runtime evidence into the existing role row**

Add a bounded `application` object to control state. Subscribe through the existing runtime-store notification mechanism; never add a floating banner or a second role card. Keep the existing compact row below the composer and update its text/accessible label only.

- [ ] **Step 4: Run GREEN**

Run the two commands from Step 2.

Expected: PASS in Chinese, English, Arabic, stale-session, and unavailable-mode cases.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/modules/session-runtime-store.js src/renderer/modules/character-control-model.js src/renderer/modules/character-session-control.js src/renderer/modules/character-binding-updates.js src/renderer/i18n/locales/zh-CN.json src/renderer/i18n/locales/en.json src/renderer/i18n/locales/ar.json scripts/test-character-session-control.mjs scripts/test-character-session-control.cjs
git commit -m "feat: show verified character application state"
```

### Task 6: Top-Tier Lily Character Authoring Contract

**Files:**
- Modify: `src/main/character-worlds/agent-draft-tools.js`
- Modify: `scripts/test-character-agent-draft.mjs`
- Modify: `scripts/test-character-authoring-intent.mjs`

- [ ] **Step 1: Write failing authoring-contract checks**

Require the broker description to demand identity, relationship, background,
personality, expertise/worldview, decision principles, voice, response
patterns, emotional behavior, boundaries, positive/negative examples, opening,
and long-term consistency when the target schema supports them. Assert it does
not require forms or expose canonical field names to users.

- [ ] **Step 2: Run RED**

Run: `node scripts/test-character-agent-draft.mjs && node scripts/test-character-authoring-intent.mjs`

Expected: FAIL on the missing quality facets.

- [ ] **Step 3: Strengthen only the host tool description**

Keep the same validated canonical schema and authoring service. Do not add a
second model call, auto-bind drafts, or create Markdown/JSON files.

- [ ] **Step 4: Run GREEN**

Run the commands from Step 2.

Expected: PASS with existing metadata-only, approval, provenance, and
validation tests unchanged.

- [ ] **Step 5: Commit**

```bash
git add src/main/character-worlds/agent-draft-tools.js scripts/test-character-agent-draft.mjs scripts/test-character-authoring-intent.mjs
git commit -m "feat: require complete Lily-authored character designs"
```

### Task 7: Full Capability Gate And Release Evidence

**Files:**
- Modify: `CAPABILITY-GATE.md`
- Modify: `scripts/test-character-agent-task-parity.mjs`
- Create: `scripts/test-character-role-behavior-eval.mjs`

- [ ] **Step 1: Add the regression registry and behavior-eval harness**

Register the exact vector: selected role is present but model treats it as
inactive data. The deterministic parity test must compare native and role
request bodies for tools, files, model, user parts, and protected Lily prefix.
The opt-in live eval asks “Who are you?” and one complex task for the native,
Chief Architect, Strategy Advisor, and relationship-role cases.

- [ ] **Step 2: Run focused verification**

```bash
node scripts/test-character-role-activation-contract.mjs
node scripts/test-character-context-compiler.mjs
node scripts/test-character-context-injection.mjs
node scripts/test-character-agent-task-parity.mjs
node scripts/test-character-worlds-capability-gate.mjs
node scripts/test-runtime-event-schema.mjs
node scripts/test-turn-orchestrator.mjs
node scripts/test-character-agent-draft.mjs
npx electron scripts/test-character-session-control.cjs
```

Expected: every command exits 0.

- [ ] **Step 3: Run complete project verification**

Run: `npm run test:unit`

Expected: exit 0 with no product-relevant failures. Environment skips must be
listed and must not cover Character Worlds, OpenCode request composition,
runtime events, or renderer projection.

- [ ] **Step 4: Run live behavior evaluation when credentials are available**

Run: `LILY_RUN_LIVE_MODEL_EVAL=1 node scripts/test-character-role-behavior-eval.mjs`

Expected: each role answers identity correctly, role outputs are materially
distinct, and complex-task capability parity passes. If credentials are not
available, report the eval as unverified and do not call the release complete.

- [ ] **Step 5: Review diff and commit the gate**

```bash
git diff --check
git status --short
git add CAPABILITY-GATE.md scripts/test-character-agent-task-parity.mjs scripts/test-character-role-behavior-eval.mjs
git commit -m "test: gate verified character role activation"
```

## Completion Criteria

- A selected character is the active conversational identity.
- “Who are you?” resolves to the active role on supported production models.
- Role expression is explicit for all three profiles.
- Native prompt bytes and agent capabilities remain unchanged.
- Final request evidence, not selection, drives the applied UI state.
- Card data never gains host authority or leaks into traces.
- Existing immutable revisions remain compatible.
- Focused, full-suite, renderer, isolation, and live behavioral evidence are recorded.
