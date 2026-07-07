import {
  collectHoistableMedia,
  escapeGeneratedMediaMarkers,
  groupHoistableMediaBlocks,
  mergeTurnResultBlocks,
  shouldHideImageResultBlock,
  stripGeneratedMediaMarkers,
} from "./turn-artifact-model.js";
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

export function buildTurnViewModel(liveTurn = {}, options = {}) {
  const sealed = Boolean(options.sealed ?? liveTurn.final);
  const articleClassFlags = {
    isSealed: sealed,
    isLive: !sealed,
    isWorking: !sealed && liveTurn.phase === "starting",
  };
  const hoistedMedia = collectHoistableMedia(liveTurn);
  const hoistedMediaGroups = groupHoistableMediaBlocks(hoistedMedia);
  const rawAssistantText = resolveAssistantStreamText(liveTurn);
  const text = hoistedMedia.length
    ? stripGeneratedMediaMarkers(rawAssistantText)
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
