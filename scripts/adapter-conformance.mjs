// Engine-agnostic adapter conformance harness (M6). Any runtime adapter —
// Claude CLI today, Qwen Code or others tomorrow — must pass this exam before
// it can sit behind AgentSession. The invariants are about the adapter's
// OUTPUT contract, never about engine-specific wire shapes:
//
//   1. Identity: a name and a frozen boolean capability declaration.
//   2. Every runtime event draft has a schema-known type and an object payload.
//   3. Delta payload shapes hold (text deltas carry strings, tool ids are
//      strings, tool.started carries a name).
//   4. Hostile input never throws — null, junk types, deep garbage all come
//      back as normal results with warnings/unknown events, not exceptions.
//   5. Unknown events stay VISIBLE (warning or protocol.unknown draft),
//      never silently dropped.
//   6. Determinism: the same event normalizes to the same output.
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { RUNTIME_EVENT_TYPES } = require("../src/main/runtime-event-schema.js");

const REQUIRED_CAPABILITIES = [
  "streamInput",
  "emitsThinking",
  "hotEnvUpdate",
  "permissionControl",
  "resume",
];

const HOSTILE_EVENTS = [
  null,
  undefined,
  {},
  { type: "" },
  { type: 42 },
  { type: "completely_unknown_event_type", payload: { deep: { junk: [1, null, {}] } } },
  { type: "stream_event" },
  { type: "stream_event", event: null },
  { type: "stream_event", event: { type: "no_such_block_event" } },
  { type: "control_request" },
  { type: "result" },
  { type: "user", message: "not-an-object-content" },
];

/**
 * @param {{ name: string, capabilities: object, normalizeEvent: (ev: any) => any }} adapter
 * @param {object[]} transcriptEvents real engine events (fixture replay)
 * @returns {{ ok: boolean, failures: string[], stats: object }}
 */
export function runAdapterConformance(adapter, transcriptEvents) {
  const failures = [];
  const note = (msg) => failures.push(msg);

  // 1. Identity & capabilities
  if (!adapter?.name || typeof adapter.name !== "string") {
    note("adapter must declare a string name");
  }
  if (!adapter?.capabilities || typeof adapter.capabilities !== "object") {
    note("adapter must declare a capabilities object");
  } else {
    for (const cap of REQUIRED_CAPABILITIES) {
      if (typeof adapter.capabilities[cap] !== "boolean") {
        note(`capabilities.${cap} must be declared as a boolean`);
      }
    }
    if (!Object.isFrozen(adapter.capabilities)) {
      note("capabilities must be frozen (declaration, not mutable state)");
    }
  }

  let drafts = 0;
  let warnings = 0;

  const checkResult = (result, source) => {
    if (!result || typeof result !== "object") {
      note(`${source}: normalizeEvent must return an object`);
      return;
    }
    if (!Array.isArray(result.runtimeEvents)) {
      note(`${source}: result.runtimeEvents must be an array`);
      return;
    }
    warnings += Array.isArray(result.warnings) ? result.warnings.length : 0;
    for (const draft of result.runtimeEvents) {
      drafts += 1;
      if (!RUNTIME_EVENT_TYPES.has(draft?.type)) {
        note(`${source}: unknown runtime event type "${draft?.type}"`);
        continue;
      }
      if (!draft.payload || typeof draft.payload !== "object") {
        note(`${source}: ${draft.type} payload must be an object`);
        continue;
      }
      const p = draft.payload;
      if ((draft.type === "assistant.delta" || draft.type === "assistant.thinking.delta") &&
          typeof p.text !== "string") {
        note(`${source}: ${draft.type} must carry a string text`);
      }
      if (draft.type === "tool.started") {
        if (typeof p.id !== "string") note(`${source}: tool.started id must be a string`);
        if (typeof p.name !== "string" || !p.name) note(`${source}: tool.started must carry a name`);
      }
      if (draft.type === "tool.input.delta" && typeof p.partialJson !== "string") {
        note(`${source}: tool.input.delta must carry string partialJson`);
      }
      if (draft.type === "tool.done" && p.id != null && typeof p.id !== "string") {
        note(`${source}: tool.done id must be a string when present`);
      }
    }
  };

  // 2-3. Real transcript replay
  for (const [index, event] of transcriptEvents.entries()) {
    try {
      checkResult(adapter.normalizeEvent(event), `transcript[${index}] ${event?.type || "?"}`);
    } catch (error) {
      note(`transcript[${index}]: normalizeEvent threw: ${error?.message || error}`);
    }
  }

  // 4-5. Hostile input battery
  for (const [index, event] of HOSTILE_EVENTS.entries()) {
    let result;
    try {
      result = adapter.normalizeEvent(event);
    } catch (error) {
      note(`hostile[${index}]: normalizeEvent threw: ${error?.message || error}`);
      continue;
    }
    checkResult(result, `hostile[${index}]`);
  }

  // Unknown events must surface, not vanish.
  try {
    const unknown = adapter.normalizeEvent({ type: "completely_unknown_event_type" });
    const visible =
      (unknown?.warnings?.length || 0) > 0 ||
      (unknown?.runtimeEvents || []).some(
        (d) => d.type === "protocol.unknown" || d.type === "engine.warning",
      );
    if (!visible) note("unknown event types must surface as a warning or protocol.unknown");
  } catch (error) {
    note(`unknown-event probe threw: ${error?.message || error}`);
  }

  // 6. Determinism
  const probe = transcriptEvents.find((e) => e && typeof e === "object") || { type: "result" };
  try {
    const a = JSON.stringify(adapter.normalizeEvent(probe).runtimeEvents);
    const b = JSON.stringify(adapter.normalizeEvent(probe).runtimeEvents);
    if (a !== b) note("normalizeEvent must be deterministic for the same event");
  } catch (error) {
    note(`determinism probe threw: ${error?.message || error}`);
  }

  return {
    ok: failures.length === 0,
    failures,
    stats: { transcriptEvents: transcriptEvents.length, drafts, warnings },
  };
}
