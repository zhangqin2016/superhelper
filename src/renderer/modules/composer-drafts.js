import store from "./state.js";
import { $ } from "./dom.js";
import { renderFilePreview } from "./file-handler.js";
import {
  clearCharacterAuthoringMarker,
  readCharacterAuthoringMarker,
  restoreCharacterAuthoringMarker,
} from "./character-authoring-marker.js";

export function createComposerDrafts({ onRestore }) {
  // One complete draft store serves both send recovery and session switching.
  const sessionDrafts = new Map();

  function capture(sessionId) {
    if (!sessionId) return null;
    const input = $("promptInput");
    const text = input?.value || "";
    const files = [...(store.get("pendingFiles") || [])];
    const marker = readCharacterAuthoringMarker(input, text.trim());
    const previous = sessionDrafts.get(sessionId);
    // Preserve identity across unchanged switches. A pending send may restore
    // only the empty draft it left behind, never a newer edit or send.
    if (previous && previous.text === text
      && previous.files.length === files.length
      && previous.files.every((file, index) => file === files[index])
      && previous.marker?.kind === marker?.kind
      && previous.marker?.starter === marker?.starter
      && previous.marker?.adjustmentHandle === marker?.adjustmentHandle) return previous;
    const draft = { text, files, marker };
    sessionDrafts.set(sessionId, draft);
    return draft;
  }

  function show(draft) {
    const input = $("promptInput");
    if (input) {
      input.value = draft?.text || "";
      clearCharacterAuthoringMarker(input);
      restoreCharacterAuthoringMarker(input, draft?.marker);
    }
    store.set("pendingFiles", [...(draft?.files || [])]);
    renderFilePreview();
    onRestore();
  }

  function clear(sessionId, savedDraft) {
    if (store.get("activeSessionId") === sessionId) capture(sessionId);
    if (sessionDrafts.get(sessionId) !== savedDraft) return null;
    const clearedDraft = { text: "", files: [], marker: null };
    sessionDrafts.set(sessionId, clearedDraft);
    if (store.get("activeSessionId") === sessionId) show(clearedDraft);
    return clearedDraft;
  }

  function restore(sessionId, savedDraft, clearedDraft) {
    if (!clearedDraft) return;
    const active = store.get("activeSessionId") === sessionId;
    if (active) capture(sessionId);
    if (sessionDrafts.get(sessionId) !== clearedDraft) return;
    sessionDrafts.set(sessionId, savedDraft);
    if (active) show(savedDraft);
  }

  function bind(input) {
    // Capture outgoing DOM too: authoring actions can set markers without an
    // input event, and files share the visible composer's store.
    let draftSessionId = store.get("activeSessionId");
    input.addEventListener("input", () => capture(draftSessionId));
    store.on("pendingFiles", () => capture(draftSessionId));
    store.on("activeSessionId", (nextId) => {
      if (nextId === draftSessionId) return;
      capture(draftSessionId);
      draftSessionId = nextId;
      show(nextId ? sessionDrafts.get(nextId) : null);
    });
  }

  return { capture, clear, restore, bind, forget: sessionId => sessionDrafts.delete(sessionId) };
}
