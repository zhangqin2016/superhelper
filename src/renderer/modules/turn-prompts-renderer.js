import { buildTurnViewModel } from "./turn-view-model.js";
import { pruneQuestionDrafts } from "./turn-prompt-drafts.js";
import {
  promptKindForItem,
  promptRendererKeyForKind,
} from "./turn-prompt-model.js";

export function renderPrompts(root, sessionId, liveTurn, prompts = null, {
  buildView = buildTurnViewModel,
  pruneDrafts = pruneQuestionDrafts,
  kindForItem = promptKindForItem,
  rendererKeyForKind = promptRendererKeyForKind,
  renderers = {},
} = {}) {
  if (!root) return;
  const view = prompts || buildView(liveTurn).prompts;
  const entries = view.entries || [];
  pruneDrafts(sessionId, view.activeQuestionRequestIds || new Set());
  const sig = view.signature || "";
  if (root.dataset.promptsSig === sig) return;
  root.dataset.promptsSig = sig;
  root.replaceChildren();
  root.hidden = !view.visible;
  for (const item of entries) {
    const rendererKey = rendererKeyForKind(kindForItem(item));
    root.appendChild(renderers[rendererKey](sessionId, item));
  }
}
