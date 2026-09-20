"use strict";
const { isVisionRaster } = require("../shared/file-kinds.mjs");

// A completed local vision invocation names the image it actually submitted.
// Free-form model claims and command names are not inspection evidence.
function visionInspectionPaths(tool = {}) {
  const output = tool.result ?? tool.output ?? tool.content;
  const text = typeof output === "string" ? output : String(output?.stdout || output?.output || "");
  const paths = [];
  for (const line of text.slice(0, 65536).split(/\r?\n/)) {
    if (!line.startsWith("LILY_VISION_RECEIPT ")) continue;
    try {
      const receipt = JSON.parse(line.slice("LILY_VISION_RECEIPT ".length));
      if (receipt.version === 1 && receipt.kind === "image_inspection" && receipt.ok === true
        && typeof receipt.path === "string" && /^(?:[a-z]:[\\/]|\/)/i.test(receipt.path)
        && isVisionRaster(receipt.path)) paths.push(receipt.path);
    } catch { /* Old or malformed output retains the existing unverified state. */ }
  }
  return paths;
}

module.exports = { visionInspectionPaths };
