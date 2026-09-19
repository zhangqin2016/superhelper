"use strict";

const fileKinds = require("../shared/file-kinds.mjs");

/**
 * Which kinds of files a request carries — the facts the capability broker
 * routes on. Each answer is a purpose-named group of the shared file-kind
 * table, never a spelled-out extension list, so a new format reaches routing
 * the moment it reaches the table.
 */
function fileFacts(files = []) {
  const names = (Array.isArray(files) ? files : [])
    .map((file) => String(file?.name || file?.path || "").toLowerCase())
    .filter(Boolean);
  return {
    pdf: names.some((name) => name.endsWith(".pdf")),
    xlsx: names.some((name) => fileKinds.hasKind("spreadsheet", name)),
    pptx: names.some((name) => fileKinds.hasKind("presentation", name)),
    docx: names.some((name) => fileKinds.hasKind("wordDocument", name)),
    image: names.some((name) => fileKinds.isRasterImage(name)),
    media: names.some((name) => fileKinds.isVideo(name) || fileKinds.isAudio(name)),
  };
}

module.exports = { fileFacts };
