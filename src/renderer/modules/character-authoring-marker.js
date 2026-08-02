export function readCharacterAuthoringMarker(input, text) {
  const adjustmentHandle = input?.dataset?.characterWorldsAdjustmentHandle || "";
  if (adjustmentHandle) return { kind: "characterWorldsAdjustment", adjustmentHandle };
  const starter = input?.dataset?.characterAuthoringStarter || "";
  const kind = input?.dataset?.characterAuthoringKind || "";
  return starter && String(text || "").startsWith(starter) && ["character", "persona", "worldBook"].includes(kind)
    ? { kind, starter }
    : null;
}

export function clearCharacterAuthoringMarker(input) {
  if (!input) return;
  delete input.dataset.characterAuthoringKind;
  delete input.dataset.characterAuthoringStarter;
  delete input.dataset.characterWorldsAdjustmentHandle;
}

export function restoreCharacterAuthoringMarker(input, marker) {
  if (!input || !marker) return;
  if (marker.kind === "characterWorldsAdjustment") {
    input.dataset.characterWorldsAdjustmentHandle = marker.adjustmentHandle;
    return;
  }
  input.dataset.characterAuthoringKind = marker.kind;
  input.dataset.characterAuthoringStarter = marker.starter;
}

export function characterAuthoringOptions(marker) {
  if (!marker) return null;
  return marker.kind === "characterWorldsAdjustment"
    ? { characterWorldsAdjustmentHandle: marker.adjustmentHandle }
    : { characterAuthoringKind: marker.kind };
}
