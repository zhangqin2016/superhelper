// Text/thinking block formation lives in one module shared with the main
// process, so the turn drawn live and the turn archived cannot disagree about
// its blocks. This module stays as the renderer's import point.
export {
  answerBlockIndex,
  answerBlockText,
  appendTimelineText,
  closeOpenThinkingBlocks,
  closeStreamingBlocks,
  upsertTimelineThinking,
} from "../../shared/timeline-blocks.mjs";
