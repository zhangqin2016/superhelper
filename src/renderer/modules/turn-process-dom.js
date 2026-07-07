import morphdom from "../../../node_modules/morphdom/dist/morphdom-esm.js";
import {
  collectDetailsOpenState,
  restoreDetailsOpenState,
} from "./turn-details-open-state.js";

export function commitProcessDom(root, list, { sealed, wasSealed }, {
  morph = morphdom,
  collectOpenState = collectDetailsOpenState,
  restoreOpenState = restoreDetailsOpenState,
} = {}) {
  if (sealed) {
    const openState = collectOpenState(root);
    root.replaceChildren(list);
    restoreOpenState(root, openState, { collapseFinishedThinking: !wasSealed });
    return;
  }
  const nextRoot = root.cloneNode(false);
  nextRoot.appendChild(list);
  morph(root, nextRoot, {
    childrenOnly: true,
    onBeforeElUpdated(fromEl, toEl) {
      if (fromEl.tagName === "DETAILS") toEl.open = fromEl.open;
      return !fromEl.isEqualNode(toEl);
    },
    onNodeDiscarded(node) {
      if (typeof node.__disposeRenderer === "function") {
        try { node.__disposeRenderer(); } catch { /* ignore */ }
      }
    },
  });
}
