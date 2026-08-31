"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const ZipEntries = require("jszip/lib/zipEntries");
const utf8 = require("jszip/lib/utf8");
const Crc32Probe = require("jszip/lib/stream/Crc32Probe");
const { MAX_FILE_BYTES, MAX_IMPORT_FILES, isExcluded, readPackManifest, selectImportEntries, selectImportWorkspaceSkillEntries, importWorkspacePack } = require("../workspace-share");

const DEFAULT_LIMITS = Object.freeze({ maxPackageBytes: 256 * 1024 * 1024, maxTotalBytes: 512 * 1024 * 1024, maxFiles: 20000, maxArchiveEntries: MAX_IMPORT_FILES, maxFileBytes: MAX_FILE_BYTES, maxCompressionRatio: 100 });
const fail = (code) => Object.assign(new Error(code), { code, retryable: false });
const sameFile = (left, right) => left.dev === right.dev && left.ino === right.ino;

function bounded(value, fallback) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1 || value > fallback) throw fail("COLLAB_WORKSPACE_LIMIT_INVALID");
  return value;
}

function limitsFor(input = {}) {
  return {
    maxPackageBytes: bounded(input.maxPackageBytes, DEFAULT_LIMITS.maxPackageBytes),
    maxTotalBytes: bounded(input.maxTotalBytes, DEFAULT_LIMITS.maxTotalBytes),
    maxFiles: bounded(input.maxFiles, DEFAULT_LIMITS.maxFiles),
    maxArchiveEntries: bounded(input.maxArchiveEntries, DEFAULT_LIMITS.maxArchiveEntries),
    maxFileBytes: bounded(input.maxFileBytes, DEFAULT_LIMITS.maxFileBytes),
    maxCompressionRatio: bounded(input.maxCompressionRatio, DEFAULT_LIMITS.maxCompressionRatio),
  };
}

// JSZip itself remains the only ZIP parser/decompressor. Its v3.10.1 central
// directory reader appends entries to an instance-owned `files` array without
// enforcing the EOCD count. Bound that exact per-instance append path before
// parsing, and reject ZIP64 at its first extension callback (strict packs are
// capped below 256 MiB) rather than parsing extension metadata at all.
function readCentralNameBytes(entries) {
  const reader = entries.reader;
  const previousIndex = reader.index;
  try {
    reader.setIndex(entries.centralDirOffset);
    return entries.files.map(() => {
      if (reader.readString(4) !== "PK\x01\x02") throw fail("COLLAB_WORKSPACE_PACKAGE_INVALID");
      reader.skip(24);
      const fileNameLength = reader.readInt(2);
      const extraLength = reader.readInt(2);
      const commentLength = reader.readInt(2);
      reader.skip(12);
      const fileName = Buffer.from(reader.readData(fileNameLength));
      reader.skip(extraLength + commentLength);
      return fileName;
    });
  } finally {
    reader.setIndex(previousIndex);
  }
}

function originalEntries(zipBuffer, limits) {
  try {
    const entries = new ZipEntries({ decodeFileName: utf8.utf8decode });
    const files = entries.files;
    const push = files.push.bind(files);
    files.push = (...items) => {
      if (files.length + items.length > limits.maxArchiveEntries) throw fail("COLLAB_WORKSPACE_TOO_MANY_FILES");
      return push(...items);
    };
    entries.readBlockZip64EndOfCentral = () => { throw fail("COLLAB_WORKSPACE_PACKAGE_INVALID"); };
    const readEnd = entries.readEndOfCentral.bind(entries);
    entries.readEndOfCentral = () => {
      readEnd();
      if (entries.zip64 || entries.diskNumber !== 0 || entries.diskWithCentralDirStart !== 0
        || entries.centralDirRecordsOnThisDisk !== entries.centralDirRecords) {
        throw fail("COLLAB_WORKSPACE_PACKAGE_INVALID");
      }
      if (entries.centralDirRecords > limits.maxArchiveEntries) throw fail("COLLAB_WORKSPACE_TOO_MANY_FILES");
    };
    const readLocalFiles = entries.readLocalFiles.bind(entries);
    entries.readLocalFiles = () => {
      // ZipEntries replaces fileName with the local-header value before it
      // returns. Read its already parsed central records first so a benign
      // central directory cannot disguise a different extraction name.
      const centralNames = readCentralNameBytes(entries);
      readLocalFiles();
      for (let index = 0; index < entries.files.length; index += 1) {
        if (!Buffer.from(entries.files[index].fileName).equals(centralNames[index])) {
          throw fail("COLLAB_WORKSPACE_ENTRY_NAME_MISMATCH");
        }
      }
    };
    entries.load(zipBuffer);
    return entries.files;
  } catch (error) { throw error?.code ? error : fail("COLLAB_WORKSPACE_PACKAGE_INVALID"); }
}

function normalizedEntryName(value) {
  const raw = String(value || "");
  const directory = raw.endsWith("/");
  const name = directory ? raw.slice(0, -1) : raw;
  if (!name || name.length > 4096 || /[\u0000-\u001f\u007f]/.test(name) || name.includes("\\") || name.startsWith("/") || /^[A-Za-z]:/.test(name)) throw fail("COLLAB_WORKSPACE_UNSAFE_PATH");
  const parts = name.split("/");
  if (parts.some((part) => {
    const device = part.split(".")[0].toUpperCase();
    return !part || part === "." || part === ".." || part.endsWith(".") || part.endsWith(" ")
      || /[:<>"|?*]/.test(part) || /^(CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])$/.test(device);
  })) throw fail("COLLAB_WORKSPACE_UNSAFE_PATH");
  return { raw, name, directory };
}

function isSymlink(entry) {
  const permissions = Number(entry?.unixPermissions);
  return Number.isFinite(permissions) && (permissions & 0o170000) === 0o120000;
}

function validateArchiveEntries(zipBuffer, limits) {
  const entries = originalEntries(zipBuffer, limits);
  const names = new Set(), caseNames = new Set();
  let archiveFileCount = 0, totalBytes = 0;
  for (const entry of entries) {
    const { name, directory } = normalizedEntryName(entry.fileNameStr);
    const caseName = name.normalize("NFC").toLocaleLowerCase("en-US");
    if (names.has(name) || caseNames.has(caseName)) throw fail("COLLAB_WORKSPACE_DUPLICATE_ENTRY");
    names.add(name); caseNames.add(caseName);
    if (isSymlink(entry)) throw fail("COLLAB_WORKSPACE_UNSAFE_ENTRY");
    if (directory || entry.dir) continue;
    const uncompressed = Number(entry?.decompressed?.uncompressedSize);
    const compressed = Number(entry?.decompressed?.compressedSize);
    if (!Number.isSafeInteger(uncompressed) || uncompressed < 0 || !Number.isSafeInteger(compressed) || compressed < 0) throw fail("COLLAB_WORKSPACE_PACKAGE_INVALID");
    if (uncompressed > limits.maxFileBytes) throw fail("COLLAB_WORKSPACE_FILE_TOO_LARGE");
    if (uncompressed > 0 && (compressed === 0 || uncompressed > compressed * limits.maxCompressionRatio)) throw fail("COLLAB_WORKSPACE_COMPRESSION_BOMB");
    archiveFileCount += 1;
    totalBytes += uncompressed;
    if (!Number.isSafeInteger(totalBytes) || totalBytes > limits.maxTotalBytes) throw fail("COLLAB_WORKSPACE_UNCOMPRESSED_TOO_LARGE");
  }
  return { archiveFileCount, totalBytes, entries };
}

// `checkCRC32` is intentionally not the first decompression pass.  JSZip's
// central-directory sizes are attacker controlled, and its stock CRC checker
// finishes collecting a whole entry before it observes a bad declared size.
// Consume the same JSZip worker one entry at a time instead: no file contents
// are retained, and a real expanded byte count trips the ceiling immediately.
function verifyExpandedEntry(entry, limits, shared) {
  return new Promise((resolve, reject) => {
    const worker = entry.decompressed.getContentWorker().pipe(new Crc32Probe());
    const digest = crypto.createHash("sha256");
    let entryBytes = 0;
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      if (error) reject(error?.code ? error : fail("COLLAB_WORKSPACE_PACKAGE_INVALID"));
      else resolve();
    };
    worker.on("data", (chunk) => {
      const bytes = Number(chunk?.data?.length);
      if (!Number.isSafeInteger(bytes) || bytes < 0) {
        worker.pause();
        finish(fail("COLLAB_WORKSPACE_PACKAGE_INVALID"));
        return;
      }
      entryBytes += bytes;
      shared.totalBytes += bytes;
      digest.update(chunk.data);
      if (entryBytes > limits.maxFileBytes) {
        worker.pause();
        finish(fail("COLLAB_WORKSPACE_FILE_TOO_LARGE"));
      } else if (!Number.isSafeInteger(shared.totalBytes) || shared.totalBytes > limits.maxTotalBytes) {
        worker.pause();
        finish(fail("COLLAB_WORKSPACE_UNCOMPRESSED_TOO_LARGE"));
      }
    }).on("error", finish).on("end", () => {
      if (entryBytes !== Number(entry.decompressed.uncompressedSize)
        || worker.streamInfo.crc32 !== entry.decompressed.crc32) {
        finish(fail("COLLAB_WORKSPACE_PACKAGE_INVALID"));
        return;
      }
      // Internal-only preflight evidence: it never enters the summary, IPC,
      // or extracted package metadata. It distinguishes mirror contents even
      // when size and CRC32 collide.
      entry._collaborationContentSha256 = digest.digest("hex");
      finish();
    }).resume();
  });
}

async function verifyExpandedEntries(entries, limits) {
  const shared = { totalBytes: 0 };
  const digestsByArchiveName = new Map();
  for (const entry of entries) {
    if (entry.dir) continue;
    await verifyExpandedEntry(entry, limits, shared);
    digestsByArchiveName.set(entry.fileNameStr, entry._collaborationContentSha256);
  }
  return digestsByArchiveName;
}

function attachValidatedDigests(items, digestsByArchiveName) {
  for (const { entry } of items) {
    const digest = digestsByArchiveName.get(entry.unsafeOriginalName || entry.name);
    if (typeof digest !== "string") throw fail("COLLAB_WORKSPACE_PACKAGE_INVALID");
    entry._collaborationContentSha256 = digest;
  }
  return items;
}

function sameEntryContent(left, right) {
  return typeof left?._collaborationContentSha256 === "string"
    && left._collaborationContentSha256 === right?._collaborationContentSha256;
}

function selectFinalEntries(payloadEntries, skillEntries) {
  const byDestination = new Map();
  const byPortableDestination = new Map();
  const add = (item, kind) => {
    normalizedEntryName(item.rel);
    const portableDestination = item.rel.normalize("NFC").toLocaleLowerCase("en-US");
    const existing = byDestination.get(item.rel);
    if (!existing) {
      const portableExisting = byPortableDestination.get(portableDestination);
      if (portableExisting) throw fail("COLLAB_WORKSPACE_DUPLICATE_ENTRY");
      byDestination.set(item.rel, { ...item, kind });
      byPortableDestination.set(portableDestination, item.rel);
      return;
    }
    // A root/legacy skill mirror reaches the same final target. It must carry
    // the same archived content; otherwise strict import refuses ambiguity.
    if (kind === "skill" && existing.kind === "skill" && sameEntryContent(existing.entry, item.entry)) return;
    throw fail("COLLAB_WORKSPACE_DUPLICATE_ENTRY");
  };
  for (const item of payloadEntries) add(item, "payload");
  for (const item of skillEntries) {
    add({ ...item, rel: `.lily-work/imported-skills/${item.skillId}/${item.rel}` }, "skill");
  }
  return [...byDestination.values()];
}

function safeSummary(manifest, layout, finalEntries, payloadEntries) {
  const warnings = [];
  if (payloadEntries.some(({ rel }) => isExcluded(rel))) warnings.push("SENSITIVE_OR_EXCLUDED_ENTRY_PRESENT");
  return Object.freeze({ ok: true, name: String(manifest?.name || manifest?.appId || "Shared workspace").slice(0, 200), layout,
    fileCount: finalEntries.length, totalUncompressedBytes: finalEntries.reduce((total, { entry }) => total + Number(entry?._data?.uncompressedSize || 0), 0), warnings });
}

async function preflight(zipBuffer, options = {}) {
  if (!Buffer.isBuffer(zipBuffer) || zipBuffer.length === 0) throw fail("COLLAB_WORKSPACE_PACKAGE_INVALID");
  const limits = limitsFor(options.limits || {});
  if (zipBuffer.length > limits.maxPackageBytes) throw fail("COLLAB_WORKSPACE_PACK_TOO_LARGE");
  const archive = validateArchiveEntries(zipBuffer, limits);
  const digestsByArchiveName = await verifyExpandedEntries(archive.entries, limits);
  let parsed;
  // CRC and actual-size validation above is bounded and sequential. Do not ask
  // JSZip to run its unbounded all-entry CRC pass again while loading metadata.
  try { parsed = await readPackManifest(zipBuffer); }
  catch (error) {
    if (error?.message === "PACK_TOO_NEW") throw fail("COLLAB_WORKSPACE_SCHEMA_UNSUPPORTED");
    throw fail("COLLAB_WORKSPACE_PACKAGE_INVALID");
  }
  if (parsed.manifest?.schemaVersion !== 1) throw fail("COLLAB_WORKSPACE_SCHEMA_UNSUPPORTED");
  const payloadEntries = attachValidatedDigests(selectImportEntries(parsed.zip, parsed.layout), digestsByArchiveName);
  const skillEntries = attachValidatedDigests(selectImportWorkspaceSkillEntries(parsed.zip, parsed.manifest), digestsByArchiveName);
  const finalEntries = selectFinalEntries(payloadEntries, skillEntries);
  if (!finalEntries.length) throw fail("COLLAB_WORKSPACE_PACKAGE_INVALID");
  if (finalEntries.length > limits.maxFiles) throw fail("COLLAB_WORKSPACE_TOO_MANY_FILES");
  return { ...parsed, payloadEntries, skillEntries, finalEntries, limits, summary: safeSummary(parsed.manifest, parsed.layout, finalEntries, payloadEntries) };
}

async function inspectCollaborationWorkspacePackage({ zipBuffer, limits } = {}) {
  return (await preflight(zipBuffer, { limits })).summary;
}

function checkedDirectory(value) {
  let current = path.parse(value).root;
  for (const part of value.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const stat = fs.lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw fail("COLLAB_WORKSPACE_TARGET_INVALID");
  }
  return fs.lstatSync(value);
}

function targetFor(value) {
  if (typeof value !== "string" || !path.isAbsolute(value) || path.resolve(value) !== value || path.basename(value) === "." || path.basename(value) === path.sep) throw fail("COLLAB_WORKSPACE_TARGET_INVALID");
  const parent = path.dirname(value);
  checkedDirectory(parent);
  try { fs.mkdirSync(value, { mode: 0o700 }); }
  catch (error) { if (error?.code === "EEXIST") throw fail("COLLAB_WORKSPACE_TARGET_EXISTS"); throw fail("COLLAB_WORKSPACE_TARGET_INVALID"); }
  return { parent, target: value, reservationIdentity: checkedDirectory(value) };
}

function ownedStage({ parent, target }) {
  const stage = path.join(parent, `.${path.basename(target)}.lily-stage-${crypto.randomUUID()}`);
  const parentIdentity = checkedDirectory(parent);
  fs.mkdirSync(stage, { mode: 0o700 });
  const identity = checkedDirectory(stage);
  if (!sameFile(parentIdentity, checkedDirectory(parent))) throw fail("COLLAB_WORKSPACE_TARGET_INVALID");
  return { stage, identity, parentIdentity };
}

function cleanupStage(stage) {
  try {
    if (fs.existsSync(stage.stage) && sameFile(stage.identity, checkedDirectory(stage.stage))) fs.rmSync(stage.stage, { recursive: true, force: false });
  } catch { /* a raced/untrusted stage is intentionally left in place */ }
}

function cleanupReservation(target) {
  try {
    if (fs.existsSync(target.target) && sameFile(target.reservationIdentity, checkedDirectory(target.target)) && fs.readdirSync(target.target).length === 0) fs.rmdirSync(target.target);
  } catch { /* an unproven reservation is intentionally left in place */ }
}

function publishOwnedStage(stage, target, { platform = process.platform, fsOps = fs } = {}) {
  // On Windows, Node's rename is MoveFileExW with REPLACE_EXISTING and refuses
  // an existing destination directory. The reservation has just been proven to
  // be our empty directory, so remove only that reservation before publishing.
  // If another same-user process races into the name, Windows rename fails
  // rather than replacing that directory; portable Node offers no stronger
  // directory-level no-replace primitive for the final syscall-sized window.
  if (platform === "win32") fsOps.rmdirSync(target.target);
  fsOps.renameSync(stage.stage, target.target);
}

function rebasePublishedImport(imported, stageRoot, targetRoot) {
  const stagePrefix = `${stageRoot}${path.sep}`;
  const rebase = (value) => typeof value === "string" && value.startsWith(stagePrefix)
    ? path.join(targetRoot, value.slice(stagePrefix.length))
    : value;
  return {
    ...imported,
    workspaceSkills: Array.isArray(imported.workspaceSkills)
      ? imported.workspaceSkills.map((skill) => ({ ...skill, dir: rebase(skill.dir) }))
      : [],
  };
}

async function extractCollaborationWorkspacePackage({ zipBuffer, targetDir, limits, beforePublish } = {}) {
  const prepared = await preflight(zipBuffer, { limits });
  const target = targetFor(targetDir);
  let stage;
  try {
    stage = ownedStage(target);
    const imported = await importWorkspacePack(zipBuffer, stage.stage, {
      // `importWorkspacePack` predates the strict wrapper and calls maxFiles
      // its raw archive-entry cap. Keep the 20k collaboration limit logical;
      // compatible root/legacy mirrors remain allowed up to maxArchiveEntries.
      maxFiles: prepared.limits.maxArchiveEntries,
      maxFileBytes: prepared.limits.maxFileBytes,
      maxTotalBytes: prepared.limits.maxTotalBytes,
    });
    if (typeof beforePublish === "function") await beforePublish();
    if (!sameFile(stage.identity, checkedDirectory(stage.stage)) || !sameFile(stage.parentIdentity, checkedDirectory(target.parent))
      || !sameFile(target.reservationIdentity, checkedDirectory(target.target)) || fs.readdirSync(target.target).length !== 0) throw fail("COLLAB_WORKSPACE_TARGET_INVALID");
    // Node has no portable rename-no-replace primitive for directories.  The
    // exclusive empty reservation prevents ordinary concurrent creators and
    // is identity-checked immediately before publish; a hostile same-user
    // process replacing it in that final syscall-sized window is outside what
    // portable Node can sandbox, as with the existing transfer staging code.
    publishOwnedStage(stage, target);
    const { warnings: _warnings, ...result } = prepared.summary;
    return { ...result, imported: rebasePublishedImport(imported, stage.stage, target.target) };
  } catch (error) {
    if (stage) cleanupStage(stage);
    cleanupReservation(target);
    throw error;
  }
}

module.exports = { DEFAULT_LIMITS, inspectCollaborationWorkspacePackage, extractCollaborationWorkspacePackage, publishOwnedStage };
