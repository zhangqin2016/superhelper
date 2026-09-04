#!/usr/bin/env node
/**
 * Guide blocks: environment applicability for the rules that ride every prompt.
 *
 * The mandatory guide bodies were one monolithic string per locale, so nothing
 * inside them could be conditional — Windows PowerShell rules shipped in every
 * prompt on macOS and Linux, where they cannot apply. A manifest can now split
 * its guide into `blocks` with an optional `appliesTo`.
 *
 * Rules are pushed, not pulled: a rule the model was never shown is a rule it
 * violates. So this asserts pruning happens ONLY where a block provably cannot
 * apply, that a Windows install is byte-for-byte unchanged, and that every
 * uncertain path keeps the block.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { resolveGuideBody, blockApplies, prunedBlockIds } = require("../src/main/agent-guide-blocks.js");

// --- 1. Blocks must reproduce the body they were split from ----------------
// This is the anti-drift ratchet. `body` stays in the manifest as the
// authoritative text and the fallback for every uncertain path, so blocks that
// no longer rejoin to it would ship subtly different rules.

const skillsDir = path.join(ROOT, "resources", "skills");
let manifestsWithBlocks = 0;
let conditionalBlocks = 0;

for (const entry of fs.readdirSync(skillsDir, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const manifestPath = path.join(skillsDir, entry.name, "skill.manifest.json");
  if (!fs.existsSync(manifestPath)) continue;
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const variants = [["guideMd", manifest.guideMd], ...Object.entries(manifest.guideMd_i18n || {})];
  for (const [label, guide] of variants) {
    if (!guide || !Array.isArray(guide.blocks)) continue;
    manifestsWithBlocks += 1;
    const where = `${entry.name} ${label}`;
    assert.equal(typeof guide.body, "string", `${where}: body must stay as the authoritative text and fallback`);
    const rejoined = guide.blocks.map((block) => block.body).join("\n\n");
    assert.equal(rejoined, guide.body, `${where}: blocks must rejoin to body exactly`);
    const ids = guide.blocks.map((block) => block.id);
    assert.equal(new Set(ids).size, ids.length, `${where}: block ids must be unique`);
    for (const id of ids) assert.ok(id, `${where}: every block needs an id`);
    conditionalBlocks += guide.blocks.filter((block) => block.appliesTo).length;
  }
}
assert.ok(manifestsWithBlocks > 0, "at least one manifest must declare guide blocks");
assert.ok(conditionalBlocks > 0, "at least one block must declare an applicability condition");

// --- 2. The real manifest, resolved per platform ---------------------------

const workbench = JSON.parse(
  fs.readFileSync(path.join(skillsDir, "lily-workbench-rules", "skill.manifest.json"), "utf8"),
);
const WINDOWS_HEADING = /^## (Windows Command Line|Windows 命令行)/m;

for (const [label, guide] of [["guideMd", workbench.guideMd], ...Object.entries(workbench.guideMd_i18n || {})]) {
  if (!guide || !Array.isArray(guide.blocks)) continue;
  const onWindows = resolveGuideBody(guide, { platform: "win32" });
  assert.equal(onWindows, guide.body, `${label}: a Windows install must get the unchanged body`);

  const onMac = resolveGuideBody(guide, { platform: "darwin" });
  assert.ok(onMac.length < guide.body.length, `${label}: macOS must drop the Windows rules`);
  assert.doesNotMatch(onMac, WINDOWS_HEADING, `${label}: the Windows section must be gone on macOS`);

  // Everything that is not the Windows block must survive, in order.
  const expected = guide.blocks
    .filter((block) => !block.appliesTo)
    .map((block) => block.body)
    .join("\n\n");
  assert.equal(onMac, expected, `${label}: macOS must drop the conditional block and nothing else`);
  assert.deepEqual(prunedBlockIds(guide, { platform: "darwin" }), ["windows-shell"], `${label}: pruning must be reported`);
  assert.deepEqual(prunedBlockIds(guide, { platform: "win32" }), [], `${label}: nothing is pruned on Windows`);

  // The trailer that sat after the Windows rules must not go with them.
  if (guide.body.includes("{{SKILL_DIR}}")) {
    assert.ok(onMac.includes("{{SKILL_DIR}}"), `${label}: the skill-directory trailer must outlive a pruned Windows block`);
  }
}

// --- 3. Every uncertain path keeps the rules -------------------------------

const body = "## A\n\n- one\n\n## B\n\n- two";
assert.equal(resolveGuideBody({ body }), body, "no blocks -> the body, unchanged");
assert.equal(resolveGuideBody({ body, blocks: [] }), body, "empty blocks -> the body, unchanged");
assert.equal(
  resolveGuideBody({ body, blocks: [{ id: "x", body: null }] }),
  body,
  "blocks with no usable text -> the body, unchanged",
);
assert.equal(
  resolveGuideBody({ body, blocks: [{ id: "only", appliesTo: { platform: "win32" }, body: "## A" }] }, { platform: "darwin" }),
  body,
  "a section that would prune to nothing falls back to the full body",
);
assert.equal(
  resolveGuideBody(
    { body, blocks: [{ id: "a", body: "## A" }, { id: "b", appliesTo: { someFutureKey: "v" }, body: "## B" }] },
    { platform: "darwin" },
  ),
  "## A\n\n## B",
  "an unrecognized condition key must keep the block, never delete a rule on a guess",
);
assert.equal(resolveGuideBody(null), "", "a missing guide resolves to nothing rather than throwing");

assert.equal(blockApplies({}, { platform: "darwin" }), true, "no condition -> applies");
assert.equal(blockApplies({ appliesTo: { platform: ["darwin", "linux"] } }, { platform: "linux" }), true, "list conditions match by membership");
assert.equal(blockApplies({ appliesTo: { platform: ["darwin", "linux"] } }, { platform: "win32" }), false, "list conditions exclude non-members");

// --- 4. The assembled guide ------------------------------------------------

const userData = path.join(ROOT, "..", ".lily-guide-blocks-fixture");
fs.mkdirSync(userData, { recursive: true });
process.env.LILY_USER_DATA_DIR ||= userData;
process.env.LILY_HOME ||= userData;
process.on("exit", () => fs.rmSync(userData, { recursive: true, force: true }));

const skillManager = require("../src/main/skill-manager.js");
const enabled = [{ id: "lily-workbench-rules", skillDir: path.join(skillsDir, "lily-workbench-rules"), manifest: workbench }];
for (const locale of ["zh-CN", "en"]) {
  const guide = skillManager.buildAgentGuideContent(enabled, locale);
  // This process runs on the host platform; assert against what that implies
  // rather than pretending to be another OS.
  if (process.platform === "win32") {
    assert.match(guide, WINDOWS_HEADING, `${locale}: a Windows host keeps the Windows rules`);
  } else {
    assert.doesNotMatch(guide, WINDOWS_HEADING, `${locale}: a non-Windows host must not carry Windows shell rules`);
    assert.match(guide, /General Product Experience|通用产品体验底线/, `${locale}: the unconditional rules must remain`);
  }
}

console.log("agent guide blocks: ok");
console.log(`  ${manifestsWithBlocks} guide variants use blocks, ${conditionalBlocks} conditional`);
console.log(`  host platform ${process.platform}: Windows shell rules ${process.platform === "win32" ? "kept" : "pruned"}`);
