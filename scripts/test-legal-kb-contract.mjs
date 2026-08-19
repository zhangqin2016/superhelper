import assert from "node:assert/strict";
import {
  LEGAL_KB_SCHEMA_VERSION,
  normalizeArchivePath,
  validateLegalPackManifest,
  isIgnoredSourcePath,
} from "../src/main/legal-kb/legal-kb-contract.js";

assert.equal(LEGAL_KB_SCHEMA_VERSION, 1);
assert.equal(normalizeArchivePath("legal_kb_package\\法规库\\公司法.md"), "legal_kb_package/法规库/公司法.md");
assert.equal(normalizeArchivePath("./legal_kb_package/法规库/公司法.md"), "legal_kb_package/法规库/公司法.md");
assert.throws(() => normalizeArchivePath("../outside.md"), /PATH_TRAVERSAL/);
assert.throws(() => normalizeArchivePath("/absolute.md"), /ABSOLUTE_PATH/);
assert.throws(() => normalizeArchivePath("C:\\outside.md"), /ABSOLUTE_PATH/);
assert.equal(isIgnoredSourcePath("legal_kb_package/tools/law_query.cjs"), true);
assert.equal(isIgnoredSourcePath("legal_kb_package/output/vector_search.js"), true);
assert.equal(isIgnoredSourcePath("legal_kb_package/法规库/公司法.md"), false);

const valid = validateLegalPackManifest({
  packId: "legal-cn-enterprise",
  contentVersion: "V23.3",
  schemaVersion: 1,
  sourceVersion: "V23.3",
  articleCount: 2,
  documentCount: 1,
});
assert.equal(valid.ok, true);
assert.equal(valid.manifest.packId, "legal-cn-enterprise");

assert.equal(validateLegalPackManifest({ ...valid.manifest, packId: "bad id" }).ok, false);
assert.equal(validateLegalPackManifest({ ...valid.manifest, contentVersion: "" }).ok, false);
assert.equal(validateLegalPackManifest({ ...valid.manifest, schemaVersion: 2 }).ok, false);
assert.equal(validateLegalPackManifest({ ...valid.manifest, sha256: "nope" }).ok, false);

console.log("legal kb contract tests passed");
