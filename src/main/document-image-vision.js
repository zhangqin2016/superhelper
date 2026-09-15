"use strict";

/**
 * Second opinion on the pictures inside a document.
 *
 * The extractor already OCRs embedded pictures, which recovers exact strings —
 * an invoice number, a total. OCR cannot say what a chart MEANS, so a document
 * whose argument lives in a figure still reached the model as a list of axis
 * labels. When a vision recognizer is configured, those pictures go through the
 * same bridge chat attachments use and the description is added BESIDE the OCR
 * text, never instead of it: OCR stays authoritative for characters, vision
 * explains the picture.
 *
 * Bounded and honest: a kill switch, a small cap, pictures that OCR could read
 * least go first (that is where a description adds the most), and the model is
 * told the description came from another model so it never claims to have
 * looked at the page itself.
 */

const fs = require("node:fs");
const { getLogger } = require("./logger");

const log = getLogger("document-image-vision");

const DEFAULT_MAX_IMAGES = 6;
// OCR text this long already describes the picture well enough that a
// description would mostly repeat it.
const RICH_OCR_CHARS = 400;

function maxImages() {
  const raw = Number(process.env.LILY_DOC_IMAGE_VISION_MAX);
  return Number.isSafeInteger(raw) && raw > 0 ? raw : DEFAULT_MAX_IMAGES;
}

function enabled() {
  return process.env.LILY_DOC_IMAGE_VISION !== "0";
}

/** Pictures OCR could read least, first — a description adds the most there. */
function prioritize(images) {
  return [...images]
    .filter((item) => item && Number.isSafeInteger(item.index) && typeof item.path === "string" && item.path)
    .filter((item) => {
      try { return fs.statSync(item.path).isFile(); } catch { return false; }
    })
    .sort((a, b) => String(a.text || "").length - String(b.text || "").length)
    .slice(0, maxImages());
}

/** Insert the description right after that picture's own marker line. */
function spliceDescription(text, index, description) {
  const lines = String(text).split("\n");
  const marker = new RegExp(`^\\[Image ${index}[\\]:]`);
  const at = lines.findIndex((line) => marker.test(line));
  if (at < 0) return text;
  // The OCR block may run several lines; the description belongs after all of
  // them, before the next marker or blank separator.
  let end = at + 1;
  while (end < lines.length && lines[end].trim() && !/^\[Image /.test(lines[end])) end += 1;
  lines.splice(end, 0, `[Image ${index} described] ${description}`);
  return lines.join("\n");
}

const PROVENANCE = "[Images: the \"described\" lines come from a separate image-recognition model, not from your own reading of the document.]";

/**
 * @param {{ text: string, images: Array<{index:number,path:string,text?:string}>, userText?: string }} input
 * @returns {Promise<{ text: string, described: number, attempted: number, reason: string }>}
 */
async function describeDocumentImages(input = {}) {
  const text = String(input.text || "");
  const images = Array.isArray(input.images) ? input.images : [];
  if (!text || !images.length) return { text, described: 0, attempted: 0, reason: "no_images" };
  if (!enabled()) return { text, described: 0, attempted: 0, reason: "disabled" };

  const vision = require("./vision-translator");
  if (!vision.hasVisionApiKey?.()) return { text, described: 0, attempted: 0, reason: "no_key" };

  const selected = prioritize(images);
  if (!selected.length) return { text, described: 0, attempted: 0, reason: "no_readable_files" };

  const { bridgeImagesConcurrently, bridgeConcurrency } = require("./vision-bridge-runner");
  // A tuning knob must never decide whether the feature runs: settings live
  // under userData, which is not bound in every host, and letting that read
  // throw silently disabled every description.
  let concurrency;
  try {
    concurrency = bridgeConcurrency(require("./agent-settings").resolveSettingsEnvValue("VISION_CONCURRENCY"));
  } catch {
    concurrency = bridgeConcurrency();
  }
  const files = selected.map((item) => ({ path: item.path, name: `image-${item.index}.png`, index: item.index }));
  // Reuse the same mode inference as chat images: a chart inside a bug report
  // should be read the way a pasted bug screenshot is.
  const prompt = vision.buildVisionPrompt({
    userText: input.userText,
    mode: vision.inferVisionMode(input.userText, files),
  });

  let bridged = [];
  try {
    bridged = await bridgeImagesConcurrently(
      files,
      {
        translate: (file) => vision.translateImage(file.path, prompt),
        isReadable: vision.normalizeVisionContent,
        concurrency,
      },
    );
  } catch (err) {
    // A bridge outage must never cost the document its OCR text.
    log.warn("document image description failed: %s", err?.message || err);
    return { text, described: 0, attempted: selected.length, reason: "bridge_failed" };
  }

  let out = text;
  let described = 0;
  for (const slot of bridged) {
    if (!slot?.ok) continue;
    const description = String(slot.text || "").trim();
    const index = slot.file?.index;
    if (!description || !Number.isSafeInteger(index)) continue;
    const next = spliceDescription(out, index, description);
    if (next !== out) { out = next; described += 1; }
  }
  if (!described) return { text, described: 0, attempted: selected.length, reason: "none_described" };
  return { text: `${out}\n\n${PROVENANCE}`, described, attempted: selected.length, reason: "ok" };
}

module.exports = { describeDocumentImages, spliceDescription, prioritize };
