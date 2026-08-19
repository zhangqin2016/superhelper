import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import JSZip from "jszip";
import { buildLegalKnowledgePack, packageLegalKnowledgePack } from "./build-legal-kb-pack.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "lily-legal-kb-release-"));
const source = new JSZip();
source.file("legal_kb_package\\laws_manifest.json", JSON.stringify({ version: "V23.3", content_version: "V23.3", generated: "2026-08-17", items: [{ title: "公司法", file: "法规库/公司法.md", category: "法律", verified: "FLK_A" }] }));
source.file("legal_kb_package\\法规库\\公司法.md", "## 第一条\n公司应当依法经营。\n");
const sourceBytes = await source.generateAsync({ type: "nodebuffer" });
const packDir = path.join(root, "pack");
await buildLegalKnowledgePack({ archiveBuffer: sourceBytes, outputDir: packDir });
const artifactPath = path.join(root, "legal-cn-enterprise-V23.3.zip");
const result = await packageLegalKnowledgePack({ packDir, outputFile: artifactPath });
assert.equal(result.ok, true);
assert.equal(result.sha256, crypto.createHash("sha256").update(fs.readFileSync(artifactPath)).digest("hex"));
const zip = await JSZip.loadAsync(fs.readFileSync(artifactPath));
assert.deepEqual(Object.keys(zip.files).sort(), ["articles.jsonl", "catalog.json", "lineage.json", "manifest.json"]);
assert.equal(Object.keys(zip.files).some((name) => /tools|\.js$|\.exe$/i.test(name)), false);

console.log("legal kb release manifest tests passed");
