/**
 * §13.2 drag-and-drop / paste entry point for character cards (extracted from
 * character-session-control.js hotspot). The factory receives the control's
 * facade/dispatch/popover callbacks so the opener can stay in one place.
 */
export function createCharacterImportOpener({ getFacade, dispatch, openPopover }) {
  return async function openCharacterImportPreview(sourcePath) {
    const api = getFacade();
    if (!api || !sourcePath) return false;
    try {
      const res = await api.previewCharacterImport({ sourcePath });
      if (res?.ok && res.kind === "characterCard") {
        dispatch({ type: "import.previewLoaded", preview: res });
        openPopover();
        return true;
      }
    } catch {
      /* not a card — caller falls back to attachment */
    }
    return false;
  };
}
