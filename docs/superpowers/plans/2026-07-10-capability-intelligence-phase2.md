# Capability Intelligence Phase 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Harden the existing capability-grading stack so strong models never inherit a weaker runtime by mistake, while lite models receive additive execution support that helps them finish real work.

**Architecture:** Keep the existing probe → compatibility profile → environment → SessionRunnerPool pipeline. Make destructive decisions require confirmed evidence, keep every official-history result tied to the current prompt, pass real session context into the tool broker, and turn the model eval into an enforceable gate. No new UI or second orchestrator is introduced.

**Tech Stack:** Electron main process, CommonJS Node.js modules, `.mjs` assertion tests, OpenCode shared server, MCP stdio servers.

---

### Task 1: Current-turn integrity and complete recovery wiring

**Files:**
- Modify: `src/main/runtime/opencode-server-manager.js`
- Modify: `src/main/opencode-agent-session.js`
- Modify: `src/main/turn-orchestrator.js`
- Modify: `scripts/test-opencode-server-manager.mjs`
- Modify: `scripts/test-opencode-agent-session.mjs`
- Modify: `scripts/test-subtask-resilience.mjs`

- [x] **Step 1: Write failing status tests**

Extend `scripts/test-opencode-server-manager.mjs` so a missing status row and a thrown status request are unknown, never idle:

```js
manager._sdkSession = { status: async () => ({}) };
assert.equal(await manager.getSessionStatus(), "unknown");
assert.equal(await manager.isSessionIdle(), false);
manager._sdkSession = { status: async () => { throw new Error("offline"); } };
assert.equal(await manager.getSessionStatus(), "unknown");
assert.equal(await manager.isSessionIdle(), false);
```

- [x] **Step 2: Write a failing stale-history regression**

Add a turn to `scripts/test-opencode-agent-session.mjs` whose official history contains a previous assistant answer inside the old ten-second time window plus the current user prompt and current assistant answer. Assert final synchronization selects only the assistant message ranked after the matching current user prompt. Add a second case where only the previous assistant exists and assert the live current output is preserved.

```js
assert.equal(orch.calls.done[0].output, "CURRENT ANSWER");
assert.notEqual(orch.calls.done[0].output, "PREVIOUS ANSWER");
```

- [x] **Step 3: Write a failing runner-error self-heal test**

Extend `scripts/test-subtask-resilience.mjs`: start a new parent turn, emit a healable runner `error`, wait for the async recovery hook, and assert `attemptModelSelfHeal` receives the classified code exactly once. Emit a non-healable error and assert no additional call.

```js
runner.emit("error", "Error: empty response from upstream gateway");
await new Promise((resolve) => setTimeout(resolve, 20));
assert.equal(selfHealCalls.at(-1).code, "RESPONSE_ERROR");
```

- [x] **Step 4: Run the three tests and verify RED**

Run:

```bash
PATH=/Users/zhangqin/.nvm/versions/node/v22.19.0/bin:$PATH node scripts/test-opencode-server-manager.mjs
PATH=/Users/zhangqin/.nvm/versions/node/v22.19.0/bin:$PATH node scripts/test-opencode-agent-session.mjs
PATH=/Users/zhangqin/.nvm/versions/node/v22.19.0/bin:$PATH node scripts/test-subtask-resilience.mjs
```

Expected: failures for unknown status, stale final-history replacement, and missing parent runner-error self-heal.

- [x] **Step 5: Implement tri-state status**

Add `getSessionStatus()` and make the boolean compatibility method conservative:

```js
async getSessionStatus() {
  if (!this.sessionID || !this._sdkSession?.status) return "unknown";
  try {
    const item = (await this._sdkSession.status())?.[this.sessionID];
    if (!item) return "unknown";
    return item.type === "idle" ? "idle" : "busy";
  } catch (err) {
    log.warn("session status check failed (%s); status unknown", err?.message || err);
    return "unknown";
  }
}

async isSessionIdle() {
  return (await this.getSessionStatus()) === "idle";
}
```

Change safety-critical `opencode-agent-session.js` catch/default branches from `idle = true` to `idle = false` so an unavailable status endpoint cannot resend or prematurely settle a turn.

- [x] **Step 6: Anchor every final history read to the current prompt**

Use the existing anchor instead of the time-only fallback:

```js
latest = await this._latestAssistantFromOfficialHistory({ requireCurrentPrompt: true });
```

Apply the same rule to stalled-final recovery. If the current prompt is absent from official history, preserve the live buffer rather than borrowing another turn.

- [x] **Step 7: Wire the parent runner error path into existing recovery**

After finalizing and recording diagnostics in `_handleError`, invoke the same recovery function already used by terminal failures:

```js
void this._maybeSelfHealAndRetry(sessionId, classified);
```

Keep the existing side-effect guard and one-retry limits unchanged.

- [x] **Step 8: Run the three tests and verify GREEN**

Run the commands from Step 4. Expected: all three exit 0.

### Task 2: Strong-model no-downgrade evidence rules

**Files:**
- Modify: `src/main/model-compatibility-probe.js`
- Modify: `src/main/model-presets.js`
- Modify: `src/main/session-runner-pool.js`
- Modify: `scripts/test-model-compatibility-probe.mjs`
- Modify: `scripts/test-capability-grading.mjs`

- [x] **Step 1: Write failing prompt-ceiling and lite-confidence tests**

Add these cases to `scripts/test-model-compatibility-probe.mjs`:

```js
// A 5k guide succeeding against an ample endpoint proves no 5k ceiling.
assert.equal(result.profile.prompt, undefined);

// One auto-tool miss followed by a transport error is ambiguous, not lite.
assert.equal(result.profile.capability.grade, "standard");

// Two successful no-call responses are confirmed lite evidence.
assert.equal(result.profile.capability.confidence, "confirmed");
```

Update the expected profile version from 5 to 6.

- [x] **Step 2: Write failing runtime no-downgrade tests**

In `scripts/test-capability-grading.mjs`, add an old/unconfirmed lite fixture and assert it emits no destructive lite grade. Add a confirmed-lite fixture and keep the existing lite assertions.

```js
assert.equal(modelPresets.getUserApiEnv().LILY_MODEL_CAPABILITY_GRADE, undefined);
```

Override `_opencodeBasePersona()` to return an empty string and assert `SessionRunnerPool.ensure()` throws `LILY_BASE_PERSONA_UNAVAILABLE` rather than launching OpenCode's coding-CLI persona.

- [x] **Step 3: Run both tests and verify RED**

Run:

```bash
PATH=/Users/zhangqin/.nvm/versions/node/v22.19.0/bin:$PATH node scripts/test-model-compatibility-probe.mjs
PATH=/Users/zhangqin/.nvm/versions/node/v22.19.0/bin:$PATH node scripts/test-capability-grading.mjs
```

Expected: failures for the artificial prompt cap, missing confidence, unconfirmed-lite downgrade, and empty persona fallback.

- [x] **Step 4: Store only observed prompt limits**

In `probeSystemPromptProfile`, do not record `source.length` as a ceiling when the first successful candidate is larger than the source:

```js
if (result.ok && result.shape?.hasContent) {
  if (source.length <= systemChars) return null;
  return { systemMaxChars: systemChars };
}
```

Treat a current-version profile as current even when no prompt ceiling was observed, so ample models are not re-probed continuously.

- [x] **Step 5: Require confirmed evidence for destructive lite behavior**

Count successful no-call auto-tool probes. A failed/ambiguous alternate probe produces `standard`; two successful no-call responses produce:

```js
{
  grade: "lite",
  confidence: "confirmed",
  signals: { instructionFidelity, toolChoiceAuto: false }
}
```

Normalize and persist `confidence`. An old `lite` profile without `confidence:"confirmed"` must emit no `LILY_MODEL_CAPABILITY_GRADE`. Bump `PROBE_PROFILE_VERSION` to 6 so stored profiles re-probe.

- [x] **Step 6: Refuse the weak OpenCode persona fallback**

Resolve `basePrompt` before building shared config. If it is empty, remove a newly-created runner from the map and throw:

```js
throw new Error("LILY_BASE_PERSONA_UNAVAILABLE");
```

If `buildSharedBaseConfig` returns `ok:false`, throw `OPENCODE_CONFIG_INVALID:<reason>` instead of starting with `opencodeConfig:""`.

- [x] **Step 7: Run both tests and verify GREEN**

Run the commands from Step 3. Expected: both exit 0.

### Task 3: Additive lite-model execution support

**Files:**
- Modify: `src/main/session-runner-pool.js`
- Modify: `src/main/mcp-config.js`
- Modify: `src/main/context-budget-manager.js`
- Modify: `scripts/test-capability-grading.mjs`
- Modify: `scripts/test-mcp-config.mjs`
- Modify: `scripts/test-context-budget-manager.mjs`

- [x] **Step 1: Write a failing lite execution-protocol test**

In `scripts/test-capability-grading.mjs`, call `_appendModelRecipeHints` with a lite grade and assert a compact additive protocol is present, while full/standard guidance remains byte-identical:

```js
const liteGuide = pool._appendModelRecipeHints(guide, {
  LILY_MODEL_CAPABILITY_GRADE: "lite",
  LILY_MODEL_RECIPES: "{}",
});
assert.match(liteGuide, /Execution Protocol \(lite support\)/);
assert.match(liteGuide, /one verified step at a time/i);
assert.equal(pool._appendModelRecipeHints(guide, { LILY_MODEL_CAPABILITY_GRADE: "full" }), guide);
```

- [x] **Step 2: Write a failing broker-context test**

In `scripts/test-mcp-config.mjs`, call `writeActiveMcpConfig` without mutating global environment variables and assert the broker entry contains the real session and active skills:

```js
writeActiveMcpConfig(full, out, ["lily-runtime-packs"], { sessionId: "s1" });
assert.deepEqual(JSON.parse(entry.env.LILY_TOOL_BROKER_CONTEXT), {
  sessionId: "s1",
  activeSkillIds: ["lily-runtime-packs"],
});
```

- [x] **Step 3: Write a failing next-turn pressure test**

In `scripts/test-context-budget-manager.mjs`, use previous=60,000 and current=20,000 in a 100,000-token window and assert the estimate is 80,000 and compaction triggers.

```js
assert.equal(decision.estimatedPromptTokens, 80_000);
assert.equal(decision.action, "compact");
```

- [x] **Step 4: Run the three tests and verify RED**

Run:

```bash
PATH=/Users/zhangqin/.nvm/versions/node/v22.19.0/bin:$PATH node scripts/test-capability-grading.mjs
PATH=/Users/zhangqin/.nvm/versions/node/v22.19.0/bin:$PATH node scripts/test-mcp-config.mjs
PATH=/Users/zhangqin/.nvm/versions/node/v22.19.0/bin:$PATH node scripts/test-context-budget-manager.mjs
```

Expected: failures for the missing lite protocol, missing production broker context, and undercounted prompt pressure.

- [x] **Step 5: Add the compact lite execution protocol**

Append only for confirmed lite models:

```js
lines.push(
  "## Execution Protocol (lite support)",
  "",
  "- Work one verified step at a time. Call one tool, read its result, then choose the next step.",
  "- Use lily_tool_broker to discover platform capability before claiming a task is unavailable.",
  "- Keep going until the requested deliverable is verified; report a concrete blocker instead of stopping early."
);
```

Keep the section below 700 characters and title it as a protocol so the existing section-aware truncator preserves it.

- [x] **Step 6: Pass explicit context into the broker without breaking shared-serve isolation**

Change `buildToolBrokerMcpEntry(context)` to serialize an explicit context rather than reading a process-global variable, and extend `writeActiveMcpConfig(..., context)`. Isolated/external callers can pass `{ sessionId, activeSkillIds }`; the app-wide OpenCode stdio transport cannot, because MCP calls carry no originating Lily-session metadata and its config participates in `serveSignature`. `SessionRunnerPool._opencodeMcpServers` therefore passes stable `{ platformOnly: true, activeSkillIds: [] }`, preventing both cross-session context leakage and one serve signature per conversation. Preserve the old environment fallback only for compatibility with callers that omit the explicit argument.

- [x] **Step 7: Estimate the next prompt as history plus current input**

Replace `Math.max(previous,current)` with non-negative addition:

```js
const estimatedPromptTokens =
  Math.max(0, Number.isFinite(previousTokens) ? previousTokens : 0) +
  Math.max(0, Number.isFinite(currentTokens) ? currentTokens : 0);
```

- [x] **Step 8: Run the three tests and verify GREEN**

Run the commands from Step 4. Expected: all three exit 0.

### Task 4: Make “never get dumber” an enforceable release gate

**Files:**
- Create: `scripts/eval/model-eval-policy.mjs`
- Create: `scripts/test-model-eval-policy.mjs`
- Modify: `scripts/eval/run-model-evals.mjs`
- Modify: `CAPABILITY-GATE.md`
- Modify: `docs/capability-grading-plan.md`

- [x] **Step 1: Write a failing pure policy test**

Create `scripts/test-model-eval-policy.mjs` with assertions for:

```js
assert.equal(evaluateModelEval({ results: { a: { pass: false } }, baseline: null }).exitCode, 2);
assert.equal(evaluateModelEval({ results: { a: { pass: false } }, baseline: { results: { a: { pass: true } } } }).exitCode, 1);
assert.equal(evaluateModelEval({ results: { a: { pass: false } }, baseline: null, onlyCase: "a" }).exitCode, 1);
assert.equal(evaluateModelEval({ results: { a: { pass: true } }, baseline: { results: { a: { pass: true } } } }).exitCode, 0);
```

Also assert the current eval source uses `buildSharedBaseConfig` with `buildAgentBasePersona`, so the eval cannot accidentally test OpenCode's coding-CLI persona instead of Lily.

- [x] **Step 2: Run the policy test and verify RED**

Run:

```bash
PATH=/Users/zhangqin/.nvm/versions/node/v22.19.0/bin:$PATH node scripts/test-model-eval-policy.mjs
```

Expected: module missing or assertions fail.

- [x] **Step 3: Implement deterministic exit policy**

Export a pure helper:

```js
export function evaluateModelEval({ results, baseline, onlyCase = "", updateBaseline = false }) {
  const failedCases = Object.entries(results || {}).filter(([, value]) => !value?.pass).map(([id]) => id);
  if (onlyCase) return { exitCode: failedCases.length ? 1 : 0, failedCases, regressions: [] };
  if (!baseline && !updateBaseline) return { exitCode: 2, failedCases, regressions: [], missingBaseline: true };
  const regressions = Object.entries(baseline?.results || {})
    .filter(([id, prev]) => prev?.pass && results?.[id] && !results[id].pass)
    .map(([id]) => id);
  return { exitCode: regressions.length ? 1 : 0, failedCases, regressions };
}
```

Use it from `run-model-evals.mjs`; missing baselines must no longer print success.

- [x] **Step 4: Run the full Lily shared-config path in live evals**

Replace the direct `resolveOpencodeModelConfig` call with `buildSharedBaseConfig` and the real Lily persona:

```js
const { buildSharedBaseConfig } = require("../../src/main/runtime/opencode-config-builder.js");
const { buildAgentBasePersona } = require("../../src/main/skill-manager.js");
const cfg = buildSharedBaseConfig({ lilyEnv, basePrompt: buildAgentBasePersona() });
```

Strengthen the Chinese identity case so a coding-only CLI identity fails.

- [x] **Step 5: Register every intelligence guard**

Add a CAPABILITY-GATE row covering:

```markdown
| Model grading or recovery makes the selected model less capable, repeats side effects, or loses the current turn | `test-capability-grading.mjs` + `test-model-compatibility-probe.mjs` + `test-model-self-heal.mjs` + `test-tool-call-rescue.mjs` + `test-subtask-resilience.mjs` + `test-opencode-agent-session.mjs` + `test-model-eval-policy.mjs` — destructive lite behavior requires confirmed repeated evidence; full/standard remain byte-identical; recovery is current-turn anchored and side-effect guarded; evals require a baseline and Lily persona |
```

Update `docs/capability-grading-plan.md` from “real eval gate missing” to distinguish automated gate completion from credentials-dependent live baseline runs.

- [x] **Step 6: Run the policy test and focused intelligence suite**

Run:

```bash
PATH=/Users/zhangqin/.nvm/versions/node/v22.19.0/bin:$PATH node scripts/test-model-eval-policy.mjs
PATH=/Users/zhangqin/.nvm/versions/node/v22.19.0/bin:$PATH node scripts/test-capability-grading.mjs
PATH=/Users/zhangqin/.nvm/versions/node/v22.19.0/bin:$PATH node scripts/test-model-compatibility-probe.mjs
PATH=/Users/zhangqin/.nvm/versions/node/v22.19.0/bin:$PATH node scripts/test-model-self-heal.mjs
PATH=/Users/zhangqin/.nvm/versions/node/v22.19.0/bin:$PATH node scripts/test-tool-call-rescue.mjs
PATH=/Users/zhangqin/.nvm/versions/node/v22.19.0/bin:$PATH node scripts/test-subtask-resilience.mjs
```

Expected: all exit 0.

### Final verification

- [x] Run `PATH=/Users/zhangqin/.nvm/versions/node/v22.19.0/bin:$PATH npm run test:unit`; verified `381/381 passed` in 162 seconds.
- [x] Run `git diff --check`; expect no output.
- [x] Run `git status --short`; inspect every changed file and confirm no unrelated edits.
- [x] Live eval credential check completed: `LILY_EVAL_BASE_URL`, `LILY_EVAL_API_KEY`, and `LILY_EVAL_MODEL` are unavailable, so live model behavior remains explicitly unverified.
