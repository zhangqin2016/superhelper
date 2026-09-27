import crypto from "node:crypto";
import JSZip from "jszip";

/**
 * What a skill pack contains, independent of how it was zipped: every file's
 * path and bytes. Two packs with the same digest install the same skill even
 * when their archives differ in timestamps or entry metadata — the archive hash
 * alone once called twelve unchanged packs "changed" (0.1.189 release).
 */
export async function skillPackContentDigest(zipBuffer) {
  const zip = await JSZip.loadAsync(zipBuffer);
  const lines = [];
  for (const name of Object.keys(zip.files).sort()) {
    const entry = zip.files[name];
    if (entry.dir) continue;
    const bytes = await entry.async("nodebuffer");
    lines.push(`${name}\t${crypto.createHash("sha256").update(bytes).digest("hex")}`);
  }
  return crypto.createHash("sha256").update(lines.join("\n"), "utf8").digest("hex");
}
