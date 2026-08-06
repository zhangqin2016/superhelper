const RECEIPT_TABS = Object.freeze({
  character: "characters",
  persona: "personas",
  worldBook: "books",
});

export function findCharacterLibraryItem(items = {}, stableId = "") {
  if (!stableId) return null;
  for (const tab of ["characters", "personas", "books"]) {
    const item = (items[tab] || []).find((entry) => (
      entry.id === stableId
      || entry.currentRevisionId === stableId
      || entry.officialId === stableId
    ));
    if (item) return item;
  }
  return null;
}

export function bindCharacterReceiptView(openCharacterLibrary) {
  if (typeof window === "undefined" || typeof window.addEventListener !== "function") return;
  window.addEventListener("character-worlds:view", (event) => {
    const detail = event.detail || {};
    const tab = RECEIPT_TABS[detail.kind] || RECEIPT_TABS.character;
    void openCharacterLibrary({ tab, entityId: detail.entityId, revisionId: detail.revisionId });
  });
}
