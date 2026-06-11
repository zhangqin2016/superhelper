#!/usr/bin/env node
// Replay benchmark, main-process side (docs/turn-block-experience-plan.md M5).
//
// Two stages:
//   1. Adapter: every fixture event normalized repeatedly — realistic shapes.
//   2. Timeline: synthetic heavy turns through the block-timeline hot path.
//
// The primary gate is a SCALING assertion (4x the events must cost < 8x the
// time), which catches O(n²) regressions on any machine speed. Absolute
// ceilings are generous and only catch catastrophic constant-factor breaks.
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { CliEventAdapter } = require("../src/main/runtime/adapters/claude-cli-adapter.js");
const {
  appendTimelineText,
  closeStreamingBlocks,
  upsertTimelineThinking,
  upsertTimelineTool,
} = require("../src/main/turn-timeline.js");

function minOfRuns(fn, runs = 3) {
  let best = Infinity;
  for (let i = 0; i < runs; i += 1) {
    const t0 = performance.now();
    fn();
    best = Math.min(best, performance.now() - t0);
  }
  return best;
}

// --- Stage 1: adapter normalization over real fixture shapes ----------------
const fixtureDir = path.join(root, "fixtures/claude-runtime");
const fixtureEvents = [];
for (const file of fs.readdirSync(fixtureDir)) {
  if (!file.endsWith(".jsonl")) continue;
  for (const line of fs.readFileSync(path.join(fixtureDir, file), "utf-8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      fixtureEvents.push(JSON.parse(trimmed));
    } catch {
      // fixtures may contain comment lines
    }
  }
}
if (fixtureEvents.length < 20) {
  throw new Error(`expected fixture events, got ${fixtureEvents.length}`);
}

const adapter = new CliEventAdapter();
const ADAPTER_REPS = 200;
const adapterMs = minOfRuns(() => {
  for (let rep = 0; rep < ADAPTER_REPS; rep += 1) {
    for (const event of fixtureEvents) adapter.normalizeEvent(event);
  }
});
const adapterTotal = fixtureEvents.length * ADAPTER_REPS;
console.log(
  `adapter: ${adapterTotal} events in ${adapterMs.toFixed(0)}ms ` +
  `(${Math.round(adapterTotal / (adapterMs / 1000))} events/s)`,
);

// --- Stage 2: block-timeline hot path ---------------------------------------
// One "heavy turn": interleaved thinking/text deltas plus tool lifecycles,
// shaped like a long agentic coding turn.
function runHeavyTurn({ segments, deltasPerSegment, tools, inputDeltasPerTool }) {
  const state = { timeline: [], activityLabel: null, tools: new Map() };
  let toolSeq = 0;
  for (let seg = 0; seg < segments; seg += 1) {
    for (let i = 0; i < deltasPerSegment; i += 1) {
      upsertTimelineThinking(state, "推理片段，包含一些文字内容。", 1000 + seg);
    }
    for (let i = 0; i < deltasPerSegment; i += 1) {
      appendTimelineText(state, "正文增量，逐 token 渲染的文字。", 2000 + seg);
    }
    for (let t = 0; t < tools; t += 1) {
      const id = `tool_${++toolSeq}`;
      upsertTimelineTool(state, { id, name: "Bash", input: {}, status: "running" }, 3000 + seg);
      for (let d = 0; d < inputDeltasPerTool; d += 1) {
        upsertTimelineTool(state, { id, partialJson: `{"command":"step ${d}` }, 3001 + seg);
      }
      upsertTimelineTool(state, { id, status: "done", result: { content: "ok" } }, 3002 + seg);
    }
  }
  closeStreamingBlocks(state, 9999);
  return state.timeline.length;
}

const small = { segments: 8, deltasPerSegment: 120, tools: 6, inputDeltasPerTool: 10 };
const large = { segments: 32, deltasPerSegment: 120, tools: 6, inputDeltasPerTool: 10 }; // 4x segments

const smallMs = minOfRuns(() => runHeavyTurn(small));
const largeMs = minOfRuns(() => runHeavyTurn(large));
const entries = runHeavyTurn(large);
const ratio = largeMs / Math.max(smallMs, 0.5);
console.log(
  `timeline: small ${smallMs.toFixed(1)}ms, large(4x) ${largeMs.toFixed(1)}ms, ` +
  `ratio ${ratio.toFixed(1)}x, large turn entries ${entries}`,
);

// --- Gates -------------------------------------------------------------------
const failures = [];
// Near-linear pipeline: 4x events must stay well under quadratic (≈16x).
if (ratio > 8) failures.push(`timeline scaling ${ratio.toFixed(1)}x exceeds 8x for 4x events (quadratic regression?)`);
// Catastrophic constant-factor ceilings (generous for slow CI machines).
if (adapterMs > 10_000) failures.push(`adapter stage took ${adapterMs.toFixed(0)}ms (> 10s ceiling)`);
if (largeMs > 5_000) failures.push(`timeline large turn took ${largeMs.toFixed(0)}ms (> 5s ceiling)`);

if (failures.length) {
  console.error("bench-replay FAILED:\n" + failures.map((f) => `  - ${f}`).join("\n"));
  process.exit(1);
}
console.log("bench-replay: ok");
