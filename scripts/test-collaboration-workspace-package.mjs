#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import JSZip from "jszip";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  inspectCollaborationWorkspacePackage,
  extractCollaborationWorkspacePackage,
  publishOwnedStage,
} = require("../src/main/collaboration/workspace-package.js");

const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "lily-collab-workspace-package-")));
const manifest = { kind: "lily-workspace-pack", schemaVersion: 1, name: "Shared workspace" };

async function pack({ legacy = false } = {}) {
  const zip = new JSZip();
  zip.file(legacy ? "lily-workspace.json" : ".lilyspace/lily-workspace.json", JSON.stringify(manifest));
  zip.file(legacy ? "files/README.md" : "README.md", "hello");
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", platform: "UNIX" });
}

function uint16(value) { const out = Buffer.alloc(2); out.writeUInt16LE(value); return out; }
function uint32(value) { const out = Buffer.alloc(4); out.writeUInt32LE(value); return out; }
function storedDuplicateZip(names) {
  const locals = [], centrals = []; let offset = 0;
  for (const name of names) {
    const filename = Buffer.from(name, "utf8");
    const local = Buffer.concat([Buffer.from("504b0304", "hex"), uint16(20), uint16(0), uint16(0), uint16(0), uint16(0), uint32(0), uint32(0), uint32(0), uint16(filename.length), uint16(0), filename]);
    locals.push(local);
    centrals.push(Buffer.concat([Buffer.from("504b0102", "hex"), uint16(20), uint16(20), uint16(0), uint16(0), uint16(0), uint16(0), uint32(0), uint32(0), uint32(0), uint16(filename.length), uint16(0), uint16(0), uint16(0), uint16(0), uint32(0), uint32(offset), filename]));
    offset += local.length;
  }
  const central = Buffer.concat(centrals);
  return Buffer.concat([...locals, central, Buffer.from("504b050600000000", "hex"), uint16(names.length), uint16(names.length), uint32(central.length), uint32(offset), uint16(0)]);
}

function withForgedCentralUncompressedSize(bytes, entryName, size) {
  const forged = Buffer.from(bytes);
  let central = 0;
  while ((central = forged.indexOf(Buffer.from("504b0102", "hex"), central)) >= 0) {
    const nameLength = forged.readUInt16LE(central + 28);
    const name = forged.subarray(central + 46, central + 46 + nameLength).toString("utf8");
    if (name === entryName) {
      forged.writeUInt32LE(size, central + 24);
      return forged;
    }
    central += 46 + nameLength + forged.readUInt16LE(central + 30) + forged.readUInt16LE(central + 32);
  }
  assert.fail(`fixture is missing central entry ${entryName}`);
  return forged;
}

function withForgedCentralName(bytes, entryName, replacement) {
  const forged = Buffer.from(bytes);
  const replacementBytes = Buffer.from(replacement, "utf8");
  let central = 0;
  while ((central = forged.indexOf(Buffer.from("504b0102", "hex"), central)) >= 0) {
    const nameLength = forged.readUInt16LE(central + 28);
    const nameStart = central + 46;
    const name = forged.subarray(nameStart, nameStart + nameLength).toString("utf8");
    if (name === entryName) {
      assert.equal(replacementBytes.length, nameLength, "central-name forgery fixture preserves header offsets");
      replacementBytes.copy(forged, nameStart);
      return forged;
    }
    central += 46 + nameLength + forged.readUInt16LE(central + 30) + forged.readUInt16LE(central + 32);
  }
  assert.fail(`fixture is missing central entry ${entryName}`);
  return forged;
}

function withCorruptLocalContent(bytes) {
  const forged = Buffer.from(bytes);
  const local = forged.indexOf(Buffer.from("504b0304", "hex"));
  assert.ok(local >= 0, "fixture has a ZIP local header");
  const contentOffset = local + 30 + forged.readUInt16LE(local + 26) + forged.readUInt16LE(local + 28);
  forged[contentOffset] ^= 0x01;
  return forged;
}

function assertNoOwnedStage(targetDir) {
  const parent = path.dirname(targetDir);
  const prefix = `.${path.basename(targetDir)}.lily-stage-`;
  assert.equal(fs.readdirSync(parent).some((name) => name.startsWith(prefix)), false, "failed publish removes only its proven owned stage");
}

try {
  const root = await pack();
  const legacy = await pack({ legacy: true });
  for (const [name, bytes] of [["root", root], ["legacy", legacy]]) {
    const preview = await inspectCollaborationWorkspacePackage({ zipBuffer: bytes });
    assert.deepEqual(preview, { ok: true, name: "Shared workspace", layout: name, fileCount: 1, totalUncompressedBytes: 5, warnings: [] },
      `${name} layout returns only a safe summary`);
  }
  const mismatchedNames = new JSZip(); mismatchedNames.file(".lilyspace/lily-workspace.json", JSON.stringify(manifest)); mismatchedNames.file("one.txt", "one"); mismatchedNames.file("two.txt", "two");
  const mismatchedNameBytes = await mismatchedNames.generateAsync({ type: "nodebuffer" });
  for (const forgedName of ["one.txt", "../evil"]) {
    await assert.rejects(() => inspectCollaborationWorkspacePackage({ zipBuffer: withForgedCentralName(mismatchedNameBytes, "two.txt", forgedName) }), { code: "COLLAB_WORKSPACE_ENTRY_NAME_MISMATCH" },
      "a central-directory name cannot differ from the local header that JSZip would extract");
  }
  for (const schemaVersion of [0, -1, 2]) {
    const wrongSchema = new JSZip(); wrongSchema.file(".lilyspace/lily-workspace.json", JSON.stringify({ ...manifest, schemaVersion })); wrongSchema.file("README.md", "hello");
    const wrongSchemaBytes = await wrongSchema.generateAsync({ type: "nodebuffer" });
    await assert.rejects(() => inspectCollaborationWorkspacePackage({ zipBuffer: wrongSchemaBytes }), { code: "COLLAB_WORKSPACE_SCHEMA_UNSUPPORTED" },
      "strict collaboration import accepts exactly the supported schema version");
  }

  const firstTarget = path.join(dir, "import-one");
  const first = await extractCollaborationWorkspacePackage({ zipBuffer: root, targetDir: firstTarget });
  assert.deepEqual({ ...first, imported: undefined }, { ok: true, name: "Shared workspace", layout: "root", fileCount: 1, totalUncompressedBytes: 5, imported: undefined });
  assert.ok(first.imported && Array.isArray(first.imported.workspaceSkills) && Array.isArray(first.imported.automationTemplates), "isolated main-only result retains import metadata for later project/automation registration");
  assert.equal(fs.readFileSync(path.join(firstTarget, "README.md"), "utf8"), "hello");
  await assert.rejects(() => extractCollaborationWorkspacePackage({ zipBuffer: root, targetDir: firstTarget }), { code: "COLLAB_WORKSPACE_TARGET_EXISTS" },
    "same package never overwrites an existing workspace");
  const secondTarget = path.join(dir, "import-two");
  await extractCollaborationWorkspacePackage({ zipBuffer: root, targetDir: secondTarget });
  assert.equal(fs.readFileSync(path.join(secondTarget, "README.md"), "utf8"), "hello", "repeated package import succeeds only into a fresh target");

  const traversal = new JSZip();
  traversal.file(".lilyspace/lily-workspace.json", JSON.stringify(manifest));
  traversal.file("../escape.txt", "no");
  const traversalBytes = await traversal.generateAsync({ type: "nodebuffer" });
  await assert.rejects(() => inspectCollaborationWorkspacePackage({ zipBuffer: traversalBytes }), { code: "COLLAB_WORKSPACE_UNSAFE_PATH" },
    "original JSZip traversal names are rejected before any staging write");

  const symlink = new JSZip();
  symlink.file(".lilyspace/lily-workspace.json", JSON.stringify(manifest));
  symlink.file("link", "target", { unixPermissions: 0o120777 });
  const symlinkBytes = await symlink.generateAsync({ type: "nodebuffer", platform: "UNIX" });
  await assert.rejects(() => inspectCollaborationWorkspacePackage({ zipBuffer: symlinkBytes }), { code: "COLLAB_WORKSPACE_UNSAFE_ENTRY" },
    "symlink entries are rejected before staging");

  await assert.rejects(() => inspectCollaborationWorkspacePackage({ zipBuffer: storedDuplicateZip(["same.txt", "same.txt"]) }), { code: "COLLAB_WORKSPACE_DUPLICATE_ENTRY" },
    "duplicate original central-directory names are rejected before JSZip can merge them");
  await assert.rejects(() => inspectCollaborationWorkspacePackage({ zipBuffer: storedDuplicateZip(["Readme.md", "README.md"]) }), { code: "COLLAB_WORKSPACE_DUPLICATE_ENTRY" },
    "case-colliding names are rejected before a case-insensitive target can overwrite");
  for (const unsafeName of ["AUX.txt", "COM¹.txt", "notes:alternate-stream.txt", "trailing-dot.", "trailing-space "]) {
    const unsafe = new JSZip(); unsafe.file(".lilyspace/lily-workspace.json", JSON.stringify(manifest)); unsafe.file(unsafeName, "no");
    const unsafeBytes = await unsafe.generateAsync({ type: "nodebuffer" });
    await assert.rejects(() => inspectCollaborationWorkspacePackage({ zipBuffer: unsafeBytes }), { code: "COLLAB_WORKSPACE_UNSAFE_PATH" },
      `${unsafeName} cannot alias a Windows device or path on another supported desktop OS`);
  }
  const controlName = new JSZip(); controlName.file(".lilyspace/lily-workspace.json", JSON.stringify(manifest)); controlName.file("control\u0001name.txt", "no");
  const controlNameBytes = await controlName.generateAsync({ type: "nodebuffer" });
  await assert.rejects(() => inspectCollaborationWorkspacePackage({ zipBuffer: controlNameBytes }), { code: "COLLAB_WORKSPACE_UNSAFE_PATH" },
    "C0 control characters never reach a cross-platform target path");

  const tooMany = new JSZip();
  tooMany.file(".lilyspace/lily-workspace.json", JSON.stringify(manifest));
  tooMany.file("a.txt", "a"); tooMany.file("b.txt", "b");
  const tooManyBytes = await tooMany.generateAsync({ type: "nodebuffer" });
  await assert.rejects(() => inspectCollaborationWorkspacePackage({ zipBuffer: tooManyBytes, limits: { maxFiles: 1 } }), { code: "COLLAB_WORKSPACE_TOO_MANY_FILES" });
  const tooManyEntries = new JSZip(); tooManyEntries.file(".lilyspace/lily-workspace.json", JSON.stringify(manifest)); tooManyEntries.folder("nested").file("one.txt", "one");
  const tooManyEntryBytes = await tooManyEntries.generateAsync({ type: "nodebuffer" });
  await assert.rejects(() => inspectCollaborationWorkspacePackage({ zipBuffer: tooManyEntryBytes, limits: { maxArchiveEntries: 2 } }), { code: "COLLAB_WORKSPACE_TOO_MANY_FILES" },
    "directory records count toward the parser-bound archive-entry ceiling");
  await assert.rejects(() => inspectCollaborationWorkspacePackage({ zipBuffer: root, limits: { maxPackageBytes: root.length - 1 } }), { code: "COLLAB_WORKSPACE_PACK_TOO_LARGE" });
  await assert.rejects(() => inspectCollaborationWorkspacePackage({ zipBuffer: root, limits: { maxTotalBytes: 4 } }), { code: "COLLAB_WORKSPACE_UNCOMPRESSED_TOO_LARGE" },
    "compressed expansion is bounded from ZIP metadata before extraction");
  await assert.rejects(() => inspectCollaborationWorkspacePackage({ zipBuffer: root, limits: { maxFileBytes: 4 } }), { code: "COLLAB_WORKSPACE_FILE_TOO_LARGE" });
  const bomb = new JSZip(); bomb.file(".lilyspace/lily-workspace.json", JSON.stringify(manifest)); bomb.file("repeated.txt", "x".repeat(100000));
  const bombBytes = await bomb.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  await assert.rejects(() => inspectCollaborationWorkspacePackage({ zipBuffer: bombBytes }), { code: "COLLAB_WORKSPACE_COMPRESSION_BOMB" },
    "high-ratio compressed payloads are rejected before CRC/decompression staging");
  const forgedSize = new JSZip(); forgedSize.file(".lilyspace/lily-workspace.json", JSON.stringify(manifest)); forgedSize.file("actual-large.txt", "x".repeat(4096));
  const forgedSizeBytes = withForgedCentralUncompressedSize(await forgedSize.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }), "actual-large.txt", 1);
  await assert.rejects(() => inspectCollaborationWorkspacePackage({ zipBuffer: forgedSizeBytes, limits: { maxFileBytes: 1024 } }), { code: "COLLAB_WORKSPACE_FILE_TOO_LARGE" },
    "actual worker bytes, not a forged central-directory size, stop expansion before JSZip materializes the entry");
  await assert.rejects(() => inspectCollaborationWorkspacePackage({ zipBuffer: withCorruptLocalContent(root) }), { code: "COLLAB_WORKSPACE_PACKAGE_INVALID" },
    "a byte-corrupted ZIP is rejected by bounded worker CRC verification");

  const sensitive = new JSZip(); sensitive.file(".lilyspace/lily-workspace.json", JSON.stringify(manifest)); sensitive.file(".env", "TOKEN=not-a-real-secret");
  assert.deepEqual((await inspectCollaborationWorkspacePackage({ zipBuffer: await sensitive.generateAsync({ type: "nodebuffer" }) })).warnings, ["SENSITIVE_OR_EXCLUDED_ENTRY_PRESENT"],
    "preview warns about sensitive/excluded names but does not expose file paths");

  const mirrored = new JSZip(); mirrored.file(".lilyspace/lily-workspace.json", JSON.stringify(manifest)); mirrored.file("lily-workspace.json", JSON.stringify(manifest)); mirrored.file("README.md", "hello"); mirrored.file("files/README.md", "hello");
  assert.equal((await inspectCollaborationWorkspacePackage({ zipBuffer: await mirrored.generateAsync({ type: "nodebuffer" }), limits: { maxFiles: 1, maxArchiveEntries: 10 } })).fileCount, 1,
    "the 20k logical file limit does not reject a valid root/legacy compatibility mirror under its distinct raw-entry cap");

  const skillOnly = new JSZip(); skillOnly.file(".lilyspace/lily-workspace.json", JSON.stringify({ ...manifest, workspaceSkills: [{ id: "lily-demo" }] }));
  skillOnly.file(".lilyspace/skills/lily-demo/skill.manifest.json", JSON.stringify({ id: "lily-demo" })); skillOnly.file(".lilyspace/skills/lily-demo/SKILL.md", "# demo");
  const skillOnlyBytes = await skillOnly.generateAsync({ type: "nodebuffer" });
  await assert.rejects(() => inspectCollaborationWorkspacePackage({ zipBuffer: skillOnlyBytes, limits: { maxFiles: 1 } }), { code: "COLLAB_WORKSPACE_TOO_MANY_FILES" },
    "actual workspace-skill files count toward the strict final destination limit");
  assert.deepEqual((await inspectCollaborationWorkspacePackage({ zipBuffer: skillOnlyBytes })).fileCount, 2,
    "safe summaries report workspace-skill files that the isolated import really writes");
  const skillOnlyTarget = path.join(dir, "skill-only");
  const skillOnlyResult = await extractCollaborationWorkspacePackage({ zipBuffer: skillOnlyBytes, targetDir: skillOnlyTarget });
  assert.equal(skillOnlyResult.imported.workspaceSkills.length, 1, "skill-only legacy-compatible packs retain workspace-skill metadata without project registration");
  assert.equal(skillOnlyResult.imported.workspaceSkills[0].dir.startsWith(skillOnlyTarget), true,
    "published import metadata points at the atomically published target, never the removed stage directory");
  const mirroredSkill = new JSZip(); mirroredSkill.file(".lilyspace/lily-workspace.json", JSON.stringify({ ...manifest, workspaceSkills: [{ id: "lily-demo" }] }));
  for (const prefix of [".lilyspace/skills/", "skills/"]) {
    mirroredSkill.file(`${prefix}lily-demo/skill.manifest.json`, JSON.stringify({ id: "lily-demo" })); mirroredSkill.file(`${prefix}lily-demo/SKILL.md`, "# demo");
  }
  const mirroredSkillPreview = await inspectCollaborationWorkspacePackage({ zipBuffer: await mirroredSkill.generateAsync({ type: "nodebuffer" }), limits: { maxFiles: 2 } });
  assert.deepEqual({ fileCount: mirroredSkillPreview.fileCount, totalUncompressedBytes: mirroredSkillPreview.totalUncompressedBytes }, { fileCount: 2, totalUncompressedBytes: Buffer.byteLength(JSON.stringify({ id: "lily-demo" })) + Buffer.byteLength("# demo") },
    "hidden and legacy workspace-skill mirrors share one final-destination count and byte total");
  const conflictingMirroredSkill = new JSZip(); conflictingMirroredSkill.file(".lilyspace/lily-workspace.json", JSON.stringify({ ...manifest, workspaceSkills: [{ id: "lily-demo" }] }));
  for (const prefix of [".lilyspace/skills/", "skills/"]) conflictingMirroredSkill.file(`${prefix}lily-demo/skill.manifest.json`, JSON.stringify({ id: "lily-demo" }));
  conflictingMirroredSkill.file(".lilyspace/skills/lily-demo/SKILL.md", "plumless"); conflictingMirroredSkill.file("skills/lily-demo/SKILL.md", "buckeroo");
  const conflictingMirroredSkillBytes = await conflictingMirroredSkill.generateAsync({ type: "nodebuffer" });
  await assert.rejects(() => inspectCollaborationWorkspacePackage({ zipBuffer: conflictingMirroredSkillBytes }), { code: "COLLAB_WORKSPACE_DUPLICATE_ENTRY" },
    "same-size, CRC-colliding hidden/legacy skill content is not treated as an interchangeable mirror");
  const caseCollidingMirroredSkill = new JSZip(); caseCollidingMirroredSkill.file(".lilyspace/lily-workspace.json", JSON.stringify({ ...manifest, workspaceSkills: [{ id: "lily-demo" }] }));
  for (const prefix of [".lilyspace/skills/", "skills/"]) caseCollidingMirroredSkill.file(`${prefix}lily-demo/skill.manifest.json`, JSON.stringify({ id: "lily-demo" }));
  caseCollidingMirroredSkill.file(".lilyspace/skills/lily-demo/SKILL.md", "# hidden"); caseCollidingMirroredSkill.file("skills/lily-demo/skill.md", "# legacy");
  const caseCollidingMirroredSkillBytes = await caseCollidingMirroredSkill.generateAsync({ type: "nodebuffer" });
  await assert.rejects(() => inspectCollaborationWorkspacePackage({ zipBuffer: caseCollidingMirroredSkillBytes }), { code: "COLLAB_WORKSPACE_DUPLICATE_ENTRY" },
    "case-distinct archive names cannot overwrite one final workspace-skill destination on macOS or Windows");
  await assert.rejects(() => inspectCollaborationWorkspacePackage({ zipBuffer: Buffer.from("not a zip") }), { code: "COLLAB_WORKSPACE_PACKAGE_INVALID" });

  const existing = path.join(dir, "existing"); fs.mkdirSync(existing); fs.writeFileSync(path.join(existing, "keep.txt"), "keep");
  await assert.rejects(() => extractCollaborationWorkspacePackage({ zipBuffer: root, targetDir: existing }), { code: "COLLAB_WORKSPACE_TARGET_EXISTS" });
  assert.equal(fs.readFileSync(path.join(existing, "keep.txt"), "utf8"), "keep", "existing target remains untouched");

  const symlinkTarget = path.join(dir, "symlink-target");
  fs.symlinkSync(existing, symlinkTarget);
  await assert.rejects(() => extractCollaborationWorkspacePackage({ zipBuffer: root, targetDir: symlinkTarget }), { code: "COLLAB_WORKSPACE_TARGET_EXISTS" });
  assert.equal(fs.existsSync(path.join(existing, "README.md")), false, "target symlink is never followed");

  const stagedFailureTarget = path.join(dir, "failed-stage");
  await assert.rejects(() => extractCollaborationWorkspacePackage({ zipBuffer: root, targetDir: stagedFailureTarget, beforePublish() { throw Object.assign(new Error("stage fail"), { code: "COLLAB_WORKSPACE_STAGE_FAILED" }); } }),
    { code: "COLLAB_WORKSPACE_STAGE_FAILED" });
  assert.equal(fs.existsSync(stagedFailureTarget), false, "a staging failure leaves no half workspace at the destination");
  assertNoOwnedStage(stagedFailureTarget);

  const filledReservationTarget = path.join(dir, "filled-reservation");
  await assert.rejects(() => extractCollaborationWorkspacePackage({ zipBuffer: root, targetDir: filledReservationTarget, beforePublish() { fs.writeFileSync(path.join(filledReservationTarget, "keep.txt"), "external"); } }),
    { code: "COLLAB_WORKSPACE_TARGET_INVALID" });
  assert.equal(fs.readFileSync(path.join(filledReservationTarget, "keep.txt"), "utf8"), "external", "a foreign write into the reservation is never removed or overwritten");
  assertNoOwnedStage(filledReservationTarget);

  const externalTarget = path.join(dir, "external-target"); fs.mkdirSync(externalTarget); fs.writeFileSync(path.join(externalTarget, "keep.txt"), "external");
  const replacedTarget = path.join(dir, "replaced-reservation");
  await assert.rejects(() => extractCollaborationWorkspacePackage({ zipBuffer: root, targetDir: replacedTarget, beforePublish() { fs.rmdirSync(replacedTarget); fs.symlinkSync(externalTarget, replacedTarget); } }),
    { code: "COLLAB_WORKSPACE_TARGET_INVALID" });
  assert.equal(fs.lstatSync(replacedTarget).isSymbolicLink(), true, "a replacement symlink remains untouched after rejection");
  assert.equal(fs.readFileSync(path.join(externalTarget, "keep.txt"), "utf8"), "external", "a replacement symlink never exposes or changes external data");
  assertNoOwnedStage(replacedTarget);

  const windowsStage = path.join(dir, "windows-stage");
  const windowsTarget = path.join(dir, "windows-target");
  fs.mkdirSync(windowsStage); fs.mkdirSync(windowsTarget);
  let destinationWasAbsent = false;
  publishOwnedStage({ stage: windowsStage }, { target: windowsTarget }, {
    platform: "win32",
    fsOps: {
      rmdirSync: fs.rmdirSync.bind(fs),
      renameSync(source, destination) {
        destinationWasAbsent = !fs.existsSync(destination);
        if (!destinationWasAbsent) throw new Error("simulated MoveFileExW existing-directory refusal");
        fs.renameSync(source, destination);
      },
    },
  });
  assert.equal(destinationWasAbsent, true, "Windows publish removes only its proven empty reservation before rename");
  assert.equal(fs.existsSync(windowsTarget), true, "Windows-specific publish path still atomically makes the staged workspace visible");

  console.log("collaboration workspace package: strict preflight and isolated import passed");
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
