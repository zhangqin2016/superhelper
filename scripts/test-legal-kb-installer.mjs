import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import JSZip from "jszip";
import { installLegalKnowledgePack, readLegalKnowledgePackState } from "../src/main/legal-kb/legal-kb-installer.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "lily-legal-kb-installer-"));
const pack = new JSZip();
pack.file("manifest.json", JSON.stringify({ schemaVersion: 1, packId: "legal-cn-enterprise", contentVersion: "V23.3", articleCount: 1, documentCount: 1 }));
pack.file("catalog.json", "[]");
pack.file("articles.jsonl", `${JSON.stringify({ id: "a", title: "合同法", article: "第一条", text: "依法订立合同" })}\n`);
pack.file("lineage.json", JSON.stringify({ lineage: [] }));
const bytes = await pack.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");

const serviceClient = {
  async legalKnowledgePackArtifact() {
    return { ok: true, json: { artifact: {
      packId: "legal-cn-enterprise", characterId: "lily-cn-legal-counsel", version: "V23.3",
      url: "https://qny.example/legal-kb/V23.3.zip", sha256, sizeBytes: bytes.length, format: "zip", schemaVersion: 1,
    } } };
  },
};
const downloadArtifact = async ({ partPath }) => {
  fs.mkdirSync(path.dirname(partPath), { recursive: true });
  fs.writeFileSync(partPath, bytes);
  return { ok: true, path: partPath, writtenBytes: bytes.length };
};

const first = await installLegalKnowledgePack({ rootDir: root, serviceClient, downloadArtifact });
assert.equal(first.ok, true);
assert.equal(first.version, "V23.3");
assert.equal(fs.existsSync(path.join(first.path, "articles.jsonl")), true);
assert.equal(readLegalKnowledgePackState(root).installed["legal-cn-enterprise"].version, "V23.3");

const skipped = await installLegalKnowledgePack({ rootDir: root, serviceClient, downloadArtifact });
assert.equal(skipped.skipped, true);

const bad = await installLegalKnowledgePack({
  rootDir: root,
  serviceClient: { legalKnowledgePackArtifact: async () => ({ ok: true, json: { artifact: {
    packId: "legal-cn-enterprise", characterId: "lily-cn-legal-counsel", version: "V23.4",
    url: "https://qny.example/legal-kb/V23.4.zip", sha256: "0".repeat(64), sizeBytes: bytes.length, format: "zip", schemaVersion: 1,
  } } }) },
  downloadArtifact,
});
assert.equal(bad.ok, false);
assert.equal(bad.error, "CHECKSUM_MISMATCH");
assert.equal(fs.existsSync(path.join(root, "legal-cn-enterprise", "V23.3", "articles.jsonl")), true);

console.log("legal kb installer tests passed");
