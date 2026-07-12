#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildTurnViewModel,
  escapeGeneratedMediaMarkers,
  inferArtifactType,
  legacyLiveTurnFromMessage,
  liveTurnFromRecord,
  mergeTurnResultBlocks,
  shouldHideImageResultBlock,
  turnResultBlockKey,
} from "../src/renderer/modules/turn-view-model.js";

function makeTurn(overrides = {}) {
  return {
    turnId: "turn_view_model",
    phase: "done",
    assistantText: "Done.\n<generated_media type=\"image\"><file path=\"/tmp/generated-assets/scene.png\" mimeType=\"image/png\" /></generated_media>",
    thinkingText: "",
    contentBlocks: [],
    artifacts: [{ path: "/tmp/report.md", mimeType: "text/markdown" }],
    resultBlocks: [{ type: "file", path: "/tmp/out.pdf", mimeType: "application/pdf" }],
    tools: new Map([
      ["tool_media", {
        id: "tool_media",
        name: "bash",
        status: "done",
        result: JSON.stringify({
          ok: true,
          output: "<generated_media type=\"image\"><file path=\"/tmp/generated-assets/scene.png\" mimeType=\"image/png\" /></generated_media>",
        }),
      }],
    ]),
    final: { type: "turn.completed", payload: { assistant: "Done." }, ts: 1 },
    ...overrides,
  };
}

const sealed = buildTurnViewModel(makeTurn(), { sealed: true });
const live = buildTurnViewModel(makeTurn({ final: null, phase: "streaming" }), { sealed: false });
const starting = buildTurnViewModel(makeTurn({ final: null, phase: "starting" }), { sealed: false });

assert.deepEqual(sealed.slotOrder, ["header", "process", "taskrun", "narrative", "artifacts", "footer", "prompts"]);
assert.deepEqual(live.slotOrder, sealed.slotOrder, "live and sealed turns must share one stable slot contract");
assert.deepEqual(
  sealed.articleClassFlags,
  { isSealed: true, isLive: false, isWorking: false },
  "sealed turn shell classes should be decided by the view model",
);
assert.deepEqual(
  live.articleClassFlags,
  { isSealed: false, isLive: true, isWorking: false },
  "streaming turn shell classes should be decided by the view model",
);
assert.deepEqual(
  starting.articleClassFlags,
  { isSealed: false, isLive: true, isWorking: true },
  "starting turn shell classes should preserve the legacy working state",
);
assert.equal(sealed.narrative.text, "Done.", "tool-generated media markers should be stripped from narrative text");
assert.equal(sealed.narrative.showText, true, "visible assistant text should be shown through the view model");
assert.equal(sealed.narrative.visible, true, "narrative region should be visible when assistant text is shown");
assert.equal(sealed.narrative.key, "Done.|turn.completed|0|", "narrative key should preserve the legacy DOM cache signature");
assert.equal(sealed.artifacts.hoistedMedia.length, 1, "tool-generated media should be hoisted to artifacts");
assert.equal(sealed.artifacts.hoistedMediaGroups.length, 1, "hoisted media render groups should be prepared by the view model");
assert.deepEqual(
  sealed.artifacts.hoistedMediaGroups[0].files.map((file) => file.path),
  ["/tmp/generated-assets/scene.png"],
  "hoisted media groups should preserve generated media file paths",
);
assert.equal(sealed.artifacts.resultBlocks.length, 2, "stored result blocks and artifacts should merge for artifact rendering");
assert.equal(sealed.narrative.hasInlineImages, false);

const imageOnly = buildTurnViewModel(makeTurn({
  assistantText: "",
  contentBlocks: [{ blockType: "image", data: "iVBORw0KGgo=", mediaType: "image/png" }],
  tools: new Map(),
  artifacts: [],
  resultBlocks: [
    { type: "artifact", artifactType: "image", path: "/tmp/inline-duplicate.png" },
    { type: "artifact", artifactType: "pdf", path: "/tmp/keep.pdf" },
  ],
  final: { type: "turn.completed", payload: { assistant: "" }, ts: 1 },
}), { sealed: true });

assert.equal(imageOnly.narrative.text, "", "image-only content should not invent narrative text");
assert.equal(imageOnly.narrative.showText, false, "image-only content should not show an empty text node");
assert.equal(imageOnly.narrative.hasInlineImages, true, "inline content-block images should be tracked in the view model");
assert.equal(imageOnly.narrative.visible, true, "image-only content should keep the narrative region visible for inline images");
assert.equal(imageOnly.narrative.inlineImageKey, "image/png:12", "inline image cache key should be prepared by the view model");
assert.deepEqual(
  imageOnly.narrative.inlineImages,
  [{ src: "data:image/png;base64,iVBORw0KGgo=", alt: "" }],
  "inline image data URLs should be prepared by the view model",
);
assert.equal(
  imageOnly.narrative.key,
  "|turn.completed|1|image/png:12",
  "inline image changes should participate in the narrative DOM cache key",
);
assert.deepEqual(
  imageOnly.artifacts.visibleResultBlocks.map((block) => block.path),
  ["/tmp/keep.pdf"],
  "visible result blocks should hide duplicate image cards while keeping non-image artifacts",
);

const existingImageUrl = buildTurnViewModel(makeTurn({
  assistantText: "",
  contentBlocks: [{ blockType: "image", data: "app-blob://inline-image", mediaType: "image/png" }],
  tools: new Map(),
  artifacts: [],
  resultBlocks: [],
}), { sealed: true });
assert.deepEqual(
  existingImageUrl.narrative.inlineImages,
  [{ src: "app-blob://inline-image", alt: "" }],
  "resolved inline image URLs should pass through without being wrapped as base64",
);

const narrativeOnly = buildTurnViewModel(makeTurn({
  assistantText: "Example: <generated_media type=\"image\"><file path=\"/tmp/generated-assets/example.png\" /></generated_media>",
  tools: new Map(),
  artifacts: [],
  resultBlocks: [],
}), { sealed: true });

assert.equal(narrativeOnly.artifacts.hoistedMedia.length, 0, "narrative-only generated_media text must not create media cards");
assert.equal(
  narrativeOnly.narrative.text,
  escapeGeneratedMediaMarkers(narrativeOnly.rawAssistantText),
  "narrative-only generated_media text should be escaped and preserved",
);

const promptTurn = buildTurnViewModel(makeTurn({
  permissions: new Map([
    ["perm_1", { requestId: "perm_1", toolName: "bash" }],
  ]),
  questions: new Map([
    ["question_1", { requestId: "question_1", questions: [{ id: "answer" }] }],
  ]),
  hooks: new Map([
    ["hook_1", { requestId: "hook_1", hookName: "before_command" }],
  ]),
}), { sealed: false });
assert.deepEqual(
  promptTurn.prompts.entries.map((item) => item.requestId),
  ["perm_1", "question_1", "hook_1"],
  "prompt entries should preserve permission/question/hook order",
);
assert.equal(promptTurn.prompts.signature, "p:perm_1|q:question_1|h:hook_1");
assert.deepEqual(
  promptTurn.prompts.activeQuestionRequestIds,
  new Set(["question_1"]),
  "active question ids should be prepared by the view model for draft pruning",
);
assert.equal(promptTurn.prompts.visible, true);

const merged = mergeTurnResultBlocks(
  [{ type: "file", path: "/tmp/report.html", artifactType: "", mimeType: "", bytes: 0 }],
  [{ path: "/tmp/report.html", mimeType: "text/html", bytes: 4096, relativePath: "output/report.html" }],
);
assert.equal(merged.length, 1, "same path from resultBlocks and artifacts should collapse to one card");
assert.equal(merged[0].artifactType, "html", "artifact type should enrich the existing result block");
assert.equal(merged[0].mimeType, "text/html", "artifact metadata should enrich the existing result block");
assert.equal(merged[0].bytes, 4096, "missing size should be filled from artifact metadata");

assert.equal(inferArtifactType({ path: "/tmp/scene.svg" }), "image");
assert.equal(inferArtifactType({ path: "/tmp/movie.mp4" }), "video");
assert.equal(inferArtifactType({ path: "/tmp/voice.wav" }), "audio");
assert.equal(inferArtifactType({ mimeType: "application/pdf" }), "pdf");
assert.equal(inferArtifactType({ path: "/tmp/report.html" }), "html");
assert.equal(inferArtifactType({ mimeType: "text/markdown" }), "markdown");
assert.equal(inferArtifactType({ path: "/tmp/archive.zip" }), "file");
assert.equal(
  shouldHideImageResultBlock({ source: "content_block", type: "image" }, { hasInlineImages: false }),
  true,
  "content-block image result cards should always hide because images render inline in the narrative",
);
assert.equal(
  shouldHideImageResultBlock({ path: "/tmp/scene.svg" }, { hasInlineImages: true }),
  true,
  "file-derived image cards should hide only when the narrative already has inline images",
);
assert.equal(
  shouldHideImageResultBlock({ path: "/tmp/scene.svg" }, { hasInlineImages: false }),
  false,
  "file-derived image cards should stay visible when there is no inline image",
);
assert.equal(
  shouldHideImageResultBlock({ path: "/tmp/report.pdf", mimeType: "application/pdf" }, { hasInlineImages: true }),
  false,
  "non-image result cards must not hide just because inline images exist",
);
assert.equal(
  turnResultBlockKey({ id: "inline", type: "markdown", text: "hello" }),
  "inline:markdown:::::5:4bj995",
  "result block keys must stay compatible with the legacy DOM reconciliation key",
);

const legacyTurn = legacyLiveTurnFromMessage({
  id: "msg_1",
  timestamp: "2026-07-07T12:00:00.000Z",
  content: "legacy answer",
  meta: { terminal: "turn.interrupted", taskRun: { status: "interrupted" } },
});
assert.equal(legacyTurn.turnId, "msg_1");
assert.equal(legacyTurn.phase, "done");
assert.equal(legacyTurn.final.type, "turn.interrupted");
assert.equal(legacyTurn.final.payload.assistant, "legacy answer");
assert.equal(legacyTurn.taskRun.status, "interrupted");
assert.equal(legacyTurn.permissions instanceof Map, true);
assert.equal(legacyTurn.finalRendered, false);

const recordTurn = liveTurnFromRecord({
  turnId: "record_1",
  assistantText: "record answer",
  thinkingText: "thinking",
  terminal: "turn.completed",
  tools: [{ id: "tool_1", name: "Read", status: "done" }],
  processEvents: [{ payload: { detail: "event" } }],
  notices: [{ code: "notice" }],
  meta: { taskRun: { status: "completed" } },
  startedAt: 10,
  endedAt: 20,
});
assert.equal(recordTurn.turnId, "record_1");
assert.equal(recordTurn.tools.get("tool_1").name, "Read");
assert.equal(recordTurn.processEvents[0].type, "process.event");
assert.equal(recordTurn.notices[0].type, "engine.notice");
assert.equal(recordTurn.taskRun.status, "completed");
assert.equal(recordTurn.final.ts, 20);

const root = path.dirname(fileURLToPath(import.meta.url));
const rendererSource = fs.readFileSync(path.join(root, "../src/renderer/modules/turn-block-renderers.js"), "utf8");
const turnRendererSource = fs.readFileSync(path.join(root, "../src/renderer/modules/turn-view-renderer.js"), "utf8");
assert.match(
  rendererSource,
  /mergeTurnResultBlocks\s+as\s+mergeResultBlocks/,
  "DOM result block renderer should re-export the pure merge function for compatibility",
);
assert.match(
  rendererSource,
  /inferArtifactType/,
  "DOM result block renderer should import the pure artifact type inference",
);
assert.doesNotMatch(
  rendererSource,
  /function inferArtifactType\s*\(/,
  "DOM result block renderer must not own artifact type inference",
);
assert.match(
  rendererSource,
  /turnResultBlockKey/,
  "DOM result block renderer should import the pure result block key",
);
assert.doesNotMatch(
  rendererSource,
  /function blockKey\s*\(/,
  "DOM result block renderer must not own result block key generation",
);
assert.doesNotMatch(
  rendererSource,
  /function hashStr\s*\(/,
  "DOM result block renderer must not own result block hashing",
);
assert.doesNotMatch(
  turnRendererSource,
  /shouldHideImageResultBlock/,
  "turn renderer should consume visible result blocks instead of applying image-result visibility logic",
);
assert.doesNotMatch(
  turnRendererSource,
  /const IMAGE_BLOCK_EXTS/,
  "turn renderer must not own image result extension lists",
);
assert.doesNotMatch(
  turnRendererSource,
  /function isImageResultBlock\s*\(/,
  "turn renderer must not own image result classification",
);
assert.doesNotMatch(
  turnRendererSource,
  /escapeGeneratedMediaMarkers/,
  "turn renderer should consume narrative text from the view model instead of escaping markers itself",
);
assert.doesNotMatch(
  turnRendererSource,
  /stripGeneratedMediaMarkers/,
  "turn renderer should consume narrative text from the view model instead of stripping markers itself",
);
assert.doesNotMatch(
  turnRendererSource,
  /function narrativeImageKey\s*\(/,
  "turn renderer should consume narrative cache keys from the view model",
);
assert.doesNotMatch(
  turnRendererSource,
  /resultBlocks\.filter/,
  "turn renderer should consume visible result blocks from the view model",
);
assert.doesNotMatch(
  turnRendererSource,
  /groupHoistableMediaBlocks/,
  "turn renderer should consume grouped hoisted media from the view model",
);
assert.doesNotMatch(
  turnRendererSource,
  /\[\s*header,\s*process,\s*taskRun,\s*narrative,\s*artifacts,\s*footer,\s*prompts\s*\]/,
  "turn renderer should consume slot order from the view model instead of hardcoding it",
);
assert.doesNotMatch(
  turnRendererSource,
  /article\.append\(\s*header,\s*process,\s*taskRun,\s*narrative,\s*artifacts,\s*footer,\s*prompts\s*\)/,
  "turn shell creation should consume the shared slot order contract instead of hardcoding it",
);
assert.doesNotMatch(
  turnRendererSource,
  /resolveAssistantStreamText/,
  "turn renderer should consume assistant text from the view model instead of resolving it directly",
);
assert.doesNotMatch(
  turnRendererSource,
  /liveTurn\.phase\s*===\s*"starting"/,
  "turn renderer should consume article class flags from the view model",
);
assert.doesNotMatch(
  turnRendererSource,
  /function renderableThinkingEntries\s*\(/,
  "turn renderer should consume renderable thinking filtering from turn-view-status",
);
assert.doesNotMatch(
  turnRendererSource,
  /function shouldGroupFinishedThinking\s*\(/,
  "turn renderer should consume thinking grouping decisions from turn-view-status",
);
assert.doesNotMatch(
  turnRendererSource,
  /function thinkingDurationMs\s*\(/,
  "turn renderer should not own thinking duration math",
);
assert.doesNotMatch(
  turnRendererSource,
  /function contentImageSrc\s*\(/,
  "turn renderer should consume inline image src values from the view model",
);
assert.doesNotMatch(
  turnRendererSource,
  /function progressPercent\s*\(/,
  "turn renderer should consume progress percentage math from turn-view-status",
);
assert.doesNotMatch(
  turnRendererSource,
  /entries\s*=\s*\[\s*\.\.\.liveTurn\.permissions\.values\(\),\s*\.\.\.liveTurn\.questions\.values\(\),\s*\.\.\.liveTurn\.hooks\.values\(\),\s*\]/,
  "turn renderer should consume prompt entries from the view model",
);
assert.doesNotMatch(
  turnRendererSource,
  /const PERMISSION_KIND_KEYS/,
  "turn renderer should consume permission label mapping from turn-view-status",
);
assert.doesNotMatch(
  turnRendererSource,
  /if \(status === "failed"\) return t\("tool\.status\.failed"\)/,
  "turn renderer should consume tool status labels from turn-view-status",
);
assert.doesNotMatch(
  turnRendererSource,
  /function timelineForProcessView\s*\(/,
  "turn renderer should consume process timeline preparation from turn-process-layout",
);
assert.doesNotMatch(
  turnRendererSource,
  /function buildChildToolsMap\s*\(/,
  "turn renderer should consume child tool nesting from turn-process-layout",
);
assert.doesNotMatch(
  turnRendererSource,
  /function subagentMetadataLine\s*\([^)]*\)\s*{[\s\S]*?const bits = \[\]/,
  "turn renderer should consume subagent metadata text from turn-view-status",
);
assert.doesNotMatch(
  turnRendererSource,
  /function subagentStatsLine\s*\([^)]*\)\s*{[\s\S]*?stats\.runningTools/,
  "turn renderer should consume subagent stats text from turn-view-status",
);
assert.doesNotMatch(
  turnRendererSource,
  /subagent\.summaryFailed/,
  "turn renderer should consume subagent panel summaries from turn-view-status",
);
assert.doesNotMatch(
  turnRendererSource,
  /entries\.some\(\(entry\) => entry\.status === "running" \|\| entry\.status === "failed"\)/,
  "turn renderer should consume subagent panel open state from turn-view-status",
);
assert.doesNotMatch(
  turnRendererSource,
  /function collectSubagentEntries\s*\(/,
  "turn renderer should consume subagent entry aggregation from turn-process-layout",
);
assert.doesNotMatch(
  turnRendererSource,
  /function subagentTranscriptText\s*\(/,
  "turn renderer should consume subagent transcript text from turn-view-status",
);
assert.doesNotMatch(
  turnRendererSource,
  /entry\.subagent\?\.textFull\?\.length/,
  "turn renderer should consume process structure signatures from turn-process-layout",
);
assert.doesNotMatch(
  turnRendererSource,
  /export function legacyLiveTurnFromMessage\s*\(/,
  "turn renderer should re-export legacy turn conversion instead of owning it",
);
assert.doesNotMatch(
  turnRendererSource,
  /export function liveTurnFromRecord\s*\(/,
  "turn renderer should re-export record turn conversion instead of owning it",
);
assert.doesNotMatch(
  turnRendererSource,
  /const questionDrafts = new Map/,
  "turn renderer should consume prompt draft state from turn-prompt-drafts",
);
assert.doesNotMatch(
  turnRendererSource,
  /function setQuestionSelection\s*\(/,
  "turn renderer should consume prompt selection state updates from turn-prompt-drafts",
);
assert.doesNotMatch(
  turnRendererSource,
  /function promptCard\s*\(/,
  "turn renderer should consume prompt card DOM helpers from turn-prompt-ui",
);
assert.doesNotMatch(
  turnRendererSource,
  /function actionRow\s*\(/,
  "turn renderer should consume prompt action row DOM helpers from turn-prompt-ui",
);
assert.doesNotMatch(
  turnRendererSource,
  /function button\s*\(/,
  "turn renderer should consume prompt action buttons from turn-prompt-ui",
);
assert.doesNotMatch(
  turnRendererSource,
  /function detailsOpenStateKey\s*\(/,
  "turn renderer should consume details open-state keys from turn-details-open-state",
);
assert.doesNotMatch(
  turnRendererSource,
  /function restoreDetailsOpenState\s*\(/,
  "turn renderer should consume details open-state restoration from turn-details-open-state",
);
assert.doesNotMatch(
  rendererSource,
  /export function mergeResultBlocks\s*\(/,
  "DOM result block renderer must not own artifact merge logic",
);

// Field photo case: the model echoed <generated_media> markup into its ANSWER
// text on turns whose tool results are absent (subagent runs / rehydrated
// sealed turns). The markup must render as media cards, never as literal XML.
{
  const echoed = buildTurnViewModel({
    turnId: "turn_echoed_media",
    phase: "done",
    assistantText: '图片已生成 <generated_media type="image"> <file path="D:\\aicode\\images\\generated-assets\\image-1.png" bytes="5404834" /> </generated_media>',
    thinkingText: "",
    contentBlocks: [],
    artifacts: [],
    resultBlocks: [],
    tools: new Map(),
    final: { type: "turn.completed" },
  });
  assert.doesNotMatch(echoed.narrative.text, /<generated_media/, "echoed markup never renders as literal XML");
  assert.doesNotMatch(echoed.narrative.text, /&lt;generated_media/, "echoed markup is stripped, not escaped");
  assert.match(echoed.narrative.text, /图片已生成/, "the prose around the markup survives");
  assert.equal(echoed.artifacts.hoistedMedia.length, 1, "text-echoed media hoists into the artifacts slot");
  assert.equal(echoed.artifacts.hoistedMedia[0].files[0].path, "D:\\aicode\\images\\generated-assets\\image-1.png");

  // Marker-free text passes through byte-identical (strip collapses blank
  // runs, so it must never touch normal answers).
  const plain = buildTurnViewModel({
    turnId: "turn_plain",
    phase: "done",
    assistantText: "第一段。\n\n\n第二段带多空行。  ",
    thinkingText: "",
    contentBlocks: [],
    artifacts: [],
    resultBlocks: [],
    tools: new Map(),
    final: { type: "turn.completed" },
  });
  // (the stream resolver already trims outer whitespace — the guard here is
  // that interior blank runs survive, which the strip path would collapse)
  assert.equal(plain.narrative.text, "第一段。\n\n\n第二段带多空行。", "marker-free text keeps interior blank runs");
}

console.log("turn-view-model: ok");
