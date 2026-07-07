import { buildToolPreviewLabel } from "./tool-preview-label.js";

export function toolPreview(tool = {}) {
  if ((!tool.input || !Object.keys(tool.input).length) && tool.partialJson) {
    try {
      const parsed = JSON.parse(tool.partialJson);
      if (parsed && typeof parsed === "object") {
        return buildToolPreviewLabel({ ...tool, input: parsed });
      }
    } catch {
      // streaming partial JSON
    }
  }
  return buildToolPreviewLabel(tool);
}
