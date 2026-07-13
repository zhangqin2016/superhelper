import {
  collectHoistableMedia,
  escapeGeneratedMediaMarkers,
  groupHoistableMediaBlocks,
  mergeTurnResultBlocks,
  shouldHideImageResultBlock,
  stripGeneratedMediaMarkers,
} from "./turn-artifact-model.js";
import { parseGeneratedMedia } from "./tool-payload-renderer.js";
import {
  inlineImageKeyForContentBlocks,
  inlineImagesForNarrative,
} from "./turn-narrative-inline-images.js";
import { resolveAssistantStreamText, shouldShowNarrative } from "./turn-narrative-policy.js";
import { buildPromptViewModel } from "./turn-prompt-model.js";

export const TURN_VIEW_SLOT_ORDER = ["header", "process", "taskrun", "narrative", "artifacts", "footer", "prompts"];

export {
  artifactBlocksFromArtifacts,
  collectHoistableMedia,
  escapeGeneratedMediaMarkers,
  groupHoistableMediaBlocks,
  inferArtifactType,
  mergeTurnResultBlocks,
  shouldHideImageResultBlock,
  stripGeneratedMediaMarkers,
  turnResultBlockKey,
} from "./turn-artifact-model.js";
export { buildPromptViewModel } from "./turn-prompt-model.js";
export {
  legacyLiveTurnFromMessage,
  liveTurnFromRecord,
} from "./turn-live-turn-adapter.js";

function textOutsideMarkdownFences(text = "") {
  return String(text || "").replace(/(^|\n)(`{3,}|~{3,})[^\n]*\n[\s\S]*?\n\2(?=\n|$)/g, "\n");
}

export function buildTurnViewModel(liveTurn = {}, options = {}) {
  const sealed = Boolean(options.sealed ?? liveTurn.final);
  const articleClassFlags = {
    isSealed: sealed,
    isLive: !sealed,
    isWorking: !sealed && liveTurn.phase === "starting",
  };
  const hoistedMedia = collectHoistableMedia(liveTurn);
  const rawAssistantText = resolveAssistantStreamText(liveTurn);
  // Models echo <generated_media …> markup into their ANSWER text (field
  // photo: three turns showing raw XML). The markup itself declares
  // path/type/bytes, so parse it into the same hoisted cards — media echoed
  // in text renders like tool-produced media even when this turn's tool
  // results are absent (subagent runs, rehydrated sealed turns). Dedupe by
  // file path against tool-derived blocks.
  try {
    const seen = new Set(hoistedMedia.map((block) => (block.files || []).map((file) => file.path).join("|") || JSON.stringify(block)));
    for (const block of parseGeneratedMedia(textOutsideMarkdownFences(rawAssistantText)) || []) {
      const key = (block.files || []).map((file) => file.path).join("|") || JSON.stringify(block);
      if (seen.has(key)) continue;
      seen.add(key);
      hoistedMedia.push(block);
    }
  } catch {
    // Text-echoed media is a bonus; parsing failures keep tool-derived media.
  }
  const hoistedMediaGroups = groupHoistableMediaBlocks(hoistedMedia);
  // Protocol markup NEVER renders as literal XML: complete blocks are
  // stripped (their cards render in the artifacts slot), stray/partial tags
  // are escaped. Marker-free text passes through byte-identical (strip also
  // collapses blank runs, so it must not touch normal answers).
  const text = rawAssistantText.includes("<generated_media")
    ? escapeGeneratedMediaMarkers(stripGeneratedMediaMarkers(rawAssistantText))
    : escapeGeneratedMediaMarkers(rawAssistantText);
  const contentBlocks = Array.isArray(liveTurn.contentBlocks) ? liveTurn.contentBlocks : [];
  const resultBlocks = mergeTurnResultBlocks(liveTurn.resultBlocks || [], liveTurn.artifacts || []);
  const hasInlineImages = contentBlocks.some((block) => block?.blockType === "image" && block.data);
  const inlineImageKey = inlineImageKeyForContentBlocks(contentBlocks);
  const inlineImages = inlineImagesForNarrative(contentBlocks);
  const visibleResultBlocks = resultBlocks.filter((block) => !shouldHideImageResultBlock(block, { hasInlineImages }));
  const showText = Boolean(text) && shouldShowNarrative(liveTurn);
  const prompts = buildPromptViewModel(liveTurn);
  const narrativeKey = [
    text,
    liveTurn.final?.type || "",
    contentBlocks.length,
    inlineImageKey,
  ].join("|");
  return {
    turnId: liveTurn.turnId || "",
    sealed,
    articleClassFlags,
    slotOrder: TURN_VIEW_SLOT_ORDER,
    rawAssistantText,
    narrative: {
      text,
      key: narrativeKey,
      showText,
      visible: showText || hasInlineImages,
      stripGeneratedMedia: hoistedMedia.length > 0,
      hasInlineImages,
      contentBlocks,
      inlineImageKey,
      inlineImages,
    },
    artifacts: {
      resultBlocks,
      visibleResultBlocks,
      hoistedMedia,
      hoistedMediaGroups,
    },
    prompts,
  };
}
