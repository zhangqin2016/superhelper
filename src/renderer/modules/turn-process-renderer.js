import {
  reapplySessionInlineDiffs,
  resolveTurnDiffEntries,
} from "./diff-panel.js";
import {
  prepareProcessRenderView,
  processStructureSignature,
} from "./turn-process-render-view.js";
import { commitProcessDom } from "./turn-process-dom.js";
import { patchLiveProcessDom } from "./turn-live-process-patch.js";
import { renderProcessTimeline } from "./turn-process-timeline.js";

export function renderProcess(root, liveTurn, ctx = {}, {
  resolveDiffs = resolveTurnDiffEntries,
  processSignature = processStructureSignature,
  prepareView = prepareProcessRenderView,
  patchDom = patchLiveProcessDom,
  renderTimeline = renderProcessTimeline,
  commitDom = commitProcessDom,
  reapplyDiffs = reapplySessionInlineDiffs,
} = {}) {
  if (!root) return;
  const { sessionId, sealed = Boolean(liveTurn.final) } = ctx;
  const wasSealed = root.dataset.sealed === "true";
  const diffEntries = resolveDiffs(liveTurn, sessionId);
  const structureSig = processSignature(liveTurn, sealed, { diffCount: diffEntries.length });
  const processView = prepareView(liveTurn, sealed, { diffEntries, sessionId });
  if (!sealed && root.dataset.processSig === structureSig && patchDom(root, liveTurn, ctx)) {
    root.hidden = !processView.hasContent;
    if (sessionId && root.dataset.diffKey !== processView.diffKey) {
      root.dataset.diffKey = processView.diffKey;
      reapplyDiffs(sessionId, liveTurn.turnId || null);
    }
    return;
  }

  root.dataset.sealed = sealed ? "true" : "false";
  root.dataset.processSig = structureSig;
  root.hidden = !processView.hasContent;
  if (!processView.hasContent) {
    root.replaceChildren();
    return;
  }

  const list = renderTimeline(processView, { sealed, sessionId, turnId: liveTurn.turnId || null });
  commitDom(root, list, { sealed, wasSealed });
  if (sessionId) reapplyDiffs(sessionId, liveTurn.turnId || null);
}
