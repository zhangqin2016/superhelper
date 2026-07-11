# Discard-Sink Work Progress Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop false `Download: nul` progress notices and hide already archived copies while preserving every legitimate download and the strong-model execution path.

**Architecture:** Normalize recognized discard targets inside the existing main-process progress inference before any notice is created. Add a sealed-history-only renderer compatibility predicate for old records, with protocol, reducer, and timeline tests proving both suppression and fail-open positive controls.

**Tech Stack:** Electron main process, CommonJS runtime reducer, renderer ES modules, existing `scripts/test-*.mjs` and Electron renderer regression harness.

---

## File Map

- Modify `src/main/work-progress-protocol.js`: recognize platform-specific discard output targets before command-level progress classification.
- Modify `src/renderer/modules/turn-process-timeline-model.js`: hide only legacy sealed discard-sink notices.
- Modify `scripts/test-work-progress-protocol.mjs`: cover discard sinks and legitimate output controls.
- Modify `scripts/test-opencode-runtime-reducer.mjs`: prove a Windows null-sink probe emits no progress notice.
- Modify `scripts/test-turn-process-timeline-model.mjs`: prove legacy cleanup is sealed-only and precise.
- Modify `CAPABILITY-GATE.md`: extend the existing foreground transfer guard with this regression vector.

### Task 1: Protocol classification

- [x] Add failing assertions showing Windows `NUL`/`NUL:`, POSIX `/dev/null`, and Windows PowerShell `$null` are not artifact output targets, plus positive controls for the literal POSIX filename `null`:

```js
const discardedCommands = [
  ['curl.exe -sS https://example.com/health >nul 2>&1', { platform: "win32" }],
  ['curl.exe -sS -o NUL: https://example.com/health', { platform: "win32" }],
  ['curl -sS https://example.com/health >/dev/null 2>&1', { platform: "linux" }],
  ['curl.exe -sS https://example.com/health >$null', { platform: "win32" }],
];
for (const [input, options] of discardedCommands) {
  assert(inferWorkProgressFromCommand(input, options) === null, `discard sink must not be a download: ${input}`);
}

const literalNull = inferWorkProgressFromCommand(
  'curl -L -o null "https://example.com/archive.zip"',
  { platform: "linux" },
);
assertEqual(literalNull.path, "null", "ordinary POSIX filename null remains valid");
```

- [x] Keep the existing `/tmp/blender.dmg` and `curl -O` assertions as positive controls.
- [x] Run `node scripts/test-work-progress-protocol.mjs` and confirm failure is caused by the missing discard-sink semantics.
- [x] Add the smallest normalization helper and optional platform override to `inferWorkProgressFromCommand()`:

```js
function isDiscardOutputTarget(value = "", { platform = process.platform, command = "" } = {}) {
  const normalized = String(value || "").trim().replace(/\\/g, "/").toLowerCase();
  if (!normalized) return false;
  if (normalized === "/dev/null") return true;
  const windowsShaped = platform === "win32" ||
    /\b(?:curl|wget|aria2c|rsync|rclone|scp)\.exe\b/i.test(command);
  if (!windowsShaped) return false;
  return normalized === "$null" || /^nul:?$/.test(normalized);
}
```

Change command inference to compute `rawOutput`, normalize it, and let the existing curl no-output guard return `null`:

```js
function inferWorkProgressFromCommand(command = "", options = {}) {
  const text = String(command || "").trim();
  if (!text) return null;
  const lower = text.toLowerCase();
  const usesCurl = /\bcurl(?:\.exe)?\b/.test(lower);
  const usesTransferTool = /\b(wget|aria2c|rsync|rclone|scp)\b/.test(lower);
  if (!usesCurl && !usesTransferTool) return null;
  const url = text.match(/https?:\/\/[^\s"'`]+/i)?.[0] || "";
  const flagOutput =
    text.match(/(?:^|\s)(?:-o|--output)\s+(?:"([^"]+)"|'([^']+)'|([^\s|;&<>]+))/)?.slice(1).find(Boolean) ||
    "";
  const remoteName = /(?:^|\s)(?:-O|--remote-name)(?=\s|$)/.test(text);
  const rawOutput = flagOutput || extractStdoutRedirectTarget(text);
  const output = isDiscardOutputTarget(rawOutput, { ...options, command: text }) ? "" : rawOutput;
  const upload = /\b(upload|put|scp|rsync|rclone\s+copyto?)\b/i.test(text);
  if (usesCurl && !upload && !output && !remoteName) return null;
  return {
    source: "command",
    domain: upload ? "upload" : "download",
    phase: upload ? "uploading" : "downloading",
    label: upload ? "Upload" : "Download",
    path: output || "",
    fromUrl: url || "",
  };
}
```

- [x] Re-run the protocol test and confirm it passes.

### Task 2: Runtime event boundary

- [x] Add a failing reducer fixture for `curl.exe ... >nul 2>&1` and assert it keeps exactly one ordinary tool draft:

```js
const curlNulProbeState = createOpencodeRuntimeState();
const curlNulProbe = reduce("message.part.updated", {
  part: {
    type: "tool",
    tool: "bash",
    callID: "curl_probe_nul",
    state: {
      status: "running",
      input: { command: "curl.exe -sS https://example.com/health >nul 2>&1" },
    },
  },
}, curlNulProbeState);
assert(curlNulProbe.drafts.length === 1, `null-sink probe should keep only the tool row: ${JSON.stringify(curlNulProbe.drafts)}`);
assert(curlNulProbe.drafts[0].type === "tool.started", "null-sink probe still starts as a normal tool");
assert(!curlNulProbe.drafts.some((draft) => draft.payload?.notice?.code === "workProgress"), "null-sink probe emits no fake progress notice");
```

- [x] Run `node scripts/test-opencode-runtime-reducer.mjs` and confirm the assertion fails before production code is changed.
- [x] Re-run after the protocol implementation and confirm the reducer boundary passes without reducer-specific branching.

### Task 3: Existing conversation compatibility

- [x] Add failing sealed-timeline assertions for archived discard notices and positive controls:

```js
const legacyDiscardTurn = {
  timeline: [
    { kind: "notice", id: "nul", code: "workProgress", level: "progress", detail: "Download: nul" },
    { kind: "notice", id: "nul_colon", code: "workProgress", level: "progress", detail: "Download: NUL:" },
    { kind: "notice", id: "dev_null", code: "workProgress", level: "progress", detail: "Download: /dev/null" },
    { kind: "notice", id: "ps_null", code: "workProgress", level: "progress", detail: "Download: $null" },
    { kind: "notice", id: "literal_null", code: "workProgress", level: "progress", detail: "Download: null" },
    { kind: "notice", id: "real", code: "workProgress", level: "progress", detail: "Download: /tmp/archive.zip" },
  ],
};
assert.deepEqual(
  timelineForProcessView(legacyDiscardTurn, true).map((entry) => entry.id),
  ["literal_null", "real"],
  "sealed history hides only exact legacy discard-sink notices",
);
assert.equal(
  timelineForProcessView({ timeline: [legacyDiscardTurn.timeline[0]] }, false).length,
  1,
  "live progress is not removed by the legacy compatibility filter",
);
```

- [x] Run `node scripts/test-turn-process-timeline-model.mjs` and confirm the legacy entries are currently retained.
- [x] Add a private legacy predicate to `turn-process-timeline-model.js` and apply it only when `sealed` is true:

```js
function isLegacyDiscardSinkProgress(entry = {}) {
  if (
    entry.kind !== "notice" ||
    entry.code !== "workProgress" ||
    entry.level !== "progress" ||
    entry.progress
  ) return false;
  const detail = String(entry.detail || "");
  if (!detail.startsWith("Download: ")) return false;
  const target = detail.slice("Download: ".length);
  return target === "/dev/null" || /^(?:nul:?|\$null)$/i.test(target);
}
```

Add the predicate to the existing `timelineForProcessView()` filter before the liveness branch. Positive controls must retain `/DEV/NULL`, `NUL.txt`, missing/double-space details, structured progress, live progress, and `info`/`error` levels. Malformed or non-matching entries return false and keep today's behavior.

- [x] Re-run the timeline-model test and confirm all controls pass.

### Task 4: Capability gate and verification

- [x] Update the existing foreground upload/download row in `CAPABILITY-GATE.md` to name discard-sink suppression and legacy sealed-history cleanup.
- [x] Run the three focused tests together.
- [x] Run `npx electron scripts/test-renderer-import.cjs` and inspect its exit code and relevant regression output.
- [x] Run `npm run test:unit` as the project-wide no-regression gate.
- [x] Review `git diff --check`, the scoped diff, and `git status --short` to ensure unrelated user changes remain untouched.
