"use strict";

function invalid() { throw Object.assign(new Error("Invalid task file manifest"), { code: "COLLAB_TASK_MANIFEST_INVALID" }); }
function fileKey(path) {
  if (typeof path !== "string" || !path || path.length > 1024 || path !== path.normalize("NFC")
    || path.includes("\\") || /[\x00-\x1f\x7f<>:"|?*]/.test(path) || path.startsWith("/")) invalid();
  const parts = path.split("/");
  if (parts.some((p) => !p || p === "." || p === ".." || /[. ]$/.test(p) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p))) invalid();
  return path.toLowerCase();
}
function manifestMap(files) {
  if (!Array.isArray(files) || files.length > 10000) invalid();
  const map = new Map();
  for (const file of files) {
    if (!file || Object.keys(file).some((k) => !["path", "sha256", "sizeBytes"].includes(k))
      || !/^[a-f0-9]{64}$/.test(file.sha256 || "") || !Number.isSafeInteger(file.sizeBytes) || file.sizeBytes < 0) invalid();
    const key = fileKey(file.path);
    if (map.has(key)) invalid();
    map.set(key, { ...file });
  }
  // A file cannot also be the parent directory of another file.
  for (const key of map.keys()) {
    const parts = key.split("/");
    for (let i = 1; i < parts.length; i++) if (map.has(parts.slice(0, i).join("/"))) invalid();
  }
  return map;
}
/** Produces a preview, never writes. Delivery is the COMPLETE proposed snapshot;
 *  omitted original files mean a requested deletion, which always needs consent.
 *  The filesystem broker must recheck hashes and symlinks at apply time. */
function planTaskApplication({ base, current, delivery, editablePaths }) {
  const original = manifestMap(base), local = manifestMap(current), proposed = manifestMap(delivery);
  if (!Array.isArray(editablePaths) || editablePaths.length > 10000) invalid();
  const editable = new Set(editablePaths.map(fileKey));
  if (editable.size !== editablePaths.length) invalid();
  const entries = [];
  for (const key of new Set([...original.keys(), ...proposed.keys()])) {
    const before = original.get(key), after = proposed.get(key), here = local.get(key);
    if (before?.sha256 === after?.sha256) continue;
    const operation = !before ? "add" : !after ? "delete" : "replace";
    let status;
    const hierarchyConflict = [...local.keys()].some((localKey) => localKey !== key
      && (key.startsWith(`${localKey}/`) || (after && localKey.startsWith(`${key}/`))));
    if (!editable.has(key)) status = "outside_scope";
    else if (hierarchyConflict) status = "conflict";
    else if ([before, after, here].filter(Boolean).some((f) => f.path !== (before || after).path)) status = "conflict";
    else if (here?.sha256 === after?.sha256) status = "already_applied";
    else if (here?.sha256 !== before?.sha256) status = "conflict";
    else status = operation === "delete" ? "confirmation_required" : "ready";
    entries.push({ path: (after || before).path, operation, status, expectedLocalHash: here?.sha256 || null, resultHash: after?.sha256 || null });
  }
  // New local files that were not in the shared snapshot are never removed.
  return { entries, canApply: entries.every((e) => ["ready", "already_applied"].includes(e.status)) };
}
module.exports = { manifestMap, planTaskApplication };
