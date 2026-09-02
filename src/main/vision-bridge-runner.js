"use strict";

const path = require("node:path");

const DEFAULT_CONCURRENCY = 3;
const MAX_CONCURRENCY = 6;

/**
 * Run the per-image bridge calls CONCURRENTLY, bounded.
 *
 * Each image is a full model call and this used to be a strictly serial loop, so
 * N images cost N round trips — the measured cause of image questions averaging
 * 30s and reaching 71s. Concurrency is capped (the same gateway also answers
 * "Server Overloaded" under load) and results are keyed BY INDEX so the
 * recognition order the answering model sees is identical to the serial version.
 * One image failing never affects the others.
 *
 * Pure orchestration: `translate` and the readability predicate are injected, so
 * this has no dependency on the vision transport and is testable without network.
 */
function bridgeConcurrency(value) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n) || n < 1) return DEFAULT_CONCURRENCY;
  return Math.min(n, MAX_CONCURRENCY);
}

async function bridgeImagesConcurrently(imageFiles, { translate, isReadable, onProgress, concurrency = DEFAULT_CONCURRENCY } = {}) {
  const files = Array.isArray(imageFiles) ? imageFiles : [];
  const slots = new Array(files.length);
  const lanes = Math.max(1, Math.min(Number(concurrency) || 1, files.length));
  const notify = (event) => {
    try { onProgress?.(event); } catch { /* progress is observability only */ }
  };
  let cursor = 0;
  let completed = 0;
  const worker = async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= files.length) return;
      const file = files[index];
      const label = file?.name || path.basename(file?.path || "");
      notify({ phase: "image-started", label, total: files.length, processed: completed });
      try {
        const desc = await translate(file);
        if (typeof isReadable === "function" ? !isReadable(desc) : !String(desc || "").trim()) {
          throw new Error("Vision API returned no readable image content");
        }
        slots[index] = { ok: true, label, text: `[Image recognition result: "${label}"]\n${desc}` };
      } catch (err) {
        const detail = String(err?.message || "VISION_FAILED").slice(0, 240);
        console.warn(`Vision translation failed for ${file?.name || file?.path}:`, err?.message);
        slots[index] = { ok: false, label, file, detail, text: `[Image: ${label}]` };
      }
      completed += 1;
      notify({
        phase: slots[index].ok ? "image-recognized" : "image-failed",
        label,
        total: files.length,
        processed: completed,
        ...(slots[index].ok ? {} : { error: slots[index].detail }),
      });
    }
  };
  await Promise.all(Array.from({ length: lanes }, worker));
  return slots.filter(Boolean);
}

module.exports = {
  DEFAULT_CONCURRENCY,
  MAX_CONCURRENCY,
  bridgeConcurrency,
  bridgeImagesConcurrently,
};
