/**
 * What kind of file an extension names — the ONE table, for both processes.
 *
 * Fourteen modules each kept their own list of "image" extensions, eight
 * different lists in all: .heic was an image to the task router and not to the
 * vision bridge, .svg was an image to the renderer and not to the bridge, .tif
 * was in three lists and out of three. A file was one kind in one module and
 * another kind in the next, and every new format had to be added in fourteen
 * places to be added at all. Seventeen more lists did the same for documents.
 *
 * The table maps an extension to its kind and mime; the named groups below
 * answer the questions modules actually ask, BY PURPOSE — "can the vision
 * bridge read it" is a different question from "can the browser display it",
 * which is different again from "is it an image file". A consumer picks the
 * group that matches its question and never spells out extensions.
 *
 * ESM so the renderer can `import` it; the main process and its workers
 * `require()` it (Node ≥ 22.12 loads ESM from CommonJS).
 */

const TABLE = {
  // images
  ".png": { kind: "image", mime: "image/png" },
  ".jpg": { kind: "image", mime: "image/jpeg" },
  ".jpeg": { kind: "image", mime: "image/jpeg" },
  ".gif": { kind: "image", mime: "image/gif" },
  ".webp": { kind: "image", mime: "image/webp" },
  ".bmp": { kind: "image", mime: "image/bmp" },
  ".svg": { kind: "image", mime: "image/svg+xml", vector: true },
  ".avif": { kind: "image", mime: "image/avif" },
  ".tif": { kind: "image", mime: "image/tiff" },
  ".tiff": { kind: "image", mime: "image/tiff" },
  ".heic": { kind: "image", mime: "image/heic" },
  // video
  ".mp4": { kind: "video", mime: "video/mp4" },
  ".webm": { kind: "video", mime: "video/webm" },
  ".mov": { kind: "video", mime: "video/quicktime" },
  ".m4v": { kind: "video", mime: "video/mp4" },
  ".mkv": { kind: "video", mime: "video/x-matroska" },
  ".avi": { kind: "video", mime: "video/x-msvideo" },
  // audio
  ".mp3": { kind: "audio", mime: "audio/mpeg" },
  ".wav": { kind: "audio", mime: "audio/wav" },
  ".m4a": { kind: "audio", mime: "audio/mp4" },
  ".aac": { kind: "audio", mime: "audio/aac" },
  ".ogg": { kind: "audio", mime: "audio/ogg" },
  ".flac": { kind: "audio", mime: "audio/flac" },
  // documents
  ".pdf": { kind: "pdf", mime: "application/pdf" },
  ".docx": { kind: "document", mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", ooxml: true },
  ".xlsx": { kind: "spreadsheet", mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", ooxml: true },
  ".xlsm": { kind: "spreadsheet", mime: "application/vnd.ms-excel.sheet.macroEnabled.12", ooxml: true },
  ".pptx": { kind: "presentation", mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation", ooxml: true },
  ".doc": { kind: "document", mime: "application/msword", legacyOffice: true },
  ".xls": { kind: "spreadsheet", mime: "application/vnd.ms-excel", legacyOffice: true },
  ".ppt": { kind: "presentation", mime: "application/vnd.ms-powerpoint", legacyOffice: true },
  ".odt": { kind: "document", mime: "application/vnd.oasis.opendocument.text", openDocument: true },
  ".ods": { kind: "spreadsheet", mime: "application/vnd.oasis.opendocument.spreadsheet", openDocument: true },
  ".odp": { kind: "presentation", mime: "application/vnd.oasis.opendocument.presentation", openDocument: true },
  ".rtf": { kind: "document", mime: "application/rtf" },
  ".csv": { kind: "spreadsheet", mime: "text/csv", text: true },
  ".tsv": { kind: "spreadsheet", mime: "text/tab-separated-values", text: true },
  ".md": { kind: "text", mime: "text/markdown", text: true },
  ".markdown": { kind: "text", mime: "text/markdown", text: true },
  ".txt": { kind: "text", mime: "text/plain", text: true },
};

const exts = (predicate) => Object.freeze(new Set(Object.keys(TABLE).filter((ext) => predicate(TABLE[ext], ext))));
const union = (...sets) => Object.freeze(new Set(sets.flatMap((set) => [...set])));

/**
 * Named groups, each the answer to one question. Keep them honest: a group
 * describes a capability the platform actually has (what the bridge sends,
 * what Chromium decodes), not what would be nice.
 */
const GROUPS = {
  /** Any image file, whatever can be done with it. */
  image: exts((e) => e.kind === "image"),
  /** Image formats Chromium renders in <img>. */
  browserImage: exts((e, ext) => e.kind === "image" && ![".tif", ".tiff", ".heic"].includes(ext)),
  /** Raster images (pixels, not vector) — what image-processing tooling operates on. */
  rasterImage: exts((e) => e.kind === "image" && !e.vector),
  /** What the vision bridge and the model file parts accept today. */
  visionRaster: exts((e, ext) => [".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"].includes(ext)),
  video: exts((e) => e.kind === "video"),
  /** Video formats Chromium plays in <video>. */
  browserVideo: exts((e, ext) => e.kind === "video" && ext !== ".avi"),
  audio: exts((e) => e.kind === "audio"),
  pdf: exts((e) => e.kind === "pdf"),
  ooxml: exts((e) => e.ooxml && !e.text),
  legacyOffice: exts((e) => e.legacyOffice),
  openDocument: exts((e) => e.openDocument),
  /** Office suites' own formats (OOXML, legacy binary, OpenDocument, RTF). */
  office: exts((e) => e.ooxml || e.legacyOffice || e.openDocument || e.mime === "application/rtf"),
  wordDocument: exts((e) => e.kind === "document"),
  spreadsheet: exts((e) => e.kind === "spreadsheet"),
  textDocument: exts((e) => e.text),
  presentation: exts((e) => e.kind === "presentation"),
  /** ZIP containers with a document inside — an archive tool must not unpack them. */
  semanticZipContainer: exts((e) => e.ooxml || e.openDocument),
};
GROUPS.media = union(GROUPS.image, GROUPS.video, GROUPS.audio);
GROUPS.browserMedia = union(GROUPS.browserImage, GROUPS.browserVideo, GROUPS.audio);
/** Documents the platform can send to a model only as a path (bytes are not text). */
GROUPS.pathOnlyDocument = union(GROUPS.pdf, GROUPS.office);
export const EXTENSIONS = Object.freeze(GROUPS);

/**
 * ".PNG" → ".png"; "a/b/report.PDF" → ".pdf"; "png" → ".png"; "" → "".
 * A dotfile (".env") has no extension, like path.extname; a dotted bare
 * extension (".webp") is recognised only when the table knows it.
 */
export function extensionOf(value = "") {
  const text = String(value || "").trim();
  if (!text) return "";
  const base = text.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || "";
  const dot = base.lastIndexOf(".");
  if (dot > 0) return base.slice(dot).toLowerCase();
  if (dot === 0) return TABLE[base.toLowerCase()] ? base.toLowerCase() : "";
  // A bare extension name ("png") rather than a file name.
  return /^[a-z0-9]{1,12}$/i.test(base) ? `.${base.toLowerCase()}` : "";
}

export function kindOf(value = "") {
  return TABLE[extensionOf(value)]?.kind || "";
}

export function mimeOf(value = "", fallback = "application/octet-stream") {
  return TABLE[extensionOf(value)]?.mime || fallback;
}

export function hasKind(group, value = "") {
  const set = EXTENSIONS[group];
  if (!set) throw new Error(`unknown file-kind group: ${group}`);
  return set.has(extensionOf(value));
}

export const isImage = (value) => hasKind("image", value);
export const isBrowserImage = (value) => hasKind("browserImage", value);
export const isRasterImage = (value) => hasKind("rasterImage", value);
export const isVisionRaster = (value) => hasKind("visionRaster", value);
export const isVideo = (value) => hasKind("video", value);
export const isAudio = (value) => hasKind("audio", value);
export const isPdf = (value) => hasKind("pdf", value);
export const isOffice = (value) => hasKind("office", value);

/** Extensions without the dot, e.g. for a Set of bare names. */
export function bare(set) {
  return Object.freeze(new Set([...set].map((ext) => ext.slice(1))));
}

/** A regex alternation of bare extensions, e.g. "png|jpg|jpeg" — for the few regexes that match file names in prose. */
export function alternation(set) {
  return [...set].map((ext) => ext.slice(1).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
}

export const FILE_KIND_TABLE = Object.freeze(TABLE);
