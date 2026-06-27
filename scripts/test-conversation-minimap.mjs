#!/usr/bin/env node
// Closed-loop guard for the conversation minimap model: scope/depth filtering, outline
// flattening, terminus reachability, and active-rib tracking (incl. the bottom tail).

import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const {
  buildMinimapModel,
  computeActiveIndex,
  cycleDepth,
  nextScope,
} = await import("../src/renderer/modules/conversation-minimap-model.js");

function eq(a, b, msg) { if (a !== b) throw new Error(`${msg}: expected ${b}, got ${a}`); }

const items = [
  { role: "user", label: "帮我部署服务端" },
  {
    role: "assistant",
    label: "已完成服务端部署。",
    headings: [
      { level: 1, text: "本次做了" },
      { level: 2, text: "线上容器已切到" },
      { level: 3, text: "activePresetId" },
    ],
  },
  { role: "user", label: "再查一下历史会话问题" },
  { role: "assistant", label: "历史会话来源是合并的", headings: [{ level: 1, text: "风险点" }] },
];

// --- scope=all, depth=0 -> prompts + responses, NO headings --------------------
let m = buildMinimapModel(items, { scope: "all", depth: 0 });
eq(m.length, 4, "all/depth0 entry count");
eq(m.filter((e) => e.kind === "heading").length, 0, "all/depth0 has no headings");
eq(m[0].kind, "prompt", "first is a prompt");
eq(m[1].kind, "response", "second is a response");

// --- scope=all, depth=2 -> H1+H2 headings included, H3 excluded ---------------
m = buildMinimapModel(items, { scope: "all", depth: 2 });
const headings = m.filter((e) => e.kind === "heading");
eq(headings.length, 3, "all/depth2 heading count (H1,H2 of msg1 + H1 of msg2)");
if (headings.some((h) => h.level > 2)) throw new Error("depth2 must exclude H3");

// --- scope=all, depth=3 -> all headings ---------------------------------------
m = buildMinimapModel(items, { scope: "all", depth: 3 });
eq(m.filter((e) => e.kind === "heading").length, 4, "all/depth3 includes H3");

// --- scope=prompts -> only user prompts ---------------------------------------
m = buildMinimapModel(items, { scope: "prompts", depth: 3 });
eq(m.length, 2, "prompts scope shows only the 2 user prompts");
if (m.some((e) => e.kind !== "prompt")) throw new Error("prompts scope must contain only prompts");

// --- turnId passthrough (load-bearing for jump-to-turn) -----------------------
const withIds = buildMinimapModel(
  [{ role: "user", label: "Q1", turnId: "t-1" }, { role: "user", label: "Q2", turnId: "t-2" }],
  { scope: "prompts" },
);
eq(withIds[0].turnId, "t-1", "prompt rib carries its turnId");
eq(withIds[1].turnId, "t-2", "second prompt rib carries its turnId");

// --- terminus reachable -------------------------------------------------------
m = buildMinimapModel(items, { scope: "all", depth: 0, terminus: true, terminusLabel: "最新" });
eq(m[m.length - 1].kind, "terminus", "terminus appended last");

// --- depth cycle 0->1->2->3->0 ------------------------------------------------
eq(cycleDepth(0), 1, "cycle 0->1");
eq(cycleDepth(3), 0, "cycle 3->0 wraps");
eq(nextScope("all"), "prompts", "scope toggles to prompts");
eq(nextScope("prompts"), "all", "scope toggles back to all");

// --- active index tracking ----------------------------------------------------
const offsets = [0, 100, 400, 900]; // 4 ribs at these container offsets
const viewport = 300;
const content = 1200;
eq(computeActiveIndex(0, viewport, content, offsets), 0, "top -> first rib");
eq(computeActiveIndex(350, viewport, content, offsets), 2, "mid-scroll -> rib at/above anchor");
// bottom of the column always selects the last rib (the streaming tail)
eq(computeActiveIndex(900, viewport, content, offsets), 3, "bottom -> last rib (terminus/tail)");
eq(computeActiveIndex(0, viewport, content, []), -1, "empty -> -1");

console.log("test-conversation-minimap: ALL_OK");
