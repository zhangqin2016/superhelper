#!/usr/bin/env node
import assert from "node:assert/strict";

// Minimal DOM stub so we can exercise the chip logic without a browser.
globalThis.document = {
  createElement() {
    return {
      dataset: {},
      className: "",
      textContent: "",
      title: "",
      remove() {
        const p = this._parent;
        if (p) {
          const i = p.children.indexOf(this);
          if (i >= 0) p.children.splice(i, 1);
        }
      },
    };
  },
};
function makeHeader() {
  const children = [];
  return {
    children,
    querySelector(sel) {
      if (sel === '[data-role="memory-chip"]') return children.find((c) => c.dataset.role === "memory-chip") || null;
      return null;
    },
    append(el) {
      el._parent = this;
      children.push(el);
    },
  };
}

const { renderTurnMemoryChip } = await import("../src/renderer/modules/turn-memory-chip.js");

const usage = {
  used: true,
  count: 3,
  truncated: false,
  mode: "semantic",
  items: [
    { kind: "session_summary", label: "会话摘要", labelEn: "Session summary", scope: "session", reason: "continuity", source: "" },
    { kind: "project_memory", label: "工作区记忆", labelEn: "Workspace memory", scope: "workspace", reason: "curated", source: "MEMORY.md" },
    { kind: "learned_conventions", label: "学到的约定", labelEn: "Learned conventions", scope: "workspace", reason: "", source: "" },
  ],
};

// no header → null
assert.equal(renderTurnMemoryChip(null, { final: {}, memoryUsage: usage }), null, "no header → null");

// no memoryUsage → no chip
let header = makeHeader();
assert.equal(renderTurnMemoryChip(header, { final: {} }), null, "no memoryUsage → null");
assert.equal(header.children.length, 0, "no chip appended");

// present but NOT sealed (no final) → no chip
header = makeHeader();
assert.equal(renderTurnMemoryChip(header, { memoryUsage: usage }), null, "unsealed → null");
assert.equal(header.children.length, 0, "no chip on unsealed turn");

// sealed + semantic usage → chip created
header = makeHeader();
const chip = renderTurnMemoryChip(header, { final: { type: "turn.completed" }, memoryUsage: usage });
assert.ok(chip, "chip created");
assert.equal(header.children.length, 1, "one chip in header");
assert.equal(chip.dataset.role, "memory-chip");
assert.match(chip.className, /assistant-turn-memory-chip/);
assert.match(chip.className, /is-semantic/, "semantic mode adds accent class");
assert.ok(chip.textContent.length > 0, "chip has visible text");
assert.match(chip.title, /MEMORY\.md/, "tooltip lists the file source");
assert.match(chip.title, /会话摘要|Session summary/, "tooltip lists memory labels");
assert.match(chip.title, /•/, "tooltip is a bulleted list");

// re-render lexical → reuse element, drop accent class
const chip2 = renderTurnMemoryChip(header, { final: { type: "turn.completed" }, memoryUsage: { ...usage, mode: "lexical" } });
assert.equal(header.children.length, 1, "chip reused, not duplicated");
assert.doesNotMatch(chip2.className, /is-semantic/, "lexical mode has no accent class");

// usage gone on a later render → chip removed
const gone = renderTurnMemoryChip(header, { final: { type: "turn.completed" }, memoryUsage: null });
assert.equal(gone, null);
assert.equal(header.children.length, 0, "stale chip removed when memory no longer used");

console.log("turn-memory-chip: ok");
